// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";
import { Resend } from "resend";
import cookieParser from "cookie-parser"; // ✅ ADD
import { recordEvent } from "./analytics.js";

const router = express.Router();
router.use((req, res, next) => {
  console.log("📌 bookingRoutes hit:", req.method, req.originalUrl);
  next();
});

const ADMIN_SECRET = (process.env.BOOKING_ADMIN_SECRET || "").trim();
// ✅ NEW: dedicated secret for course-admin tokens (preferred)
const COURSE_ADMIN_JWT_SECRET = (process.env.COURSE_ADMIN_JWT_SECRET || "").trim();
// ✅ ALSO support normal JWT secret if you already have it set
const JWT_SECRET_FALLBACK = (process.env.JWT_SECRET || "").trim();

// ✅ ADD: visibility for course-admin token secret (Render env check)
console.log("🔐 course admin jwt env check:", {
  COURSE_ADMIN_JWT_SECRET_set: !!COURSE_ADMIN_JWT_SECRET,
  COURSE_ADMIN_JWT_SECRET_len: COURSE_ADMIN_JWT_SECRET ? COURSE_ADMIN_JWT_SECRET.length : 0,
  JWT_SECRET_set: !!JWT_SECRET_FALLBACK,
  JWT_SECRET_len: JWT_SECRET_FALLBACK ? JWT_SECRET_FALLBACK.length : 0,
  BOOKING_ADMIN_SECRET_set: !!ADMIN_SECRET,
  BOOKING_ADMIN_SECRET_len: ADMIN_SECRET ? ADMIN_SECRET.length : 0,
});

// ✅ ADD (needed): ensure JSON bodies work for ALL routes in this router
router.use(express.json());

// ✅ ADD (needed): read cookies for admin auth
router.use(cookieParser());

// ✅ ADD: prove requests are hitting THIS router (Render logs)
router.use((req, _res, next) => {
  if (req.path.startsWith("/course-admin")) {
    console.log("🟦 bookingRoutes hit", {
      method: req.method,
      path: req.path,
      host: req.headers.host,
      origin: req.headers.origin,
      xfProto: req.headers["x-forwarded-proto"],
      secure: req.secure,
      hasCookieHeader: !!req.headers.cookie,
      hasAuthHeader: !!req.headers.authorization,
      hasBypassHeader: !!req.headers["x-course-admin-key"],
      hasSlugHeader: !!req.headers["x-course-slug"],
      querySlug: req.query?.slug || null,
    });
  }
  next();
});

// ✅ Booking email (Resend)
// Support multiple env keys so Render naming mismatches don't break bookings.
const bookingFromRaw = String(
  process.env.BOOKING_EMAIL_FROM ||
    process.env.BOOKING_FROM_EMAIL ||
    process.env.BOOKING_FROM ||
    ""
).trim();

const bookingFromName = String(process.env.BOOKING_EMAIL_FROM_NAME || "TeeRadar Bookings").trim();

const bookingBcc = String(process.env.BOOKING_EMAIL_BCC || "").trim(); // optional
const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
const resend = resendApiKey ? new Resend(resendApiKey) : null;

// ✅ Startup visibility (helps confirm Render is injecting env vars into THIS service)
console.log("📧 booking email env check:", {
  hasResendKey: !!resendApiKey,
  BOOKING_EMAIL_FROM_set: !!String(process.env.BOOKING_EMAIL_FROM || "").trim(),
  BOOKING_FROM_EMAIL_set: !!String(process.env.BOOKING_FROM_EMAIL || "").trim(),
  BOOKING_FROM_set: !!String(process.env.BOOKING_FROM || "").trim(),
  bookingFromRaw_preview: bookingFromRaw ? bookingFromRaw : null,
});

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

function isHttps(req) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "");
  return req.secure || xfProto.includes("https");
}
// ✅ Cookie helpers (fix cookies not being saved cross-domain / on Render)
function cookieSameSite(req) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  const crossSite = origin && host && !origin.includes(host);
  return crossSite ? "none" : "lax";
}

function baseCookieOpts(req) {
  return {
    httpOnly: true,
    sameSite: cookieSameSite(req),
    secure: isHttps(req), // MUST be true when sameSite="none"
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}
function requirePlatformAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ ok: false, error: "BOOKING_ADMIN_SECRET not set" });
  }
  const token = String(req.cookies?.tr_book_admin || "");
  if (token !== "1") return res.status(401).json({ ok: false, error: "not_authorized" });
  return next();
}

// ✅ accept both the old and new admin generator payload shapes
function _pickAny(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) return obj[k];
  }
  return fallback;
}

// ✅ require first + last name (simple check) and a valid-ish email
function isLikelyEmail(s) {
  const v = String(s || "").trim();
  if (!v) return false;
  if (v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function hasFirstAndLastName(fullName) {
  const v = String(fullName || "").trim();
  if (!v) return false;
  const parts = v.split(/\s+/).filter(Boolean);
  return parts.length >= 2;
}

function fmtMoney(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toFixed(2)}`;
}

// ✅ Build Resend "from" safely.
function buildFrom() {
  const raw = String(bookingFromRaw || "").trim();
  if (!raw) return "";
  if (raw.includes("<") && raw.includes(">")) return raw; // already in Name <email> format
  if (isLikelyEmail(raw)) return `${bookingFromName} <${raw}>`;
  return raw; // last resort
}

// ✅ NEW: consistent client IP for analytics
function getClientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    ""
  );
}

// ✅ Booking analytics events (used by bookings analytics dashboard)
async function recordBookingEvent(req, { courseSlug, eventType, payload = {} }) {
  try {
    const slug = String(courseSlug || "").trim().toLowerCase() || null;
    const type = String(eventType || "").trim();

    if (!slug || !type) return;

    const sessionId =
      String(req.headers["x-session-id"] || "").trim() ||
      String(req.body?.sessionId || "").trim() ||
      String(req.query?.sessionId || "").trim() ||
      null;

    await db.query(
      `
      INSERT INTO booking_analytics_events
        (course_slug, event_type, occurred_at, session_id, user_agent, ip, referrer, path, payload)
      VALUES
        ($1, $2, now(), $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        slug,
        type,
        sessionId,
        String(req.headers["user-agent"] || "") || null,
        getClientIp(req) || null,
        String(req.headers["referer"] || "") || null,
        String(req.originalUrl || req.path || "") || null,
        JSON.stringify(payload || {}),
      ]
    );
  } catch (e) {
    console.warn("booking_analytics_events insert failed (non-fatal):", e?.message || e);
  }
}

// ✅ Send booking email via Resend (safe)
async function sendBookingEmail({
  to,
  courseName,
  date,
  time,
  holes,
  players,
  reference,
  pricePerPlayerCents,
  totalCents,
  cartCents,
  hireClubsCents,
}) {
  const result = { emailOk: false, emailReason: "" };

  if (!resend) {
    result.emailReason = "RESEND_API_KEY_not_set";
    return result;
  }

  const from = buildFrom();
  if (!from) {
    result.emailReason = "BOOKING_EMAIL_FROM_not_set";
    return result;
  }

  if (!isLikelyEmail(to)) {
    result.emailReason = "invalid_to_email";
    return result;
  }

  const subject = `TeeRadar booking confirmed — ${reference}`;

  const cartLine = `
    <tr><td style="padding:6px 0;color:#64748b">Cart</td><td style="padding:6px 0">${fmtMoney(cartCents || 0)}</td></tr>
  `;
  const hireClubsLine = `
    <tr><td style="padding:6px 0;color:#64748b">Hire clubs</td><td style="padding:6px 0">${fmtMoney(hireClubsCents || 0)}</td></tr>
  `;

  const extrasCents = Number(cartCents || 0) + Number(hireClubsCents || 0);

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;color:#0f172a">
      <h2 style="margin:0 0 10px">✅ Booking confirmed</h2>
      <p style="margin:0 0 12px">Reference: <b>${reference}</b></p>

      <table style="border-collapse:collapse;width:100%;max-width:520px">
        <tr><td style="padding:6px 0;color:#64748b">Course</td><td style="padding:6px 0"><b>${courseName}</b></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Date</td><td style="padding:6px 0">${date}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Time</td><td style="padding:6px 0">${time}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Players</td><td style="padding:6px 0">${players}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Holes</td><td style="padding:6px 0">${holes}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Price</td><td style="padding:6px 0">${fmtMoney(pricePerPlayerCents)} per player</td></tr>
        ${cartLine}
        ${hireClubsLine}
        <tr><td style="padding:6px 0;color:#64748b">Total</td><td style="padding:6px 0"><b>${fmtMoney(totalCents + extrasCents)}</b></td></tr>
      </table>

      <p style="margin:14px 0 0;color:#64748b;font-size:12px">
        Please screenshot or save your reference for your records.
      </p>
    </div>
  `;

  try {
    const payload = { from, to, subject, html };
    if (bookingBcc && isLikelyEmail(bookingBcc)) payload.bcc = bookingBcc;

    await resend.emails.send(payload);

    result.emailOk = true;
    result.emailReason = "";
    return result;
  } catch (e) {
    result.emailOk = false;
    result.emailReason = e?.message ? String(e.message) : "send_failed";
    return result;
  }
}

// -----------------------------
// ✅ Course admin auth helpers (PBKDF2 + tokens)
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

// ✅✅✅ Stateless course-admin token (HMAC) ✅✅✅
function _base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// ✅ FIX: strong fallback chain so tokens always work on Render
function getCourseAdminSecret() {
  const preferred = String(COURSE_ADMIN_JWT_SECRET || "").trim();
  if (preferred) return preferred;

  const jwt = String(JWT_SECRET_FALLBACK || "").trim();
  if (jwt) return crypto.createHash("sha256").update(`course-admin:${jwt}`).digest("hex");

  const fallbackBase = String(ADMIN_SECRET || "").trim();
  if (fallbackBase) return crypto.createHash("sha256").update(`course-admin:${fallbackBase}`).digest("hex");

  throw new Error("COURSE_ADMIN_SECRET_missing");
}

function makeCourseAdminToken({ slug, email }) {
  const secret = getCourseAdminSecret();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = { slug: String(slug || ""), email: String(email || ""), exp };
  const payloadB64 = _base64url(JSON.stringify(payload));
  const sig = _base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

function verifyCourseAdminToken(token) {
  try {
    const secret = getCourseAdminSecret();
    const t = String(token || "");
    const parts = t.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sig] = parts;

    const expectedSig = _base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());

    // ✅ FIX: avoid timingSafeEqual length crash
    if (sig.length !== expectedSig.length) return null;

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

    const payloadJson = Buffer.from(
      payloadB64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");

    const payload = JSON.parse(payloadJson);

    if (!payload?.slug || !payload?.email) return null;
    if (!payload?.exp || Date.now() > Number(payload.exp)) return null;

    return { slug: String(payload.slug), email: String(payload.email) };
  } catch {
    return null;
  }
}

// ✅ NEW: helper for bypass to work on BOTH fetch() and full page navigation
function getBypassProvided(req) {
  const key =
    String(req.headers["x-course-admin-key"] || "").trim() ||
    String(req.query.key || "").trim() ||
    String(req.cookies?.tr_course_admin_bypass || "").trim();

  const slug =
    String(req.headers["x-course-slug"] || "").trim().toLowerCase() ||
    String(req.query.slug || "").trim().toLowerCase() ||
    String(req.cookies?.tr_course_admin_slug || "").trim().toLowerCase();

  return { key, slug };
}

function requireCourseAdmin(req, res, next) {
  // 🔓 BYPASS MODE — enabled only if env var is set
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();

  if (bypassKey) {
    const { key: providedKey, slug } = getBypassProvided(req);

    if (providedKey && providedKey === bypassKey) {
      if (!slug || !isValidSlug(slug)) {
        return res.status(400).json({ ok: false, error: "slug_required" });
      }

      // ✅ CRITICAL FIX:
      // When bypass works via fetch headers, set cookies so
      // normal browser navigations (View bookings / Daily sheet) also work.
      res.cookie("tr_course_admin_bypass", providedKey, {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps(req),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });
      res.cookie("tr_course_admin_slug", slug, {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps(req),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
      });

      req.courseAdmin = { slug, email: "bypass@teeradar" };
      return next();
    }
  }

  // ✅ Normal mode (token/cookies)
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const bearer = m ? m[1].trim() : "";
  const token = bearer || String(req.cookies?.tr_course_admin_token || "");
  const verified = token ? verifyCourseAdminToken(token) : null;

  if (verified?.slug && verified?.email) {
    req.courseAdmin = { slug: verified.slug, email: verified.email };
    return next();
  }

  // ✅ fallback: old cookies (backwards compatible)
  const slug = String(req.cookies?.tr_course_admin_slug || "");
  const email = String(req.cookies?.tr_course_admin_email || "");
  if (!slug || !email) return res.status(401).json({ ok: false, error: "not_course_admin" });

  req.courseAdmin = { slug, email };
  return next();
}

// -----------------------------
// One-time table creation (safe)
// -----------------------------
async function ensureBookingTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_courses (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

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
    CREATE TABLE IF NOT EXISTS booking_times (
      id BIGSERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      play_date DATE NOT NULL,
      tee_time TEXT NOT NULL,
      holes INTEGER NOT NULL,
      max_players INTEGER NOT NULL DEFAULT 4,
      price_per_player_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(course_id, play_date, tee_time, holes)
    );
  `);

  await db.query(`
    ALTER TABLE booking_times
    ADD COLUMN IF NOT EXISTS booked_players INTEGER NOT NULL DEFAULT 0;
  `);

  await db.query(`
    UPDATE booking_times
    SET booked_players = 0
    WHERE booked_players IS NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_times_lookup_idx
    ON booking_times (course_id, play_date, holes, status, tee_time);
  `);

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
      booking_fee_cents INTEGER NOT NULL DEFAULT 0,
      reference TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // ✅ ADD: paid flag + cart tracking (needed for MiClub paid checkbox + analytics)
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  // ✅ ADD: add-ons pricing stored per course
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  // ✅ ADD: hire clubs stored per booking
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_hire_clubs BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_bookings_course_date_idx
    ON booking_bookings (course_id, play_date);
  `);

  // ✅ ADD: booking analytics events table (needed for recordBookingEvent)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_analytics_events (
      id BIGSERIAL PRIMARY KEY,
      course_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      session_id TEXT,
      user_agent TEXT,
      ip TEXT,
      referrer TEXT,
      path TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_analytics_events_course_time_idx
    ON booking_analytics_events (course_slug, occurred_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_analytics_events_type_time_idx
    ON booking_analytics_events (event_type, occurred_at DESC);
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

  res.cookie("tr_book_admin", "1", baseCookieOpts(req));

  res.json({ ok: true });
});

router.post("/admin/logout", (req, res) => {
  res.clearCookie("tr_book_admin", { path: "/" });
  res.json({ ok: true });
});

// -----------------------------
// ✅ Platform admin: create course admin user
// -----------------------------
router.post("/admin/course-admin", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!isLikelyEmail(email)) return res.status(400).json({ ok: false, error: "email_invalid" });
    if (password.length < 8) return res.status(400).json({ ok: false, error: "password_min_8" });

    const c = await db.query(
      `SELECT id, slug, name, cart_fee_cents, hire_clubs_fee_cents
       FROM booking_courses
       WHERE slug=$1
       LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const { saltHex, hashHex } = hashPassword(password);

    await db.query(
      `
      INSERT INTO booking_course_users (course_id, email, salt_hex, hash_hex)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (course_id, email)
      DO UPDATE SET
        salt_hex = EXCLUDED.salt_hex,
        hash_hex = EXCLUDED.hash_hex
      `,
      [courseId, email, saltHex, hashHex]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("admin/course-admin POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// ✅ Course admin login
// -----------------------------
router.post("/course-admin/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!isLikelyEmail(email) || !password) {
      return res.status(400).json({ ok: false, error: "missing_email_password" });
    }

    const { rows } = await db.query(
      `
      SELECT cu.course_id, cu.email, cu.salt_hex, cu.hash_hex, c.slug
      FROM booking_course_users cu
      JOIN booking_courses c ON c.id = cu.course_id
      WHERE lower(cu.email) = $1
      ORDER BY cu.id DESC
      LIMIT 1;
      `,
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({ ok: false, error: "invalid_login" });
    }

    const u = rows[0];
    const valid = verifyPassword(password, u.salt_hex, u.hash_hex);
    if (!valid) {
      return res.status(401).json({ ok: false, error: "invalid_login" });
    }

    // ✅ build token
    let courseAdminToken;
    try {
      courseAdminToken = makeCourseAdminToken({ slug: u.slug, email: u.email });
    } catch (err) {
      console.error("❌ token generation failed", err);
      return res.status(500).json({ ok: false, error: "token_failed" });
    }

    // ✅ IMPORTANT: cross-site safe cookies (Render / separate frontend)
    const cookieOpts = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    };

    // legacy + token cookies
    res.cookie("tr_course_admin_slug", u.slug, cookieOpts);
    res.cookie("tr_course_admin_email", u.email, cookieOpts);
    res.cookie("tr_course_admin_token", courseAdminToken, cookieOpts);

    console.log("✅ course-admin login OK", {
      email: u.email,
      slug: u.slug,
      tokenLen: courseAdminToken.length,
    });

    res.json({
      ok: true,
      slug: u.slug,
      email: u.email,
      token: courseAdminToken,
    });
  } catch (err) {
    console.error("❌ course-admin/login error", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

    const response = {
      ok: true,
      slug: u.slug,
      email: u.email,
      token: courseAdminToken,
      courseAdminToken: courseAdminToken,
      accessToken: courseAdminToken,
    };

    console.log("✅ course-admin/login OK", {
      email: u.email,
      slug: u.slug,
      isHttps: isHttps(req),
      tokenLen: courseAdminToken ? courseAdminToken.length : 0,
      keysReturned: Object.keys(response),
      usingDedicatedSecret: !!COURSE_ADMIN_JWT_SECRET,
      usingJwtFallback: !!JWT_SECRET_FALLBACK && !COURSE_ADMIN_JWT_SECRET,
      usingAdminFallback: !!ADMIN_SECRET && !COURSE_ADMIN_JWT_SECRET && !JWT_SECRET_FALLBACK,
    });

    res.json(response);
  } catch (e) {
    console.error("course-admin/login", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/course-admin/logout", async (req, res) => {
  res.clearCookie("tr_course_admin_slug", { path: "/" });
  res.clearCookie("tr_course_admin_email", { path: "/" });
  res.clearCookie("tr_course_admin_token", { path: "/" });
  res.clearCookie("tr_course_admin_bypass", { path: "/" }); // ✅ added
  res.json({ ok: true });
});

router.get("/course-admin/me", requireCourseAdmin, async (req, res) => {
  console.log("✅ course-admin/me OK", req.courseAdmin);
  res.json({ ok: true, slug: req.courseAdmin.slug, email: req.courseAdmin.email });
});

// ✅ NEW: debug route so it returns JSON (won't fall into SPA index.html)
router.get("/course-admin/_debug", (req, res) => {
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
  const provided = getBypassProvided(req);
  res.json({
    ok: true,
    router: "bookingRoutes",
    bypassEnabled: !!bypassKey,
    provided: {
      hasKey: !!provided.key,
      hasSlug: !!provided.slug,
      slug: provided.slug || null,
      from: {
        headerKey: !!String(req.headers["x-course-admin-key"] || "").trim(),
        queryKey: !!String(req.query.key || "").trim(),
        cookieKey: !!String(req.cookies?.tr_course_admin_bypass || "").trim(),
      },
    },
  });
});

// -----------------------------
// ✅ Platform admin: courses + times + bookings (existing)
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

router.delete("/admin/courses/:slug", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.params.slug);
    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });

    const r = await db.query(`DELETE FROM booking_courses WHERE slug=$1;`, [slug]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "course_not_found" });

    res.json({ ok: true, deleted: slug });
  } catch (e) {
    console.error("admin/courses DELETE", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.delete("/admin/times", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const date = req.query.date ? String(req.query.date).trim() : "";
    const holes = req.query.holes ? Number(req.query.holes) : null;

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (holes !== null && ![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    const params = [courseId];
    let q = `DELETE FROM booking_times WHERE course_id = $1`;

    if (date) {
      params.push(date);
      q += ` AND play_date = $${params.length}::date`;
    }
    if (holes !== null) {
      params.push(holes);
      q += ` AND holes = $${params.length}`;
    }

    const r = await db.query(q + `;`, params);

    res.json({
      ok: true,
      slug,
      date: date || null,
      holes: holes !== null ? holes : null,
      deletedTimes: r.rowCount || 0,
    });
  } catch (e) {
    console.error("admin/times DELETE", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/admin/generate-times", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(_pickAny(req.body, ["slug"], ""));
    const playDate = String(_pickAny(req.body, ["playDate", "date"], "") || "").trim();

    const start = String(_pickAny(req.body, ["start"], "06:00") || "06:00").trim();
    const end = String(_pickAny(req.body, ["end"], "17:00") || "17:00").trim();

    const intervalMinsRaw = _pickAny(req.body, ["intervalMins", "intervalMinutes"], 10);
    const intervalMins = Number(intervalMinsRaw);

    const holes = Number(_pickAny(req.body, ["holes"], 18));
    const maxPlayers = Number(_pickAny(req.body, ["maxPlayers"], 4));
    const pricePerPlayerCents = Number(_pickAny(req.body, ["pricePerPlayerCents"], 0));
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

    let inserted = 0;
    let skipped = 0;

    for (const t of times) {
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
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7, now())
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

// legacy endpoint - keep
router.post("/admin/times/generate", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const date = String(req.body?.date || "").trim();
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

    let upserts = 0;
    for (const t of times) {
      const r = await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7, now())
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
      SELECT id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status
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

// ✅ ADD: toggle paid flag (platform admin) — used by admin daily sheet
router.post("/admin/booking-paid", requirePlatformAdmin, async (req, res) => {
  try {
    const reference = String(req.body?.reference || "").trim();
    const paid = !!req.body?.paid;
    if (!reference) return res.status(400).json({ ok: false, error: "reference_required" });

    const r = await db.query(
      `UPDATE booking_bookings SET paid=$2 WHERE reference=$1 RETURNING reference, paid;`,
      [reference, paid]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "booking_not_found" });

    res.json({ ok: true, reference, paid });
  } catch (e) {
    console.error("admin/booking-paid", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ ADD: platform admin bookings (include paid + gross)
router.get("/admin/bookings", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const date = String(req.query.date || "").trim();

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.json({ ok: true, bookings: [] });
    const courseId = c.rows[0].id;

    const params = [courseId];
    let where = `WHERE b.course_id = $1`;
    if (date) {
      params.push(date);
      where += ` AND b.play_date = $${params.length}::date`;
    }

    const r = await db.query(
      `
      SELECT
        b.play_date::text AS play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_name AS name,
        b.golfer_email AS email,
        b.golfer_phone AS phone,
        b.reference,
        b.paid,
        b.has_cart,
        b.cart_fee_cents,
        b.has_hire_clubs,
        b.hire_clubs_fee_cents,
        (b.total_cents + b.cart_fee_cents + b.hire_clubs_fee_cents) AS gross_cents,
        b.status,
        b.created_at
      FROM booking_bookings b
      ${where}
      ORDER BY b.play_date DESC, b.tee_time ASC, b.created_at DESC
      LIMIT 500;
      `,
      params
    );

    res.json({ ok: true, bookings: r.rows || [] });
  } catch (e) {
    console.error("admin/bookings GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ NEW: Platform admin — booking analytics summary (funnel + revenue)
router.get("/admin/analytics/summary", requirePlatformAdmin, async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "7 days";

    const totals = await db.query(
      `
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM((meta->>'grossCents')::bigint), 0)::bigint AS gross_cents
      FROM analytics
      WHERE type = 'booking_created'
        AND occurred_at >= NOW() - $1::interval
      `,
      [range]
    );

    const topCourses = await db.query(
      `
      SELECT
        course_name AS "courseName",
        COUNT(*)::int AS "bookings",
        COALESCE(SUM((meta->>'grossCents')::bigint), 0)::bigint AS "grossCents"
      FROM analytics
      WHERE type = 'booking_created'
        AND occurred_at >= NOW() - $1::interval
        AND course_name IS NOT NULL AND course_name <> ''
      GROUP BY course_name
      ORDER BY COUNT(*) DESC
      LIMIT 10
      `,
      [range]
    );

    const funnel = await db.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_course_view' AND occurred_at >= NOW() - $1::interval) AS course_views,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_availability_search' AND occurred_at >= NOW() - $1::interval) AS availability_searches,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_created' AND occurred_at >= NOW() - $1::interval) AS bookings
      `,
      [range]
    );

    res.json({
      ok: true,
      days: days || 7,
      bookings: totals.rows[0]?.bookings || 0,
      grossCents: Number(totals.rows[0]?.gross_cents || 0),
      gross: Number(totals.rows[0]?.gross_cents || 0) / 100,
      funnel: funnel.rows[0] || { course_views: 0, availability_searches: 0, bookings: 0 },
      topCourses: topCourses.rows || [],
    });
  } catch (e) {
    console.error("admin booking analytics", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// ✅ Course admin endpoints
// -----------------------------
async function courseIdFromSlug(slug) {
  const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
  return c.rows.length ? c.rows[0].id : null;
}

// ✅ NEW: Course admin — booking analytics summary (scoped)
router.get("/course-admin/analytics/summary", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const days = Number(req.query.days || 7);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "7 days";

    const c = await db.query(`SELECT id, name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseName = c.rows[0].name;

    const totals = await db.query(
      `
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM((meta->>'grossCents')::bigint), 0)::bigint AS gross_cents
      FROM analytics
      WHERE type='booking_created'
        AND course_name=$1
        AND occurred_at >= NOW() - $2::interval
      `,
      [courseName, range]
    );

    const funnel = await db.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_course_view' AND course_name=$1 AND occurred_at >= NOW() - $2::interval) AS course_views,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_availability_search' AND course_name=$1 AND occurred_at >= NOW() - $2::interval) AS availability_searches,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_created' AND course_name=$1 AND occurred_at >= NOW() - $2::interval) AS bookings
      `,
      [courseName, range]
    );

    res.json({
      ok: true,
      slug,
      courseName,
      days: days || 7,
      bookings: totals.rows[0]?.bookings || 0,
      grossCents: Number(totals.rows[0]?.gross_cents || 0),
      gross: Number(totals.rows[0]?.gross_cents || 0) / 100,
      funnel: funnel.rows[0] || { course_views: 0, availability_searches: 0, bookings: 0 },
    });
  } catch (e) {
    console.error("course-admin booking analytics", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// generate times (course admin)
router.post("/course-admin/generate-times", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;

    const playDate = String(_pickAny(req.body, ["playDate", "date"], "") || "").trim();
    const start = String(_pickAny(req.body, ["start"], "06:00") || "06:00").trim();
    const end = String(_pickAny(req.body, ["end"], "17:00") || "17:00").trim();
    const intervalMins = Number(_pickAny(req.body, ["intervalMins", "intervalMinutes"], 10));
    const holes = Number(_pickAny(req.body, ["holes"], 18));
    const maxPlayers = Number(_pickAny(req.body, ["maxPlayers"], 4));
    const pricePerPlayerCents = Number(_pickAny(req.body, ["pricePerPlayerCents"], 0));
    const status = String(_pickAny(req.body, ["status"], "AVAILABLE") || "AVAILABLE").trim().toUpperCase();

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
    if (sM === null || eM === null || eM <= sM) return res.status(400).json({ ok: false, error: "time_range_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const times = [];
    for (let m = sM; m <= eM; m += intervalMins) times.push(fromMinutes(m));

    let inserted = 0;
    let skipped = 0;

    for (const t of times) {
      const exists = await db.query(
        `SELECT 1 FROM booking_times WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 LIMIT 1;`,
        [courseId, playDate, t, holes]
      );
      const isExisting = !!exists.rows.length;

      await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7, now())
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

      if (isExisting) skipped++;
      else inserted++;
    }

    res.json({ ok: true, slug, date: playDate, holes, generated: times.length, inserted, skipped });
  } catch (e) {
    console.error("course-admin/generate-times", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// view times (course admin)
router.get("/course-admin/times", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const date = String(req.query.date || "").trim();
    const holes = req.query.holes ? Number(req.query.holes) : null;

    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (holes !== null && ![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const params = [courseId, date];
    let q = `
      SELECT id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status
      FROM booking_times
      WHERE course_id = $1 AND play_date = $2::date
    `;
    if (holes) {
      params.push(holes);
      q += ` AND holes = $3`;
    }
    q += ` ORDER BY holes DESC, tee_time ASC`;

    const { rows } = await db.query(q, params);
    res.json({ ok: true, times: rows || [] });
  } catch (e) {
    console.error("course-admin/times GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// view bookings (course admin)
router.get("/course-admin/bookings", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const date = String(req.query.date || "").trim();

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const params = [courseId];
    let where = `WHERE b.course_id=$1`;
    if (date) {
      params.push(date);
      where += ` AND b.play_date=$${params.length}::date`;
    }

    const r = await db.query(
      `
      SELECT
        b.play_date::text AS play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_name AS name,
        b.golfer_email AS email,
        b.golfer_phone AS phone,
        b.reference,
        b.paid,
        b.has_cart,
        b.cart_fee_cents,
        b.has_hire_clubs,
        b.hire_clubs_fee_cents,
        (b.total_cents + b.cart_fee_cents + b.hire_clubs_fee_cents) AS gross_cents,
        b.status,
        b.created_at
      FROM booking_bookings b
      ${where}
      ORDER BY b.play_date DESC, b.tee_time ASC, b.created_at DESC
      LIMIT 800;
      `,
      params
    );

    res.json({ ok: true, bookings: r.rows || [], course_slug: slug });
  } catch (e) {
    console.error("course-admin/bookings", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// toggle paid (course admin)
router.post("/course-admin/booking-paid", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const reference = String(req.body?.reference || "").trim();
    const paid = !!req.body?.paid;
    if (!reference) return res.status(400).json({ ok: false, error: "reference_required" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const r = await db.query(
      `
      UPDATE booking_bookings
      SET paid=$3
      WHERE reference=$1 AND course_id=$2
      RETURNING reference, paid;
      `,
      [reference, courseId, paid]
    );

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "booking_not_found" });
    res.json({ ok: true, reference, paid });
  } catch (e) {
    console.error("course-admin/booking-paid", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Public course + availability + booking
// -----------------------------
router.get("/course/:slug", async (req, res) => {
  try {
    const slug = normSlug(req.params.slug);
    const { rows } = await db.query(
      `SELECT id, slug, name, notes, cart_fee_cents, hire_clubs_fee_cents
       FROM booking_courses
       WHERE slug=$1
       LIMIT 1;`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ analytics: booking course page viewed
    recordEvent({
      type: "booking_course_view",
      userId: getClientIp(req) || null,
      courseName: rows[0].name,
      meta: { slug },
    }).catch(() => {});
    recordBookingEvent(req, {
      courseSlug: slug,
      eventType: "course_view",
      payload: { slug },
    }).catch(() => {});
    res.json({ ok: true, course: rows[0] });
  } catch (e) {
    console.error("course/:slug", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

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

    // ✅ analytics: availability search
    recordEvent({
      type: "booking_availability_search",
      userId: getClientIp(req) || null,
      courseName: c.rows[0].name,
      meta: { slug, date, holes, players, earliest, latest },
    }).catch(() => {});
    recordBookingEvent(req, {
      courseSlug: slug,
      eventType: "times_view",
      payload: { slug, date, holes, players, earliest, latest },
    }).catch(() => {});
    const { rows } = await db.query(
      `
      SELECT tee_time, max_players, booked_players, holes, price_per_player_cents
      FROM booking_times
      WHERE course_id = $1
        AND play_date = $2::date
        AND holes = $3
        AND status = 'AVAILABLE'
        AND (substring(tee_time,1,2)::int*60 + substring(tee_time,4,2)::int) >= $4
        AND (substring(tee_time,1,2)::int*60 + substring(tee_time,4,2)::int) <= $5
        AND (max_players - booked_players) >= $6
      ORDER BY tee_time ASC
      LIMIT 200;
      `,
      [courseId, date, holes, sM, eM, players]
    );

    const slots = (rows || []).map((r) => ({
      time: r.tee_time,
      holes: r.holes,
      maxPlayers: r.max_players,
      bookedPlayers: r.booked_players,
      remaining: Math.max(0, Number(r.max_players || 0) - Number(r.booked_players || 0)),
      pricePerPlayerCents: r.price_per_player_cents,
      pricePerPlayer: Number(r.price_per_player_cents || 0) / 100,
    }));

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("availability", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/book", async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const date = String(req.body?.date || "").trim();
    const time = String(req.body?.time || "").trim();
    const holes = Number(req.body?.holes || 18);
    const players = Number(req.body?.players || 2);

    const golfer_name = req.body?.name ? String(req.body.name).trim() : "";
    const golfer_email = req.body?.email ? String(req.body.email).trim().toLowerCase() : "";
    const golfer_phone = req.body?.phone ? String(req.body.phone).trim() : null;

    // ✅ ADD: cart / hire clubs selection (optional)
    const has_cart = !!req.body?.hasCart;
    const has_hire_clubs = !!req.body?.hasHireClubs; // ✅ NEW

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(players) || players < 1 || players > 4)
      return res.status(400).json({ ok: false, error: "players_invalid" });

    if (!hasFirstAndLastName(golfer_name)) {
      return res.status(400).json({ ok: false, error: "name_required_first_last" });
    }
    if (!isLikelyEmail(golfer_email)) {
      return res.status(400).json({ ok: false, error: "email_required_valid" });
    }

    // ✅ FIX: load course add-on fees from DB (do NOT trust client values)
    const c = await db.query(
      `SELECT id, slug, name, cart_fee_cents, hire_clubs_fee_cents
       FROM booking_courses
       WHERE slug=$1
       LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) {
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }
    const courseId = c.rows[0].id;

    const courseCartFeeCents = Number(c.rows[0].cart_fee_cents || 0);
    const courseHireClubsFeeCents = Number(c.rows[0].hire_clubs_fee_cents || 0);

    const cart_fee_cents = has_cart ? courseCartFeeCents : 0;
    const hire_clubs_fee_cents = has_hire_clubs ? courseHireClubsFeeCents : 0;

    if (!Number.isFinite(cart_fee_cents) || cart_fee_cents < 0 || cart_fee_cents > 10000000) {
      return res.status(400).json({ ok: false, error: "cart_fee_invalid" });
    }
    if (!Number.isFinite(hire_clubs_fee_cents) || hire_clubs_fee_cents < 0 || hire_clubs_fee_cents > 10000000) {
      return res.status(400).json({ ok: false, error: "hire_clubs_fee_invalid" });
    }

    const feePerPlayerCents = Number(process.env.BOOKING_FEE_PER_PLAYER_CENTS || 0);
    const bookingFeeCents = feePerPlayerCents * players;

    const reference = makeRef("TR");

    const upd = await db.query(
      `
      UPDATE booking_times
      SET
        booked_players = booked_players + $5,
        status = CASE
          WHEN (booked_players + $5) >= max_players THEN 'BOOKED'
          ELSE status
        END,
        updated_at = now()
      WHERE course_id = $1
        AND play_date = $2::date
        AND tee_time = $3
        AND holes = $4
        AND status = 'AVAILABLE'
        AND (max_players - booked_players) >= $5
      RETURNING id, max_players, booked_players, price_per_player_cents, status;
      `,
      [courseId, date, time, holes, players]
    );

    if (!upd.rows.length) {
      const chk = await db.query(
        `
        SELECT status, max_players, booked_players
        FROM booking_times
        WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        LIMIT 1;
        `,
        [courseId, date, time, holes]
      );

      if (!chk.rows.length) return res.status(404).json({ ok: false, error: "time_not_found" });

      const r = chk.rows[0];
      if (String(r.status || "").toUpperCase() !== "AVAILABLE") {
        return res.status(409).json({ ok: false, error: "time_not_available" });
      }

      const remaining = Math.max(0, Number(r.max_players || 0) - Number(r.booked_players || 0));
      if (remaining < players) {
        return res.status(409).json({ ok: false, error: "not_enough_capacity", remaining });
      }

      return res.status(409).json({ ok: false, error: "time_not_available" });
    }

    const timeRow = upd.rows[0];
    const pricePerPlayerCents = Number(timeRow.price_per_player_cents || 0);
    const totalCents = pricePerPlayerCents * players;

    await db.query(
      `
      INSERT INTO booking_bookings
        (course_id, play_date, tee_time, holes, players,
         golfer_name, golfer_email, golfer_phone,
         price_per_player_cents, total_cents, booking_fee_cents,
         reference, status, paid,
         has_cart, cart_fee_cents,
         has_hire_clubs, hire_clubs_fee_cents)
      VALUES
        ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CONFIRMED',false,$13,$14,$15,$16)
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
        has_cart,
        cart_fee_cents,
        has_hire_clubs,
        hire_clubs_fee_cents,
      ]
    );

    // ✅✅✅ BOOKING ANALYTICS (server-side truth) ✅✅✅
    try {
      const ip = getClientIp(req);
      const userId = golfer_email || ip || null;
      const grossCents = Number(totalCents || 0) + Number(cart_fee_cents || 0) + Number(hire_clubs_fee_cents || 0);

      await recordEvent({
        type: "booking_created",
        userId,
        courseName: c.rows[0].name,
        at: new Date().toISOString(),
        meta: {
          slug,
          date,
          time,
          holes,
          players,
          reference,
          totalCents,
          cart_fee_cents,
          hire_clubs_fee_cents,
          grossCents,
          paid: false,
        },
      });

      // ✅ booking analytics dashboard event (THIS is the correct place)
      recordBookingEvent(req, {
        courseSlug: slug,
        eventType: "booking_confirmed",
        payload: {
          slug,
          date,
          time,
          holes,
          players,
          reference,
          totalCents,
          cart_fee_cents,
          hire_clubs_fee_cents,
          grossCents,
          email: golfer_email || null,
        },
      }).catch(() => {});
    } catch (err) {
      console.error("❌ booking analytics failed:", err?.message || err);
    }
    // ✅✅✅ END BOOKING ANALYTICS ✅✅✅

    const emailResult = await sendBookingEmail({
      to: golfer_email,
      courseName: c.rows[0].name,
      date,
      time,
      holes,
      players,
      reference,
      pricePerPlayerCents,
      totalCents,
      cartCents: cart_fee_cents,
      hireClubsCents: hire_clubs_fee_cents,
    });

    console.log("✅ booking created", {
      reference,
      to: golfer_email,
      emailOk: emailResult.emailOk,
      emailReason: emailResult.emailReason || null,
      fromUsed: buildFrom() || null,
    });

    res.json({
      ok: true,
      reference,
      course: c.rows[0].name,
      date,
      time,
      holes,
      players,
      total: (totalCents + cart_fee_cents + hire_clubs_fee_cents) / 100,
      pricePerPlayer: pricePerPlayerCents / 100,
      cartFee: cart_fee_cents / 100,
      hireClubsFee: hire_clubs_fee_cents / 100,
      bookingFee: bookingFeeCents / 100,
      status: timeRow.status,
      bookedPlayers: timeRow.booked_players,
      maxPlayers: timeRow.max_players,
      remaining: Math.max(0, Number(timeRow.max_players || 0) - Number(timeRow.booked_players || 0)),
      emailOk: emailResult.emailOk,
      emailReason: emailResult.emailReason || "",
    });
  } catch (e) {
    console.error("book POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;