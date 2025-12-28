// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";

const router = express.Router();

const ADMIN_SECRET = (process.env.BOOKING_ADMIN_SECRET || "").trim();

function pbkdf2Hash(password) {
  const pw = String(password || "");
  const saltBuf = crypto.randomBytes(16);
  const hashBuf = crypto.pbkdf2Sync(pw, saltBuf, 120000, 32, "sha256");
  return { salt_hex: saltBuf.toString("hex"), hash_hex: hashBuf.toString("hex") };
}

function pbkdf2Verify(password, saltHex, hashHex) {
  try {
    const pw = String(password || "");
    const saltBuf = Buffer.from(String(saltHex || ""), "hex");
    const test = crypto.pbkdf2Sync(pw, saltBuf, 120000, 32, "sha256").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(String(hashHex || ""), "hex"));
  } catch {
    return false;
  }
}

function requirePlatformAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ ok: false, error: "BOOKING_ADMIN_SECRET not set" });
  }
  const token = String(req.cookies?.tr_book_admin || "");
  if (token !== "1") {
    return res.status(401).json({ ok: false, error: "not_authorized" });
  }
  return next();
}

async function ensureBookingTables() {
  // courses
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_courses (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // course admins (course-scoped users)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_users (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      salt_hex TEXT NOT NULL,
      hash_hex TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(course_id, email)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_course_users_email_idx
    ON booking_course_users(email);
  `);
}

// kick table creation (safe to call multiple times)
ensureBookingTables().catch((e) => console.error("❌ ensureBookingTables error", e));

/**
 * PLATFORM ADMIN LOGIN
 * POST /api/book/admin/login { secret }
 */
router.post("/admin/login", async (req, res) => {
  try {
    if (!ADMIN_SECRET) {
      return res.status(500).json({ ok: false, error: "BOOKING_ADMIN_SECRET not set" });
    }
    const secret = String(req.body?.secret || "").trim();
    if (!secret || secret !== ADMIN_SECRET) {
      return res.status(401).json({ ok: false, error: "invalid_secret" });
    }

    // simple httpOnly cookie
    res.cookie("tr_book_admin", "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: true, // Render/production https
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: "/",
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("/admin/login error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/**
 * PLATFORM ADMIN LOGOUT
 */
router.post("/admin/logout", (req, res) => {
  res.clearCookie("tr_book_admin", { path: "/" });
  res.json({ ok: true });
});

/**
 * LIST COURSES
 * GET /api/book/admin/courses
 */
router.get("/admin/courses", requirePlatformAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, notes, created_at FROM booking_courses ORDER BY id DESC LIMIT 500;`
    );
    return res.json({ ok: true, courses: rows || [] });
  } catch (err) {
    console.error("/admin/courses GET error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/**
 * CREATE/UPSERT COURSE
 * POST /api/book/admin/courses { slug, name, notes? }
 */
router.post("/admin/courses", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = String(req.body?.slug || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    if (!slug || !/^[a-z0-9-]{2,64}$/.test(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid", hint: "use a-z, 0-9 and hyphen" });
    }
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });

    const r = await db.query(
      `
      INSERT INTO booking_courses (slug, name, notes)
      VALUES ($1,$2,$3)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        notes = EXCLUDED.notes
      RETURNING id, slug, name, notes, created_at;
      `,
      [slug, name, notes]
    );

    return res.json({ ok: true, course: r.rows[0] });
  } catch (err) {
    console.error("/admin/courses POST error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/**
 * CREATE COURSE ADMIN USER (NO LOCAL HASHING REQUIRED)
 * POST /api/book/admin/course-admin { slug, email, password }
 */
router.post("/admin/course-admin", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = String(req.body?.slug || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });
    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, error: "email_invalid" });
    if (!password || password.length < 8) return res.status(400).json({ ok: false, error: "password_too_short" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = c.rows[0].id;
    const { salt_hex, hash_hex } = pbkdf2Hash(password);

    await db.query(
      `
      INSERT INTO booking_course_users (course_id, email, salt_hex, hash_hex)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (course_id, email) DO UPDATE SET
        salt_hex = EXCLUDED.salt_hex,
        hash_hex = EXCLUDED.hash_hex
      `,
      [courseId, email, salt_hex, hash_hex]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("/admin/course-admin error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/**
 * PUBLIC: GET COURSE BY SLUG (lets the /book/:slug page confirm it exists)
 * GET /api/book/course/:slug
 */
router.get("/course/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const { rows } = await db.query(
      `SELECT id, slug, name, notes FROM booking_courses WHERE slug=$1 LIMIT 1;`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    return res.json({ ok: true, course: rows[0] });
  } catch (err) {
    console.error("/course/:slug error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;