// backend/bookingViews.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";

const router = express.Router();

// -----------------------------
// cookie helper (no deps)
// -----------------------------
function getCookie(req, name) {
  const h = req.headers.cookie || "";
  const parts = h.split(";").map((s) => s.trim());
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return "";
}

function getAnyCookie(req, names) {
  for (const n of names) {
    const v = getCookie(req, n);
    if (v) return v;
  }
  return "";
}

function setCookie(res, name, value, opts = {}) {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  pieces.push(`Path=/`);
  pieces.push(`SameSite=Lax`);
  pieces.push(`HttpOnly`);
  if (opts.maxAgeSeconds) pieces.push(`Max-Age=${opts.maxAgeSeconds}`);
  res.setHeader("Set-Cookie", pieces.join("; "));
}
function clearCookie(res, name) {
  res.setHeader(
    "Set-Cookie",
    `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`
  );
}

// -----------------------------
// db wrappers (pg or sqlite)
// -----------------------------
async function qAll(sql, params = []) {
  if (typeof db.query === "function") {
    const r = await db.query(sql, params);
    return r.rows || [];
  }
  if (typeof db.all === "function") {
    return await db.all(sql, params);
  }
  throw new Error("DB adapter missing query/all");
}
async function qOne(sql, params = []) {
  const rows = await qAll(sql, params);
  return rows[0] || null;
}
async function qExec(sql, params = []) {
  if (typeof db.query === "function") {
    await db.query(sql, params);
    return;
  }
  if (typeof db.run === "function") {
    await db.run(sql, params);
    return;
  }
  throw new Error("DB adapter missing query/run");
}

// -----------------------------
// ✅ NEW: load add-ons per booking (cart hire / club hire)
// (Postgres-only; safe no-op if tables not present)
// -----------------------------
async function getAddonsForBookingIds(bookingIds = []) {
  const ids = Array.isArray(bookingIds)
    ? bookingIds
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];

  if (!ids.length) return new Map();

  // NOTE: bookingMigrate.js should have created:
  // - booking_addons (id, name, price_cents, ...)
  // - booking_booking_addons (booking_id, addon_id, qty, total_cents)
  const rows = await qAll(
    `
    SELECT
      bba.booking_id,
      bba.qty,
      bba.total_cents,
      a.id          AS addon_id,
      a.name        AS addon_name,
      a.price_cents AS addon_price_cents
    FROM booking_booking_addons bba
    JOIN booking_addons a
      ON a.id = bba.addon_id
    WHERE bba.booking_id = ANY($1::bigint[])
    ORDER BY bba.booking_id ASC, a.name ASC
    `,
    [ids]
  );

  const map = new Map();
  for (const r of rows) {
    const bid = Number(r.booking_id);
    if (!map.has(bid)) map.set(bid, []);
    map.get(bid).push({
      addonId: r.addon_id,
      name: r.addon_name,
      qty: Number(r.qty) || 1,
      priceCents: Number(r.addon_price_cents) || 0,
      totalCents: Number(r.total_cents) || 0,
    });
  }
  return map;
}

async function attachAddonsToRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  // Only for Postgres booking system (SQLite fallback likely won’t have addons schema)
  if (typeof db.query !== "function") {
    return rows.map((r) => ({ ...r, addons: [] }));
  }

  try {
    const bookingIds = rows.map((r) => r.id).filter(Boolean);
    const map = await getAddonsForBookingIds(bookingIds);
    return rows.map((r) => ({
      ...r,
      addons: map.get(Number(r.id)) || [],
    }));
  } catch {
    return rows.map((r) => ({ ...r, addons: [] }));
  }
}

// -----------------------------
// SUPER ADMIN helper (provided by server.js middleware)
// -----------------------------
function _isSuperAdminReq(req, email) {
  const fn = req && typeof req.isSuperAdmin === "function" ? req.isSuperAdmin : null;
  if (!fn) return false;
  try {
    return !!fn(email);
  } catch {
    return false;
  }
}

// -----------------------------
// auth guards
// -----------------------------
function requireBookingAdmin(req, res, next) {
  // Support BOTH old and new cookies + header secret
  const expected = String(process.env.BOOKING_ADMIN_SECRET || "").trim();
  const headerSecret = String(req.headers["x-booking-admin-secret"] || "").trim();

  const v = getAnyCookie(req, [
    "teeradar_booking_admin",
    "tr_book_admin", // bookingRoutes sets this
    "booking_admin",
    "bookingAdmin",
    "booking_admin_auth",
  ]);

  const okByHeader = !!(expected && headerSecret && headerSecret === expected);
  const okByCookie = v === "1";

  if (!okByHeader && !okByCookie) {
    return res.status(401).json({ error: "Not logged in as booking admin" });
  }
  next();
}

function requireCourseAdmin(req, res, next) {
  // ✅ Support BYPASS headers (same as bookingRoutes.js)
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
  const providedBypass = String(req.headers["x-course-admin-key"] || "").trim();

  if (bypassKey && providedBypass && providedBypass === bypassKey) {
    const slug =
      String(req.headers["x-course-slug"] || "").trim().toLowerCase() ||
      String(req.query.slug || "").trim().toLowerCase();

    if (!slug) return res.status(400).json({ error: "slug_required" });

    req.courseAdmin = { slug, email: "bypass@teeradar" };
    return next();
  }

  // ✅ Accept BOTH cookie naming schemes (bookingRoutes uses tr_*)
  const slug = getAnyCookie(req, [
    "teeradar_course_admin_slug",
    "tr_course_admin_slug",
  ]);

  const email = getAnyCookie(req, [
    "teeradar_course_admin_email",
    "tr_course_admin_email",
  ]).trim().toLowerCase();

  // super-admin bypass (if you ever rely on it)
  if (_isSuperAdminReq(req, email)) {
    req.courseAdmin = { slug: slug || "", email };
    return next();
  }

  if (!slug || !email) {
    return res.status(401).json({ error: "Not logged in as course admin" });
  }

  req.courseAdmin = { slug, email };
  next();
}

// -----------------------------
// PBKDF2 helpers
// -----------------------------
function hashPassword(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 32, "sha256");
  return { saltHex: salt.toString("hex"), hashHex: derived.toString("hex") };
}
function verifyPassword(password, saltHex, hashHex) {
  const { hashHex: test } = hashPassword(password, saltHex);
  return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hashHex, "hex"));
}

// -----------------------------
// tables (created if missing)
// -----------------------------
async function ensureCourseAdminsTable() {
  if (typeof db.query === "function") {
    await qExec(`
      CREATE TABLE IF NOT EXISTS booking_course_admins (
        id SERIAL PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        email TEXT NOT NULL,
        salt_hex TEXT NOT NULL,
        hash_hex TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(course_id, email),
        UNIQUE(email)
      );
    `);
    return;
  }

  await qExec(`
    CREATE TABLE IF NOT EXISTS booking_course_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER,
      slug TEXT NOT NULL,
      email TEXT NOT NULL,
      salt_hex TEXT NOT NULL,
      hash_hex TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureBookingsTable() {
  if (typeof db.query === "function") {
    await qExec(`
      CREATE TABLE IF NOT EXISTS booking_bookings (
        id BIGSERIAL PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
        play_date DATE NOT NULL,
        tee_time TEXT NOT NULL,
        holes INTEGER NOT NULL,
        players INTEGER NOT NULL,
        golfer_name TEXT,
        golfer_email TEXT,
        golfer_phone TEXT,
        price_per_player_cents INTEGER NOT NULL,
        total_cents INTEGER NOT NULL,
        booking_fee_cents INTEGER NOT NULL DEFAULT 0,
        reference TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await qExec(`
      CREATE INDEX IF NOT EXISTS booking_bookings_course_date_idx
      ON booking_bookings (course_id, play_date);
    `);

    return;
  }

  try {
    await qExec(`
      CREATE TABLE IF NOT EXISTS booking_bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_slug TEXT NOT NULL,
        play_date TEXT NOT NULL,
        tee_time TEXT NOT NULL,
        holes INTEGER,
        players INTEGER,
        name TEXT,
        email TEXT,
        phone TEXT,
        status TEXT DEFAULT 'BOOKED',
        reference TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch {}
}

// -----------------------------
// ✅ ADD: debug route so /api/book/course-admin/_debug returns JSON (not homepage)
// -----------------------------
router.get("/api/book/course-admin/_debug", (req, res) => {
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
  const providedBypass = String(req.headers["x-course-admin-key"] || "").trim();

  res.json({
    ok: true,
    path: req.path,
    query: req.query || {},
    hasCookieHeader: !!req.headers.cookie,
    cookiesSeen: {
      teeradar_course_admin_slug: getCookie(req, "teeradar_course_admin_slug") || null,
      teeradar_course_admin_email: getCookie(req, "teeradar_course_admin_email") || null,
      tr_course_admin_slug: getCookie(req, "tr_course_admin_slug") || null,
      tr_course_admin_email: getCookie(req, "tr_course_admin_email") || null,
      tr_course_admin_token: getCookie(req, "tr_course_admin_token") ? "present" : null,
    },
    bypass: {
      envSet: !!bypassKey,
      headerProvided: !!providedBypass,
      headerMatches: !!(bypassKey && providedBypass && bypassKey === providedBypass),
      slugHeader: String(req.headers["x-course-slug"] || "") || null,
      querySlug: String(req.query.slug || "") || null,
    },
  });
});

// -----------------------------
// Admin login/logout
// -----------------------------
router.post("/api/book/admin/login", express.json(), async (req, res) => {
  const secret = String(req.body?.secret || "");
  const expected = String(process.env.BOOKING_ADMIN_SECRET || "");
  if (!expected || secret !== expected) return res.status(401).json({ error: "Invalid secret" });

  setCookie(res, "teeradar_booking_admin", "1", { maxAgeSeconds: 60 * 60 * 12 });
  return res.json({ ok: true });
});

router.post("/api/book/admin/logout", (req, res) => {
  clearCookie(res, "teeradar_booking_admin");
  return res.json({ ok: true });
});

// -----------------------------
// Course admin login/logout
// -----------------------------
router.post("/api/book/course-admin/login", express.json(), async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Missing email/password" });

  try { await ensureCourseAdminsTable(); } catch {}

  let admin = null;
  try {
    admin = await qOne(
      `SELECT slug, email, salt_hex, hash_hex
       FROM booking_course_admins
       WHERE lower(email) = $1
       LIMIT 1`,
      [email]
    );
  } catch {
    admin = await qOne(
      `SELECT slug, email, salt_hex, hash_hex
       FROM booking_course_admins
       WHERE lower(email) = ?
       LIMIT 1`,
      [email]
    );
  }

  if (!admin && _isSuperAdminReq(req, email)) {
    setCookie(res, "teeradar_course_admin_slug", "*", { maxAgeSeconds: 60 * 60 * 12 });
    setCookie(res, "teeradar_course_admin_email", String(email), { maxAgeSeconds: 60 * 60 * 12 });
    return res.json({ ok: true, slug: "*" });
  }

  if (!admin) return res.status(401).json({ error: "Invalid login" });

  const ok = verifyPassword(password, admin.salt_hex, admin.hash_hex);
  if (!ok) return res.status(401).json({ error: "Invalid login" });

  setCookie(res, "teeradar_course_admin_slug", String(admin.slug), { maxAgeSeconds: 60 * 60 * 12 });
  setCookie(res, "teeradar_course_admin_email", String(admin.email), { maxAgeSeconds: 60 * 60 * 12 });
  return res.json({ ok: true, slug: admin.slug });
});

router.post("/api/book/course-admin/logout", (req, res) => {
  clearCookie(res, "teeradar_course_admin_slug");
  clearCookie(res, "teeradar_course_admin_email");
  return res.json({ ok: true });
});

// -----------------------------
// Create course admin user (called by book-admin.html)
// -----------------------------
router.post("/api/book/admin/course-admin", requireBookingAdmin, express.json(), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!slug) return res.status(400).json({ error: "Missing slug" });
  if (!email) return res.status(400).json({ error: "Missing email" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be 8+ chars" });

  try { await ensureCourseAdminsTable(); } catch {}

  const { saltHex, hashHex } = hashPassword(password);

  let courseId = null;
  if (typeof db.query === "function") {
    const course = await qOne(
      `SELECT id, slug FROM booking_courses WHERE slug = $1 LIMIT 1`,
      [slug]
    );
    if (!course) return res.status(400).json({ error: "Unknown course slug (create course first)" });
    courseId = Number(course.id);
  }

  try { await qExec(`DELETE FROM booking_course_admins WHERE lower(email) = $1`, [email]); }
  catch { await qExec(`DELETE FROM booking_course_admins WHERE lower(email) = ?`, [email]); }

  try {
    if (typeof db.query === "function") {
      await qExec(
        `INSERT INTO booking_course_admins (course_id, slug, email, salt_hex, hash_hex, created_at)
         VALUES ($1,$2,$3,$4,$5,now())`,
        [courseId, slug, email, saltHex, hashHex]
      );
    } else {
      await qExec(
        `INSERT INTO booking_course_admins (course_id, slug, email, salt_hex, hash_hex, created_at)
         VALUES (?,?,?,?,?,?)`,
        [courseId, slug, email, saltHex, hashHex, new Date().toISOString()]
      );
    }
  } catch (e) {
    return res.status(500).json({ error: "Failed to save course admin", detail: String(e?.message || e) });
  }

  return res.json({ ok: true });
});

// -----------------------------
// View bookings (platform admin)
// -----------------------------
router.get("/api/book/admin/bookings", requireBookingAdmin, async (req, res) => {
  await ensureBookingsTable();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const slug = String(url.searchParams.get("slug") || "").trim();
  const date = String(url.searchParams.get("date") || "").trim();
  if (!slug) return res.status(400).json({ error: "Missing slug" });

  let courseId = null;
  if (typeof db.query === "function") {
    const course = await qOne(`SELECT id FROM booking_courses WHERE slug = $1 LIMIT 1`, [slug]);
    if (!course) return res.json({ bookings: [] });
    courseId = Number(course.id);
  }

  let rows = [];
  try {
    if (typeof db.query === "function") {
      if (date) {
        rows = await qAll(
          `SELECT
             b.id,
             $1::text AS course_slug,
             b.play_date::text AS play_date,
             b.tee_time,
             b.holes,
             b.players,
             b.golfer_name  AS name,
             b.golfer_email AS email,
             b.golfer_phone AS phone,
             b.price_per_player_cents,
             b.total_cents,
             b.booking_fee_cents,
             b.status,
             b.reference,
             b.created_at
           FROM booking_bookings b
           WHERE b.course_id = $2
            AND b.play_date = $3::date
            AND upper(coalesce(b.status,'')) = 'CONFIRMED'
           ORDER BY b.tee_time ASC, b.created_at DESC`,
          [slug, courseId, date]
        );
      } else {
        rows = await qAll(
          `SELECT
             b.id,
             $1::text AS course_slug,
             b.play_date::text AS play_date,
             b.tee_time,
             b.holes,
             b.players,
             b.golfer_name  AS name,
             b.golfer_email AS email,
             b.golfer_phone AS phone,
             b.price_per_player_cents,
             b.total_cents,
             b.booking_fee_cents,
             b.status,
             b.reference,
             b.created_at
           FROM booking_bookings b
           WHERE b.course_id = $2
             AND upper(coalesce(b.status,'')) = 'CONFIRMED'
           ORDER BY b.play_date DESC, b.tee_time ASC, b.created_at DESC
           LIMIT 500`,
          [slug, courseId]
        );
      }
    } else {
      if (date) {
        rows = await qAll(
          `SELECT course_slug, play_date, tee_time, holes, players, name, email, phone, status, reference, created_at
           FROM booking_bookings
           WHERE course_slug = ? AND play_date = ?
           ORDER BY tee_time ASC, created_at DESC`,
          [slug, date]
        );
      } else {
        rows = await qAll(
          `SELECT course_slug, play_date, tee_time, holes, players, name, email, phone, status, reference, created_at
           FROM booking_bookings
           WHERE course_slug = ?
           ORDER BY play_date DESC, tee_time ASC, created_at DESC
           LIMIT 500`,
          [slug]
        );
      }
    }
  } catch (e) {
    return res.status(500).json({ error: "Failed to load bookings", detail: String(e?.message || e) });
  }

  rows = await attachAddonsToRows(rows);

  return res.json({ bookings: rows });
});

// -----------------------------
// View bookings (course admin)
// -----------------------------
router.get("/api/book/course-admin/bookings", requireCourseAdmin, async (req, res) => {
  await ensureBookingsTable();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = String(url.searchParams.get("date") || "").trim();

  // ✅ allow super-admin "*" to query a course via ?slug=xxx
  let slug = String(req.courseAdmin?.slug || "").trim();
  if (slug === "*") {
    slug = String(url.searchParams.get("slug") || "").trim();
  }

  if (!slug) return res.status(400).json({ error: "Missing slug" });

  let courseId = null;
  if (typeof db.query === "function") {
    const course = await qOne(`SELECT id FROM booking_courses WHERE slug = $1 LIMIT 1`, [slug]);
    if (!course) return res.json({ bookings: [], course_slug: slug });
    courseId = Number(course.id);
  }

  let rows = [];
  try {
    if (typeof db.query === "function") {
      if (date) {
        rows = await qAll(
          `SELECT
             b.id,
             $1::text AS course_slug,
             b.play_date::text AS play_date,
             b.tee_time,
             b.holes,
             b.players,
             b.golfer_name  AS name,
             b.golfer_email AS email,
             b.golfer_phone AS phone,
             b.price_per_player_cents,
             b.total_cents,
             b.booking_fee_cents,
             b.status,
             b.reference,
             b.created_at
           FROM booking_bookings b
           WHERE b.course_id = $2
            AND b.play_date = $3::date
            AND upper(coalesce(b.status,'')) = 'CONFIRMED'
           ORDER BY b.tee_time ASC, b.created_at DESC`,
          [slug, courseId, date]
        );
      } else {
        rows = await qAll(
          `SELECT
             b.id,
             $1::text AS course_slug,
             b.play_date::text AS play_date,
             b.tee_time,
             b.holes,
             b.players,
             b.golfer_name  AS name,
             b.golfer_email AS email,
             b.golfer_phone AS phone,
             b.price_per_player_cents,
             b.total_cents,
             b.booking_fee_cents,
             b.status,
             b.reference,
             b.created_at
           FROM booking_bookings b
           WHERE b.course_id = $2
             AND upper(coalesce(b.status,'')) = 'CONFIRMED'
           ORDER BY b.play_date DESC, b.tee_time ASC, b.created_at DESC
           LIMIT 500`,
          [slug, courseId]
        );
      }
    } else {
      if (date) {
        rows = await qAll(
          `SELECT course_slug, play_date, tee_time, holes, players, name, email, phone, status, reference, created_at
           FROM booking_bookings
           WHERE course_slug = ? AND play_date = ?
           ORDER BY tee_time ASC, created_at DESC`,
          [slug, date]
        );
      } else {
        rows = await qAll(
          `SELECT course_slug, play_date, tee_time, holes, players, name, email, phone, status, reference, created_at
           FROM booking_bookings
           WHERE course_slug = ?
           ORDER BY play_date DESC, tee_time ASC, created_at DESC
           LIMIT 500`,
          [slug]
        );
      }
    }
  } catch (e) {
    return res.status(500).json({ error: "Failed to load bookings", detail: String(e?.message || e) });
  }

  rows = await attachAddonsToRows(rows);

  return res.json({ bookings: rows, course_slug: slug });
});

export default router;
