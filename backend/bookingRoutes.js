// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";

const router = express.Router();

/**
 * ENV you must set:
 * - BOOKING_ADMIN_SECRET: long random string (32+ chars)
 */
const ADMIN_SECRET = (process.env.BOOKING_ADMIN_SECRET || "").trim();
if (!ADMIN_SECRET) {
  console.warn(
    "⚠️ BOOKING_ADMIN_SECRET is not set. Set it in your environment for admin auth to work securely."
  );
}

const ADMIN_COOKIE_NAME = "tr_course_admin";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// -------------------------
// Helpers
// -------------------------
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function base64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function hmacSha256(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

// simple signed token: base64url(payloadJSON) + "." + base64url(hmac(payloadB64))
function signToken(payloadObj) {
  const payloadB64 = base64urlEncode(JSON.stringify(payloadObj));
  const sig = base64urlEncode(hmacSha256(payloadB64, ADMIN_SECRET || "dev-secret"));
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expectedSig = base64urlEncode(hmacSha256(payloadB64, ADMIN_SECRET || "dev-secret"));
  if (sigB64 !== expectedSig) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// Password hashing: PBKDF2 (no dependencies)
function hashPassword(password, salt = null) {
  const saltBuf = salt ? Buffer.from(salt, "hex") : crypto.randomBytes(16);
  const hashBuf = crypto.pbkdf2Sync(password, saltBuf, 120000, 32, "sha256");
  return {
    saltHex: saltBuf.toString("hex"),
    hashHex: hashBuf.toString("hex"),
  };
}
function verifyPassword(password, saltHex, hashHex) {
  const { hashHex: computed } = hashPassword(password, saltHex);
  // constant-time compare
  return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hashHex, "hex"));
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Not authenticated" });
  req.admin = payload; // { course_user_id, course_id, role, exp }
  return next();
}

// -------------------------
// DB init (idempotent)
// -------------------------
async function ensureBookingTables() {
  // Keep this idempotent. It runs once per process start.
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_courses (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Australia/Perth',
      notify_email TEXT,
      phone TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_users (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'course_admin', -- course_admin | staff
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(course_id, email)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_prices (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      day_type TEXT NOT NULL DEFAULT 'any', -- any | weekday | weekend
      holes INTEGER NOT NULL DEFAULT 18, -- 9 or 18
      price_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(course_id, day_type, holes)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_time_slots (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      slot_date DATE NOT NULL,
      slot_time TEXT NOT NULL, -- "HH:MM"
      capacity_players INTEGER NOT NULL DEFAULT 4,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(course_id, slot_date, slot_time)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_bookings (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      slot_date DATE NOT NULL,
      slot_time TEXT NOT NULL, -- "HH:MM"
      players INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      contact_phone TEXT,
      contact_email TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_bookings_course_date
    ON booking_bookings(course_id, slot_date);
  `);
}
let tablesEnsured = false;
async function ensureOnce() {
  if (tablesEnsured) return;
  await ensureBookingTables();
  tablesEnsured = true;
}

// -------------------------
// PUBLIC: course info + availability
// -------------------------

// GET /api/book/course/:slug
router.get("/course/:slug", async (req, res) => {
  try {
    await ensureOnce();
    const { slug } = req.params;
    const r = await db.query(
      `SELECT id, slug, name, timezone, phone, is_active FROM booking_courses WHERE slug=$1`,
      [slug]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Course not found" });
    return res.json({ course: r.rows[0] });
  } catch (e) {
    console.error("booking course error", e);
    return res.status(500).json({ error: "Failed to load course" });
  }
});

// GET /api/book/course/:slug/availability?date=YYYY-MM-DD
router.get("/course/:slug/availability", async (req, res) => {
  try {
    await ensureOnce();
    const { slug } = req.params;
    const date = (req.query.date || "").toString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date (use YYYY-MM-DD)" });
    }

    const courseR = await db.query(
      `SELECT id, slug, name, is_active FROM booking_courses WHERE slug=$1`,
      [slug]
    );
    if (!courseR.rows.length) return res.status(404).json({ error: "Course not found" });
    const course = courseR.rows[0];
    if (!course.is_active) return res.status(403).json({ error: "Course not active" });

    const slotsR = await db.query(
      `
      SELECT s.slot_time, s.capacity_players, s.is_blocked, s.note
      FROM booking_time_slots s
      WHERE s.course_id=$1 AND s.slot_date=$2
      ORDER BY s.slot_time ASC
      `,
      [course.id, date]
    );

    const bookingsR = await db.query(
      `
      SELECT slot_time, COALESCE(SUM(players),0) AS booked_players
      FROM booking_bookings
      WHERE course_id=$1 AND slot_date=$2 AND status='confirmed'
      GROUP BY slot_time
      `,
      [course.id, date]
    );

    const bookedMap = new Map();
    for (const row of bookingsR.rows) bookedMap.set(row.slot_time, Number(row.booked_players || 0));

    const availability = slotsR.rows.map((s) => {
      const booked = bookedMap.get(s.slot_time) || 0;
      const remaining = Math.max(0, Number(s.capacity_players) - booked);
      return {
        time: s.slot_time,
        capacity_players: Number(s.capacity_players),
        booked_players: booked,
        remaining_players: remaining,
        is_blocked: !!s.is_blocked,
        note: s.note || "",
        can_book: !s.is_blocked && remaining > 0,
      };
    });

    return res.json({ course: { slug, name: course.name }, date, availability });
  } catch (e) {
    console.error("availability error", e);
    return res.status(500).json({ error: "Failed to load availability" });
  }
});

// POST /api/book/create
// Body: { courseSlug, date, time, players, name, phone?, email? }
router.post("/create", async (req, res) => {
  try {
    await ensureOnce();
    const { courseSlug, date, time, players, name, phone, email } = req.body || {};

    const d = (date || "").toString().slice(0, 10);
    const t = (time || "").toString().slice(0, 5);
    const p = Number(players);

    if (!courseSlug || !/^[a-z0-9-]{2,40}$/i.test(courseSlug)) {
      return res.status(400).json({ error: "Invalid courseSlug" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).json({ error: "Invalid date" });
    }
    if (!/^\d{2}:\d{2}$/.test(t)) {
      return res.status(400).json({ error: "Invalid time (HH:MM)" });
    }
    if (!Number.isFinite(p) || p < 1 || p > 8) {
      return res.status(400).json({ error: "Players must be between 1 and 8" });
    }
    if (!name || name.toString().trim().length < 2) {
      return res.status(400).json({ error: "Name is required" });
    }

    const courseR = await db.query(
      `SELECT id, slug, name, notify_email, is_active FROM booking_courses WHERE slug=$1`,
      [courseSlug]
    );
    if (!courseR.rows.length) return res.status(404).json({ error: "Course not found" });
    const course = courseR.rows[0];
    if (!course.is_active) return res.status(403).json({ error: "Course not active" });

    // Load slot
    const slotR = await db.query(
      `
      SELECT capacity_players, is_blocked
      FROM booking_time_slots
      WHERE course_id=$1 AND slot_date=$2 AND slot_time=$3
      `,
      [course.id, d, t]
    );
    if (!slotR.rows.length) return res.status(400).json({ error: "That time is not available" });
    const slot = slotR.rows[0];
    if (slot.is_blocked) return res.status(400).json({ error: "That time is blocked" });

    // Compute remaining
    const bookedR = await db.query(
      `
      SELECT COALESCE(SUM(players),0) AS booked_players
      FROM booking_bookings
      WHERE course_id=$1 AND slot_date=$2 AND slot_time=$3 AND status='confirmed'
      `,
      [course.id, d, t]
    );
    const booked = Number(bookedR.rows[0]?.booked_players || 0);
    const remaining = Math.max(0, Number(slot.capacity_players) - booked);
    if (p > remaining) {
      return res.status(400).json({ error: `Only ${remaining} player(s) left at that time` });
    }

    const ins = await db.query(
      `
      INSERT INTO booking_bookings
      (course_id, slot_date, slot_time, players, contact_name, contact_phone, contact_email, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed')
      RETURNING id, created_at
      `,
      [
        course.id,
        d,
        t,
        p,
        name.toString().trim(),
        (phone || "").toString().trim() || null,
        (email || "").toString().trim() || null,
      ]
    );

    // NOTE: notifications (email/SMS) comes next step.
    // For MVP we return success and you can add Resend in the next chunk.

    return res.json({
      ok: true,
      booking: {
        id: ins.rows[0].id,
        course: course.name,
        date: d,
        time: t,
        players: p,
        created_at: ins.rows[0].created_at,
      },
    });
  } catch (e) {
    console.error("create booking error", e);
    return res.status(500).json({ error: "Failed to create booking" });
  }
});

// -------------------------
// ADMIN AUTH
// -------------------------

// POST /api/book/admin/login
// Body: { email, password }
router.post("/admin/login", async (req, res) => {
  try {
    await ensureOnce();
    const { email, password } = req.body || {};
    const em = (email || "").toString().trim().toLowerCase();
    const pw = (password || "").toString();

    if (!em || !pw) return res.status(400).json({ error: "Missing email/password" });

    const r = await db.query(
      `
      SELECT u.id, u.course_id, u.role, u.is_active, u.password_salt, u.password_hash,
             c.slug as course_slug, c.name as course_name, c.is_active as course_active
      FROM booking_course_users u
      JOIN booking_courses c ON c.id=u.course_id
      WHERE u.email=$1
      LIMIT 1
      `,
      [em]
    );
    if (!r.rows.length) return res.status(401).json({ error: "Invalid login" });

    const u = r.rows[0];
    if (!u.is_active || !u.course_active) return res.status(403).json({ error: "Account disabled" });
    if (!verifyPassword(pw, u.password_salt, u.password_hash)) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const payload = {
      course_user_id: u.id,
      course_id: u.course_id,
      role: u.role,
      exp: Date.now() + ONE_DAY_MS, // 24h
    };
    const token = signToken(payload);

    res.cookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true, // keep true in production (Render/https)
      path: "/",
      maxAge: ONE_DAY_MS,
    });

    return res.json({
      ok: true,
      me: { course_id: u.course_id, role: u.role, course_slug: u.course_slug, course_name: u.course_name },
    });
  } catch (e) {
    console.error("admin login error", e);
    return res.status(500).json({ error: "Failed login" });
  }
});

router.post("/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, { path: "/" });
  return res.json({ ok: true });
});

router.get("/admin/me", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const r = await db.query(`SELECT id, slug, name FROM booking_courses WHERE id=$1`, [
      req.admin.course_id,
    ]);
    if (!r.rows.length) return res.status(401).json({ error: "Invalid session" });
    return res.json({ ok: true, course: r.rows[0], role: req.admin.role });
  } catch (e) {
    console.error("admin me error", e);
    return res.status(500).json({ error: "Failed" });
  }
});

// -------------------------
// ADMIN: manage slots, pricing, bookings (course-scoped)
// -------------------------

// GET /api/book/admin/bookings?date=YYYY-MM-DD
router.get("/admin/bookings", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const date = (req.query.date || "").toString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date" });
    }
    const r = await db.query(
      `
      SELECT id, slot_time, players, contact_name, contact_phone, contact_email, status, created_at
      FROM booking_bookings
      WHERE course_id=$1 AND slot_date=$2
      ORDER BY slot_time ASC, created_at ASC
      `,
      [req.admin.course_id, date]
    );
    return res.json({ ok: true, date, bookings: r.rows });
  } catch (e) {
    console.error("admin bookings error", e);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

// POST /api/book/admin/slots/upsert
// Body: { date, time, capacity_players, is_blocked, note? }
router.post("/admin/slots/upsert", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const { date, time, capacity_players, is_blocked, note } = req.body || {};
    const d = (date || "").toString().slice(0, 10);
    const t = (time || "").toString().slice(0, 5);
    const cap = Number(capacity_players);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: "Invalid date" });
    if (!/^\d{2}:\d{2}$/.test(t)) return res.status(400).json({ error: "Invalid time" });
    if (!Number.isFinite(cap) || cap < 1 || cap > 16) {
      return res.status(400).json({ error: "capacity_players must be 1..16" });
    }

    await db.query(
      `
      INSERT INTO booking_time_slots (course_id, slot_date, slot_time, capacity_players, is_blocked, note)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (course_id, slot_date, slot_time)
      DO UPDATE SET capacity_players=EXCLUDED.capacity_players, is_blocked=EXCLUDED.is_blocked, note=EXCLUDED.note
      `,
      [
        req.admin.course_id,
        d,
        t,
        cap,
        !!is_blocked,
        (note || "").toString().slice(0, 160) || null,
      ]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("admin slot upsert error", e);
    return res.status(500).json({ error: "Failed to save slot" });
  }
});

// POST /api/book/admin/booking/cancel
// Body: { bookingId }
router.post("/admin/booking/cancel", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const { bookingId } = req.body || {};
    const id = Number(bookingId);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid bookingId" });

    const r = await db.query(
      `UPDATE booking_bookings SET status='cancelled'
       WHERE id=$1 AND course_id=$2
       RETURNING id`,
      [id, req.admin.course_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Booking not found" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("admin booking cancel error", e);
    return res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// POST /api/book/admin/pricing/update
// Body: { day_type: 'any'|'weekday'|'weekend', holes: 9|18, price_cents }
router.post("/admin/pricing/update", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const { day_type, holes, price_cents } = req.body || {};
    const dt = (day_type || "any").toString();
    const h = Number(holes);
    const pc = Number(price_cents);

    if (!["any", "weekday", "weekend"].includes(dt)) return res.status(400).json({ error: "Invalid day_type" });
    if (![9, 18].includes(h)) return res.status(400).json({ error: "holes must be 9 or 18" });
    if (!Number.isFinite(pc) || pc < 0 || pc > 50000) return res.status(400).json({ error: "Invalid price_cents" });

    await db.query(
      `
      INSERT INTO booking_prices (course_id, day_type, holes, price_cents)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (course_id, day_type, holes)
      DO UPDATE SET price_cents=EXCLUDED.price_cents
      `,
      [req.admin.course_id, dt, h, pc]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("admin pricing update error", e);
    return res.status(500).json({ error: "Failed to update pricing" });
  }
});

export default router;