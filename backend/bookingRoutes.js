// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";

const router = express.Router();

const ADMIN_SECRET = (process.env.BOOKING_ADMIN_SECRET || "").trim();

// -----------------------------
// Helpers
// -----------------------------
function normSlug(s) {
  return String(s || "").trim().toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9-]{2,64}$/.test(slug);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function makeRef(prefix = "TR") {
  // e.g. TR-8F2KQ9
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${out}`;
}

function requirePlatformAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ ok: false, error: "BOOKING_ADMIN_SECRET not set" });
  }
  const token = String(req.cookies?.tr_book_admin || "");
  if (token !== "1") return res.status(401).json({ ok: false, error: "not_authorized" });
  return next();
}

// ✅ NEW: accept both the old and new admin generator payload shapes
function _pickAny(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) return obj[k];
  }
  return fallback;
}

// -----------------------------
// One-time table creation (safe)
// -----------------------------
async function ensureBookingTables() {
  // Courses
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_courses (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Course admins (optional, later)
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

  // Tee time availability (the key piece)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_times (
      id BIGSERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,

      play_date DATE NOT NULL,
      tee_time TEXT NOT NULL,                 -- "HH:MM"
      holes INTEGER NOT NULL,                 -- 9 or 18
      max_players INTEGER NOT NULL DEFAULT 4,

      price_per_player_cents INTEGER NOT NULL DEFAULT 0,

      status TEXT NOT NULL DEFAULT 'AVAILABLE',  -- AVAILABLE | BLOCKED | BOOKED
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),

      UNIQUE(course_id, play_date, tee_time, holes)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_times_lookup_idx
    ON booking_times (course_id, play_date, holes, status, tee_time);
  `);

  // Bookings
  await db.query(`
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
      booking_fee_cents INTEGER NOT NULL DEFAULT 0, -- your fee (optional)

      reference TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED | CANCELLED

      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_bookings_course_date_idx
    ON booking_bookings (course_id, play_date);
  `);

  console.log("✅ booking tables ready");
}

ensureBookingTables().catch((e) => console.error("❌ ensureBookingTables error", e));

// -----------------------------
// Platform admin login (cookie)
// -----------------------------
router.post("/admin/login", (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ ok: false, error: "BOOKING_ADMIN_SECRET not set" });

  const secret = String(req.body?.secret || "").trim();
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "invalid_secret" });
  }

  res.cookie("tr_book_admin", "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({ ok: true });
});

router.post("/admin/logout", (req, res) => {
  res.clearCookie("tr_book_admin", { path: "/" });
  res.json({ ok: true });
});

// -----------------------------
// Admin: Create/Update course
// -----------------------------
router.get("/admin/courses", requirePlatformAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, notes, created_at FROM booking_courses ORDER BY id DESC LIMIT 500;`
    );
    res.json({ ok: true, courses: rows || [] });
  } catch (e) {
    console.error("admin/courses GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/admin/courses", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const name = String(req.body?.name || "").trim();
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
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

    res.json({ ok: true, course: r.rows[0] });
  } catch (e) {
    console.error("admin/courses POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// ✅ NEW: Admin: Bulk-generate tee times (endpoint used by book-admin.html)
// -----------------------------
// POST /api/book/admin/generate-times
// Body: {
//   slug, playDate, start, end, intervalMins, holes, maxPlayers, pricePerPlayerCents
// }
// Also accepts your older shape: { slug, date, intervalMinutes, ... } etc.
router.post("/admin/generate-times", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(_pickAny(req.body, ["slug"], ""));
    const playDate = String(_pickAny(req.body, ["playDate", "date"], "") || "").trim(); // YYYY-MM-DD

    const start = String(_pickAny(req.body, ["start"], "06:00") || "06:00").trim();
    const end = String(_pickAny(req.body, ["end"], "17:00") || "17:00").trim();

    const intervalMinsRaw = _pickAny(req.body, ["intervalMins", "intervalMinutes"], 10);
    const intervalMins = Number(intervalMinsRaw);

    const holes = Number(_pickAny(req.body, ["holes"], 18));
    const maxPlayers = Number(_pickAny(req.body, ["maxPlayers"], 4));
    const pricePerPlayerCents = Number(_pickAny(req.body, ["pricePerPlayerCents"], 0));

    // status optional (default AVAILABLE). Allow BLOCKED too.
    const status = String(_pickAny(req.body, ["status"], "AVAILABLE") || "AVAILABLE").trim().toUpperCase();

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!playDate) return res.status(400).json({ ok: false, error: "date_required" });

    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_must_be_9_or_18" });

    if (!Number.isFinite(intervalMins) || intervalMins < 1 || intervalMins > 60)
      return res.status(400).json({ ok: false, error: "interval_invalid" });

    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return res.status(400).json({ ok: false, error: "maxPlayers_invalid" });

    if (!Number.isFinite(pricePerPlayerCents) || pricePerPlayerCents < 0 || pricePerPlayerCents > 10000000)
      return res.status(400).json({ ok: false, error: "price_invalid" });

    if (!["AVAILABLE", "BLOCKED"].includes(status))
      return res.status(400).json({ ok: false, error: "status_invalid" });

    const sM = toMinutes(start);
    const eM = toMinutes(end);
    if (sM === null || eM === null || eM <= sM) {
      return res.status(400).json({ ok: false, error: "time_range_invalid" });
    }

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const times = [];
    for (let m = sM; m <= eM; m += intervalMins) times.push(fromMinutes(m));

    // Upsert each time; count inserted vs skipped (conflict) and keep BOOKED as BOOKED
    let inserted = 0;
    let skipped = 0;

    for (const t of times) {
      // if exists, treat as skipped; otherwise inserted
      const exists = await db.query(
        `
        SELECT 1
        FROM booking_times
        WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        LIMIT 1;
        `,
        [courseId, playDate, t, holes]
      );

      const isExisting = !!exists.rows.length;

      await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, price_per_player_cents, status, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, $6, $7, now())
        ON CONFLICT (course_id, play_date, tee_time, holes)
        DO UPDATE SET
          max_players = EXCLUDED.max_players,
          price_per_player_cents = EXCLUDED.price_per_player_cents,
          status = CASE
            WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
            ELSE EXCLUDED.status
          END,
          updated_at = now()
        `,
        [courseId, playDate, t, holes, maxPlayers, pricePerPlayerCents, status]
      );

      if (isExisting) skipped += 1;
      else inserted += 1;
    }

    res.json({
      ok: true,
      slug,
      date: playDate,
      holes,
      generated: times.length,
      inserted,
      skipped,
    });
  } catch (e) {
    console.error("admin/generate-times", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Admin: Bulk-generate tee times (legacy endpoint - keep)
// -----------------------------
// POST /api/book/admin/times/generate
// Body: { slug, date, start, end, intervalMinutes, holes, maxPlayers, pricePerPlayerCents, status? }
// Creates/updates booking_times for that day.
router.post("/admin/times/generate", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const date = String(req.body?.date || "").trim(); // YYYY-MM-DD
    const start = String(req.body?.start || "06:00").trim();
    const end = String(req.body?.end || "17:00").trim();
    const intervalMinutes = Number(req.body?.intervalMinutes || 8);
    const holes = Number(req.body?.holes || 18);
    const maxPlayers = Number(req.body?.maxPlayers || 4);
    const pricePerPlayerCents = Number(req.body?.pricePerPlayerCents || 0);
    const status = String(req.body?.status || "AVAILABLE").trim().toUpperCase();

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_must_be_9_or_18" });
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 4 || intervalMinutes > 20)
      return res.status(400).json({ ok: false, error: "interval_invalid" });
    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return res.status(400).json({ ok: false, error: "maxPlayers_invalid" });
    if (!["AVAILABLE", "BLOCKED"].includes(status))
      return res.status(400).json({ ok: false, error: "status_invalid" });

    const sM = toMinutes(start);
    const eM = toMinutes(end);
    if (sM === null || eM === null || eM <= sM) return res.status(400).json({ ok: false, error: "time_range_invalid" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const times = [];
    for (let m = sM; m <= eM; m += intervalMinutes) times.push(fromMinutes(m));

    // Upsert each time
    let upserts = 0;
    for (const t of times) {
      const r = await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, price_per_player_cents, status, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, $6, $7, now())
        ON CONFLICT (course_id, play_date, tee_time, holes)
        DO UPDATE SET
          max_players = EXCLUDED.max_players,
          price_per_player_cents = EXCLUDED.price_per_player_cents,
          status = CASE
            WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
            ELSE EXCLUDED.status
          END,
          updated_at = now()
        `,
        [courseId, date, t, holes, maxPlayers, pricePerPlayerCents, status]
      );
      upserts += r.rowCount || 0;
    }

    res.json({ ok: true, generated: times.length, upserts });
  } catch (e) {
    console.error("admin/times/generate", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// Admin: list times (for a day)
router.get("/admin/times", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const date = String(req.query.date || "").trim();
    const holes = req.query.holes ? Number(req.query.holes) : null;

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const params = [courseId, date];
    let q = `
      SELECT id, play_date, tee_time, holes, max_players, price_per_player_cents, status
      FROM booking_times
      WHERE course_id = $1 AND play_date = $2::date
    `;
    if (holes) {
      q += ` AND holes = $3`;
      params.push(holes);
    }
    q += ` ORDER BY holes DESC, tee_time ASC`;

    const { rows } = await db.query(q, params);
    res.json({ ok: true, times: rows || [] });
  } catch (e) {
    console.error("admin/times GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Public: course info
// -----------------------------
router.get("/course/:slug", async (req, res) => {
  try {
    const slug = normSlug(req.params.slug);
    const { rows } = await db.query(
      `SELECT id, slug, name, notes FROM booking_courses WHERE slug=$1 LIMIT 1;`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    res.json({ ok: true, course: rows[0] });
  } catch (e) {
    console.error("course/:slug", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Public: search availability
// -----------------------------
// GET /api/book/availability?slug=marri-park&date=YYYY-MM-DD&holes=18&players=2&earliest=06:00&latest=17:00
router.get("/availability", async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const date = String(req.query.date || "").trim();
    const holes = Number(req.query.holes || 18);
    const players = Number(req.query.players || 2);
    const earliest = String(req.query.earliest || "06:00").trim();
    const latest = String(req.query.latest || "17:00").trim();

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(players) || players < 1 || players > 4)
      return res.status(400).json({ ok: false, error: "players_invalid" });

    const sM = toMinutes(earliest);
    const eM = toMinutes(latest);
    if (sM === null || eM === null || eM <= sM) return res.status(400).json({ ok: false, error: "time_range_invalid" });

    const c = await db.query(`SELECT id, name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const { rows } = await db.query(
      `
      SELECT tee_time, max_players, holes, price_per_player_cents
      FROM booking_times
      WHERE course_id = $1
        AND play_date = $2::date
        AND holes = $3
        AND status = 'AVAILABLE'
        AND (substring(tee_time,1,2)::int*60 + substring(tee_time,4,2)::int) >= $4
        AND (substring(tee_time,1,2)::int*60 + substring(tee_time,4,2)::int) <= $5
        AND max_players >= $6
      ORDER BY tee_time ASC
      LIMIT 200;
      `,
      [courseId, date, holes, sM, eM, players]
    );

    const slots = (rows || []).map((r) => ({
      time: r.tee_time,
      holes: r.holes,
      maxPlayers: r.max_players,
      pricePerPlayerCents: r.price_per_player_cents,
      pricePerPlayer: (Number(r.price_per_player_cents || 0) / 100),
    }));

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("availability", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Public: create booking (transaction-safe)
// -----------------------------
// POST /api/book/book
// Body: { slug, date, time, holes, players, name?, email?, phone? }
router.post("/book", async (req, res) => {
  const client = await db.connect();
  try {
    const slug = normSlug(req.body?.slug);
    const date = String(req.body?.date || "").trim();
    const time = String(req.body?.time || "").trim(); // "HH:MM"
    const holes = Number(req.body?.holes || 18);
    const players = Number(req.body?.players || 2);

    const golfer_name = req.body?.name ? String(req.body.name).trim() : null;
    const golfer_email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    const golfer_phone = req.body?.phone ? String(req.body.phone).trim() : null;

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(players) || players < 1 || players > 4)
      return res.status(400).json({ ok: false, error: "players_invalid" });

    await client.query("BEGIN");

    const c = await client.query(`SELECT id, slug, name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }
    const courseId = c.rows[0].id;

    // Lock the time row to prevent race conditions
    const t = await client.query(
      `
      SELECT id, status, max_players, price_per_player_cents
      FROM booking_times
      WHERE course_id = $1
        AND play_date = $2::date
        AND tee_time = $3
        AND holes = $4
      FOR UPDATE
      `,
      [courseId, date, time, holes]
    );

    if (!t.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "time_not_found" });
    }

    const row = t.rows[0];

    if (row.status !== "AVAILABLE") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "time_not_available" });
    }

    if (Number(row.max_players) < players) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "not_enough_capacity" });
    }

    const pricePerPlayerCents = Number(row.price_per_player_cents || 0);
    const totalCents = pricePerPlayerCents * players;

    // Optional fee model (you can change later)
    // e.g. 5 cents per player = 5
    const feePerPlayerCents = Number(process.env.BOOKING_FEE_PER_PLAYER_CENTS || 0);
    const bookingFeeCents = feePerPlayerCents * players;

    // Create reference
    const reference = makeRef("TR");

    // Insert booking
    await client.query(
      `
      INSERT INTO booking_bookings
        (course_id, play_date, tee_time, holes, players,
         golfer_name, golfer_email, golfer_phone,
         price_per_player_cents, total_cents, booking_fee_cents,
         reference, status)
      VALUES
        ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CONFIRMED')
      `,
      [
        courseId,
        date,
        time,
        holes,
        players,
        golfer_name,
        golfer_email,
        golfer_phone,
        pricePerPlayerCents,
        totalCents,
        bookingFeeCents,
        reference,
      ]
    );

    // Mark the time as booked (MVP: 1 booking per time)
    await client.query(
      `
      UPDATE booking_times
      SET status = 'BOOKED', updated_at = now()
      WHERE id = $1
      `,
      [row.id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      reference,
      course: c.rows[0].name,
      date,
      time,
      holes,
      players,
      total: totalCents / 100,
      pricePerPlayer: pricePerPlayerCents / 100,
      bookingFee: bookingFeeCents / 100,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("book POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    client.release();
  }
});

export default router;