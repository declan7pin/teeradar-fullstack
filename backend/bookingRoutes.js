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
// ✅ ADD (needed): ensure JSON bodies work for ALL routes in this router
router.use(express.json());

// ✅ ADD (needed): read cookies for admin auth
router.use(cookieParser());
const ADMIN_SECRET = (process.env.BOOKING_ADMIN_SECRET || "").trim();
// ✅ NEW: dedicated secret for course-admin tokens (preferred)
const COURSE_ADMIN_JWT_SECRET = (process.env.COURSE_ADMIN_JWT_SECRET || "").trim();
// ✅ ALSO support normal JWT secret if you already have it set
const JWT_SECRET_FALLBACK = (process.env.JWT_SECRET || "").trim();

// ✅ ADD: visibility for course-admin token secret (Render env check)
console.log("🔐 course admin env:", {
  COURSE_ADMIN_JWT_SECRET_set: !!COURSE_ADMIN_JWT_SECRET,
  JWT_SECRET_set: !!JWT_SECRET_FALLBACK,
  BOOKING_ADMIN_SECRET_set: !!ADMIN_SECRET,
});

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
function _timeToMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _minutesToTime(mins) {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function _isoDate(d) {
  // expects Date object in local server time; returns YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Monday=1 ... Sunday=7
function _weekdayISO(d) {
  const js = d.getDay(); // Sun=0 ... Sat=6
  return js === 0 ? 7 : js;
}

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
function toIsoDateTimeLocal(dateYmd, timeHhMm) {
  // stored as timestamptz, interpret date+time as local server time (Render is usually UTC)
  // If you want strict AU timezone later, we can switch to a fixed TZ approach.
  return `${dateYmd}T${timeHhMm}:00`;
}

function durationMinsForHoles(courseRow, holes) {
  const h = Number(holes || 18);
  if (h === 9) return Number(courseRow?.duration_9_mins || 210);
  return Number(courseRow?.duration_18_mins || 390);
}
// ✅ NEW: reuse existing ref for a tee time (manual slots)
async function getExistingManualRef(courseId, play_date, tee_time, holes) {
  const r = await db.query(
    `
    SELECT reference
    FROM booking_manual_slots
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND COALESCE(reference,'') <> ''
    ORDER BY updated_at DESC, id DESC
    LIMIT 1;
    `,
    [courseId, play_date, tee_time, holes]
  );
  return r.rows[0]?.reference ? String(r.rows[0].reference) : "";
}
async function countOverlappingAddonUsage(client, { courseId, startAtIso, endAtIso }) {
  // Overlap rule: existing.start < new.end AND existing.end > new.start
  const r = await client.query(
    `
    SELECT
      COALESCE(SUM(carts_used),0)::int AS carts_used,
      COALESCE(SUM(clubs_used),0)::int AS clubs_used
    FROM (
      -- confirmed online bookings
      SELECT
        COALESCE(SUM(COALESCE(cart_qty,0)),0) AS carts_used,
        COALESCE(SUM(COALESCE(hire_clubs_qty,0)),0) AS clubs_used
      FROM booking_bookings
      WHERE course_id = $1
        AND status = 'CONFIRMED'
        AND start_at IS NOT NULL
        AND end_at IS NOT NULL
        AND start_at < $3::timestamptz
        AND end_at   > $2::timestamptz

      UNION ALL

      -- manual slots that have a name filled (walk-ins / phone-ins)
      SELECT
        COALESCE(SUM(COALESCE(cart_qty,0)),0) AS carts_used,
        COALESCE(SUM(COALESCE(hire_clubs_qty,0)),0) AS clubs_used
      FROM booking_manual_slots
      WHERE course_id = $1
        AND COALESCE(name,'') <> ''
        AND start_at IS NOT NULL
        AND end_at IS NOT NULL
        AND start_at < $3::timestamptz
        AND end_at   > $2::timestamptz
    ) t
    `,
    [courseId, startAtIso, endAtIso]
  );

  return {
    cartsUsed: Number(r.rows[0]?.carts_used || 0),
    clubsUsed: Number(r.rows[0]?.clubs_used || 0),
  };
}
async function enforceAddonInventory(client, {
  courseId,
  startAtIso,
  endAtIso,
  cartQtyWanted = 0,
  hireClubsQtyWanted = 0,
}) {
  const wantedCarts = Math.max(0, Number(cartQtyWanted || 0));
  const wantedClubs = Math.max(0, Number(hireClubsQtyWanted || 0));

  // If nothing requested, nothing to enforce.
  if (wantedCarts === 0 && wantedClubs === 0) {
    return { ok: true };
  }

  // Course capacity
  const capQ = await client.query(
    `
    SELECT
      COALESCE(cart_qty,0)::int AS cart_qty,
      COALESCE(hire_clubs_qty,0)::int AS hire_clubs_qty
    FROM booking_courses
    WHERE id=$1
    LIMIT 1;
    `,
    [courseId]
  );

  const caps = capQ.rows[0] || { cart_qty: 0, hire_clubs_qty: 0 };

  // Current usage in overlap window (confirmed bookings + filled manual slots)
  const used = await countOverlappingAddonUsage(client, { courseId, startAtIso, endAtIso });

  const cartsRemaining = Math.max(0, Number(caps.cart_qty || 0) - Number(used.cartsUsed || 0));
  const clubsRemaining = Math.max(0, Number(caps.hire_clubs_qty || 0) - Number(used.clubsUsed || 0));

  if (wantedCarts > cartsRemaining || wantedClubs > clubsRemaining) {
    return {
      ok: false,
      error: "addons_unavailable",
      remaining: {
        carts: cartsRemaining,
        hireClubs: clubsRemaining,
      },
      requested: {
        carts: wantedCarts,
        hireClubs: wantedClubs,
      },
    };
  }

  return { ok: true };
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

  // ✅ allow cookie login (existing)
  const cookieToken = String(req.cookies?.tr_book_admin || "");
  if (cookieToken === "1") return next();

  // ✅ allow query/header secret (so your analytics page can work without cookies)
  const provided =
    String(req.query?.secret || "").trim() ||
    String(req.headers["x-booking-admin-secret"] || "").trim();

  if (provided && provided === ADMIN_SECRET) return next();

  return res.status(401).json({ ok: false, error: "not_authorized" });
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
// ✅ FIX: robust boolean parsing (handles "true"/"false" strings)
function parseBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(s)) return false;
  }
  return fallback;
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
  // ✅ NEW (optional): show “Manual booking” vs normal
  source = "online", // "online" | "manual"
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

  const subject =
    source === "manual"
      ? `TeeRadar manual booking confirmed — ${reference}`
      : `TeeRadar booking confirmed — ${reference}`;

  const extrasCents = Number(cartCents || 0) + Number(hireClubsCents || 0);

  const cartLine =
    Number(cartCents || 0) > 0
      ? `<tr><td style="padding:6px 0;color:#64748b">Cart</td><td style="padding:6px 0">${fmtMoney(cartCents || 0)}</td></tr>`
      : "";

  const hireClubsLine =
    Number(hireClubsCents || 0) > 0
      ? `<tr><td style="padding:6px 0;color:#64748b">Hire clubs</td><td style="padding:6px 0">${fmtMoney(hireClubsCents || 0)}</td></tr>`
      : "";

  const totalAll = Number(totalCents || 0) + extrasCents;

  const badge =
    source === "manual"
      ? `<div style="display:inline-block;background:#eef2ff;color:#3730a3;padding:4px 10px;border-radius:999px;font-size:12px;margin-bottom:10px;">Manual booking</div>`
      : "";

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;color:#0f172a">
      ${badge}
      <h2 style="margin:0 0 10px">✅ Booking confirmed</h2>
      <p style="margin:0 0 12px">Reference: <b>${reference}</b></p>

      <table style="border-collapse:collapse;width:100%;max-width:520px">
        <tr><td style="padding:6px 0;color:#64748b">Course</td><td style="padding:6px 0"><b>${courseName}</b></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Date</td><td style="padding:6px 0">${date}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Time</td><td style="padding:6px 0">${time}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Players</td><td style="padding:6px 0">${players}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Holes</td><td style="padding:6px 0">${holes}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Price</td><td style="padding:6px 0">${fmtMoney(pricePerPlayerCents || 0)} per player</td></tr>
        ${cartLine}
        ${hireClubsLine}
        <tr><td style="padding:6px 0;color:#64748b">Total</td><td style="padding:6px 0"><b>${fmtMoney(totalAll)}</b></td></tr>
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

      // ✅ When bypass works via fetch headers, set cookies so normal browser navigations also work.
      res.cookie("tr_course_admin_bypass", providedKey, baseCookieOpts(req));
      res.cookie("tr_course_admin_slug", slug, baseCookieOpts(req));

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
  CREATE TABLE IF NOT EXISTS booking_time_templates (
    course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,
    timezone TEXT NOT NULL DEFAULT 'Australia/Perth',
    template JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT now()
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
  // ✅ NEW: store the "usage window" so inventory can be checked by overlap
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;`);

  // helps overlap queries
  await db.query(`CREATE INDEX IF NOT EXISTS booking_bookings_course_window_idx ON booking_bookings (course_id, start_at, end_at);`);
  // ✅ ADD: paid flag + cart tracking (needed for MiClub paid checkbox + analytics)
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
    await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  // ✅ ADD: add-ons pricing stored per course
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  // ✅ NEW: inventory quantities + auto-release duration (minutes)
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);

  // default durations: 9 holes = 210 mins (3.5h), 18 holes = 390 mins (6.5h)
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS duration_9_mins INTEGER NOT NULL DEFAULT 210;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS duration_18_mins INTEGER NOT NULL DEFAULT 390;`);
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
  // ... your existing table/index creation above

  // ✅ Manual slot entries (walk-ins / phone-ins) for daily sheet
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_manual_slots (
      id BIGSERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      play_date DATE NOT NULL,
      tee_time TEXT NOT NULL,
      holes INTEGER NOT NULL,
      slot_index INTEGER NOT NULL, -- 1..4
      reference TEXT NOT NULL,     -- groups multiple players together (same booking colour)
      name TEXT,
      email TEXT,
      phone TEXT,
      paid BOOLEAN NOT NULL DEFAULT false,
      checked_in BOOLEAN NOT NULL DEFAULT false,
      has_cart BOOLEAN NOT NULL DEFAULT false,
      has_hire_clubs BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(course_id, play_date, tee_time, holes, slot_index)
    );
  `);
  // ✅ NEW: qty + notes for manual slots (daily sheet)
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS notes TEXT;`);
    // ✅ NEW: store window for add-on overlap checks (manual slots)
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;`);
  await db.query(`CREATE INDEX IF NOT EXISTS booking_manual_slots_course_window_idx ON booking_manual_slots (course_id, start_at, end_at);`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_manual_slots_lookup_idx
    ON booking_manual_slots (course_id, play_date, holes, tee_time);
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
       LIMIT 1;
      `,
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
// ✅ Course admin login  ✅ FIXED (this was your syntax issue)
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

    let courseAdminToken = "";
    try {
      courseAdminToken = makeCourseAdminToken({ slug: u.slug, email: u.email });
    } catch (err) {
      console.error("❌ course-admin/login token error", err);
      return res.status(500).json({ ok: false, error: "course_admin_token_failed" });
    }

    // ✅ Set cookies using your helper (handles cross-site properly)
    res.cookie("tr_course_admin_slug", String(u.slug), baseCookieOpts(req));
    res.cookie("tr_course_admin_email", String(u.email), baseCookieOpts(req));
    res.cookie("tr_course_admin_token", String(courseAdminToken), baseCookieOpts(req));

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

    return res.json(response);
  } catch (e) {
    console.error("course-admin/login", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
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
// ✅ NEW: Course admin — fetch course settings (carts/clubs qty + fees + durations)
router.get("/course-admin/course-settings", requireCourseAdmin, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
    }

    const r = await db.query(
      `
      SELECT
        slug,
        name,
        cart_fee_cents,
        cart_qty,
        hire_clubs_fee_cents,
        hire_clubs_qty,
        duration_9_mins,
        duration_18_mins
      FROM booking_courses
      WHERE slug = $1
      LIMIT 1;
      `,
      [slug]
    );

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    return res.json({ ok: true, settings: r.rows[0] });
  } catch (e) {
    console.error("course-admin/course-settings GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
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
// ✅ NEW: platform admin — update course settings (add-ons + durations)
router.post("/admin/course-settings", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });

    const cart_fee_cents = Number(req.body?.cart_fee_cents ?? 0);
    const hire_clubs_fee_cents = Number(req.body?.hire_clubs_fee_cents ?? 0);
    const cart_qty = Number(req.body?.cart_qty ?? 0);
    const hire_clubs_qty = Number(req.body?.hire_clubs_qty ?? 0);
    const duration_9_mins = Number(req.body?.duration_9_mins ?? 210);
    const duration_18_mins = Number(req.body?.duration_18_mins ?? 390);

    function okInt(n, min, max) {
      return Number.isFinite(n) && n >= min && n <= max;
    }

    if (!okInt(cart_fee_cents, 0, 10000000)) return res.status(400).json({ ok: false, error: "cart_fee_invalid" });
    if (!okInt(hire_clubs_fee_cents, 0, 10000000)) return res.status(400).json({ ok: false, error: "hire_clubs_fee_invalid" });
    if (!okInt(cart_qty, 0, 9999)) return res.status(400).json({ ok: false, error: "cart_qty_invalid" });
    if (!okInt(hire_clubs_qty, 0, 9999)) return res.status(400).json({ ok: false, error: "hire_clubs_qty_invalid" });
    if (!okInt(duration_9_mins, 30, 900)) return res.status(400).json({ ok: false, error: "duration_9_invalid" });
    if (!okInt(duration_18_mins, 30, 1200)) return res.status(400).json({ ok: false, error: "duration_18_invalid" });

    const r = await db.query(
      `
      UPDATE booking_courses
      SET
        cart_fee_cents = $2,
        cart_qty = $3,
        hire_clubs_fee_cents = $4,
        hire_clubs_qty = $5,
        duration_9_mins = $6,
        duration_18_mins = $7
      WHERE slug = $1
      RETURNING slug, name, cart_fee_cents, cart_qty, hire_clubs_fee_cents, hire_clubs_qty, duration_9_mins, duration_18_mins;
      `,
      [slug, cart_fee_cents, cart_qty, hire_clubs_fee_cents, hire_clubs_qty, duration_9_mins, duration_18_mins]
    );

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    res.json({ ok: true, course: r.rows[0] });
  } catch (e) {
    console.error("admin/course-settings POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: platform admin — fetch course settings (add-ons + durations)
router.get("/admin/course-settings", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
    }

    const r = await db.query(
      `
      SELECT
        slug,
        name,
        cart_fee_cents,
        cart_qty,
        hire_clubs_fee_cents,
        hire_clubs_qty,
        duration_9_mins,
        duration_18_mins
      FROM booking_courses
      WHERE slug = $1
      LIMIT 1;
      `,
      [slug]
    );

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ Return shape that your frontend can read safely
    return res.json({ ok: true, settings: r.rows[0] });
  } catch (e) {
    console.error("admin/course-settings GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
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
  SELECT
    t.id                     AS time_id,
    t.play_date,
    t.tee_time,
    t.holes,
    t.max_players,
    t.booked_players,
    t.price_per_player_cents,
    t.status,

    -- ✅ booking linkage (this is the fix)
    b.id                     AS booking_id,
    b.reference              AS reference,
    b.golfer_name            AS name,
    b.golfer_email           AS email,
    b.golfer_phone           AS phone,
    b.paid                   AS paid,
    b.checked_in             AS checked_in

  FROM booking_times t
  LEFT JOIN booking_bookings b
    ON b.course_id = t.course_id
   AND b.play_date  = t.play_date
   AND b.tee_time   = t.tee_time
   AND b.holes      = t.holes
   AND b.status     = 'CONFIRMED'

  WHERE t.course_id = $1
    AND t.play_date = $2::date
`;
    if (holes) {
      q += ` AND holes = $3`;
      params.push(holes);
    }
    q += ` ORDER BY tee_time ASC, holes DESC`;

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
    const paid = parseBool(req.body?.paid, false);
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
// ✅ NEW: add / upsert ONE tee time row (so it appears on the daily sheet)
// POST /api/book/admin/time
// Body: { slug, date: "YYYY-MM-DD", time: "HH:MM", holes: 9|18, maxPlayers, pricePerPlayerCents, status? }
router.post("/admin/time", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const playDate = String(req.body?.date || "").trim();      // YYYY-MM-DD
    const teeTime = String(req.body?.time || "").trim();       // HH:MM
    const holes = Number(req.body?.holes || 18);
    const maxPlayers = Number(req.body?.maxPlayers || 4);
    const pricePerPlayerCents = Number(req.body?.pricePerPlayerCents || 0);
    const status = String(req.body?.status || "AVAILABLE").trim().toUpperCase();

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(playDate)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(teeTime)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return res.status(400).json({ ok: false, error: "maxPlayers_invalid" });
    if (!Number.isFinite(pricePerPlayerCents) || pricePerPlayerCents < 0 || pricePerPlayerCents > 10000000)
      return res.status(400).json({ ok: false, error: "price_invalid" });
    if (!["AVAILABLE", "BLOCKED"].includes(status))
      return res.status(400).json({ ok: false, error: "status_invalid" });

    const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
    const courseId = c.rows[0].id;

    // ✅ Upsert the row and (important) allow BLOCKED -> AVAILABLE if admin wants
    const r = await db.query(
      `
      INSERT INTO booking_times
        (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, created_at, updated_at)
      VALUES
        ($1, $2::date, $3, $4, $5, 0, $6, $7, now(), now())
      ON CONFLICT (course_id, play_date, tee_time, holes)
      DO UPDATE SET
        max_players = EXCLUDED.max_players,
        price_per_player_cents = EXCLUDED.price_per_player_cents,
        status = CASE
          WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
          ELSE EXCLUDED.status
        END,
        updated_at = now()
      RETURNING id, play_date::text AS play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status;
      `,
      [courseId, playDate, teeTime, holes, maxPlayers, pricePerPlayerCents, status]
    );

    return res.json({ ok: true, time: r.rows[0] });
  } catch (e) {
    console.error("admin/time POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ ADD: toggle checked-in flag (platform admin) — used by admin daily sheet
router.post("/admin/booking-checkin", requirePlatformAdmin, async (req, res) => {
  try {
    const reference = String(req.body?.reference || "").trim();
    const checked_in = parseBool(req.body?.checked_in, false);
    if (!reference) return res.status(400).json({ ok: false, error: "reference_required" });

    const r = await db.query(
      `UPDATE booking_bookings SET checked_in=$2 WHERE reference=$1 RETURNING reference, checked_in;`,
      [reference, checked_in]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "booking_not_found" });

    res.json({ ok: true, reference, checked_in });
  } catch (e) {
    console.error("admin/booking-checkin", e);
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
        b.checked_in,
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

        // ✅ ADD: also return manual slots so daily sheet can render walk-ins/phone-ins
    const ms = await db.query(
      `
      SELECT
        play_date::text AS play_date,
        tee_time,
        holes,
        slot_index,
        reference,
        name,
        email,
        phone,
        paid,
        checked_in,
        has_cart,
        has_hire_clubs,
        cart_qty,
        hire_clubs_qty,
        notes,
        created_at,
        updated_at
      FROM booking_manual_slots
      WHERE course_id = $1
        ${date ? "AND play_date = $2::date" : ""}
      ORDER BY play_date DESC, tee_time ASC, holes DESC, slot_index ASC;
      `,
      date ? [courseId, date] : [courseId]
    );

    res.json({
      ok: true,
      bookings: r.rows || [],
      manualSlots: ms.rows || [], // ✅ NEW
    });
  } catch (e) {
    console.error("admin/bookings GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ NEW: Platform admin — booking analytics summary (funnel + revenue)
// Uses booking_bookings + booking_analytics_events (source of truth)
router.get("/admin/analytics/summary", requirePlatformAdmin, async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "7 days";

    // 1️⃣ BOOKINGS (ground truth)
    const bookings = await db.query(
      `
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM(total_cents + cart_fee_cents + hire_clubs_fee_cents), 0)::bigint AS gross_cents
      FROM booking_bookings
      WHERE created_at >= NOW() - $1::interval
      `,
      [range]
    );

    // 2️⃣ FUNNEL (from analytics table)
    const funnel = await db.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_course_view' AND occurred_at >= NOW() - $1::interval) AS course_views,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_availability_search' AND occurred_at >= NOW() - $1::interval) AS availability_searches,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_created' AND occurred_at >= NOW() - $1::interval) AS bookings
      `,
      [range]
    );

    // 3️⃣ TOP COURSES
    const topCourses = await db.query(
      `
      SELECT
        course_name AS "courseName",
        COUNT(*)::int AS bookings
      FROM analytics
      WHERE type='booking_created'
        AND occurred_at >= NOW() - $1::interval
        AND course_name IS NOT NULL
      GROUP BY course_name
      ORDER BY bookings DESC
      LIMIT 10
      `,
      [range]
    );

    res.json({
      ok: true,
      days,
      bookings: bookings.rows[0]?.bookings || 0,
      grossCents: Number(bookings.rows[0]?.gross_cents || 0),
      gross: Number(bookings.rows[0]?.gross_cents || 0) / 100,
      funnel: funnel.rows[0],
      topCourses: topCourses.rows || [],
    });
  } catch (e) {
    console.error("admin analytics summary", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ DEBUG: Platform admin — analytics truth check (no psql needed)
router.get("/admin/analytics/debug", requirePlatformAdmin, async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "7 days";

    // 1) booking_analytics_events (recordBookingEvent)
    const baeTotals = await db.query(
      `
      SELECT
        COUNT(*)::int AS total,
        MIN(occurred_at) AS first_at,
        MAX(occurred_at) AS last_at
      FROM booking_analytics_events
      WHERE occurred_at >= NOW() - $1::interval
      `,
      [range]
    );

    const baeTypes = await db.query(
      `
      SELECT event_type, COUNT(*)::int AS count
      FROM booking_analytics_events
      WHERE occurred_at >= NOW() - $1::interval
      GROUP BY event_type
      ORDER BY count DESC
      `,
      [range]
    );

    // 2) analytics table (recordEvent)
    const aTotals = await db.query(
      `
      SELECT
        COUNT(*)::int AS total,
        MIN(occurred_at) AS first_at,
        MAX(occurred_at) AS last_at
      FROM analytics
      WHERE occurred_at >= NOW() - $1::interval
      `,
      [range]
    );

    const aTypes = await db.query(
      `
      SELECT type, COUNT(*)::int AS count
      FROM analytics
      WHERE occurred_at >= NOW() - $1::interval
      GROUP BY type
      ORDER BY count DESC
      `,
      [range]
    );

    // 3) booking_bookings (actual bookings)
    const bTotals = await db.query(
      `
      SELECT
        COUNT(*)::int AS total,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at
      FROM booking_bookings
      WHERE created_at >= NOW() - $1::interval
      `,
      [range]
    );

    res.json({
      ok: true,
      range,
      booking_analytics_events: {
        totals: baeTotals.rows[0] || null,
        types: baeTypes.rows || [],
      },
      analytics: {
        totals: aTotals.rows[0] || null,
        types: aTypes.rows || [],
      },
      booking_bookings: {
        totals: bTotals.rows[0] || null,
      },
    });
  } catch (e) {
    console.error("admin/analytics/debug", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// ✅ Platform admin: booking analytics endpoints (for public/analytics page)
// These match the frontend calls:
// /api/book/admin/analytics/top
// /api/book/admin/analytics/bookings
// /api/book/admin/analytics/funnel
// /api/book/admin/analytics/daily
// /api/book/admin/analytics/export.csv
// -----------------------------

function _isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}
function _parseYmd(s) {
  const v = String(s || "").trim();
  if (!_isYmd(v)) return null;
  return v; // keep as YYYY-MM-DD for SQL ::date
}
function _diffDaysInclusive(startYmd, endYmd) {
  try {
    const a = new Date(startYmd + "T00:00:00Z");
    const b = new Date(endYmd + "T00:00:00Z");
    const ms = b.getTime() - a.getTime();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    return days + 1; // inclusive
  } catch {
    return null;
  }
}

async function _courseIdAndNameFromSlug(slug) {
  const s = normSlug(slug);
  if (!s) return null;
  const r = await db.query(`SELECT id, name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [s]);
  if (!r.rows.length) return null;
  return { id: r.rows[0].id, name: r.rows[0].name };
}

function _csvEscape(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// 1) TOP courses by bookings (last 30d, or within start/end if provided)
router.get("/admin/analytics/top", requirePlatformAdmin, async (req, res) => {
  try {
    const start = _parseYmd(req.query.start);
    const end = _parseYmd(req.query.end);

    // default last 30 days
    let where = `WHERE b.created_at >= NOW() - INTERVAL '30 days'`;
    const params = [];

    if (start && end) {
      params.push(start, end);
      where = `WHERE b.created_at::date BETWEEN $1::date AND $2::date`;
    } else if (start && !end) {
      params.push(start);
      where = `WHERE b.created_at::date >= $1::date`;
    } else if (!start && end) {
      params.push(end);
      where = `WHERE b.created_at::date <= $1::date`;
    }

    const q = `
      SELECT c.slug AS course_slug, COUNT(*)::int AS bookings
      FROM booking_bookings b
      JOIN booking_courses c ON c.id = b.course_id
      ${where}
      GROUP BY c.slug
      ORDER BY COUNT(*) DESC
      LIMIT 200;
    `;

    const r = await db.query(q, params);
    res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    console.error("admin/analytics/top", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// 2) Bookings counters: today / week / month (or interpret start/end as preset)
router.get("/admin/analytics/bookings", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || "");
    const start = _parseYmd(req.query.start);
    const end = _parseYmd(req.query.end);

    let courseId = null;
    if (slug) {
      const c = await _courseIdAndNameFromSlug(slug);
      if (!c) return res.json({ ok: true, bookings: { today: 0, week: 0, month: 0 } });
      courseId = c.id;
    }

    // If the UI passed a range (today/week/month buttons set the date inputs),
    // interpret it as a "preset":
    // - single day => today
    // - <= 7 days => week
    // - otherwise => month
    const wantsPreset = !!(start && end);
    const spanDays = wantsPreset ? _diffDaysInclusive(start, end) : null;

    const whereCourse = courseId ? `AND b.course_id = $1` : "";
    const p = [];
    if (courseId) p.push(courseId);

    // helpers
    async function countWhere(extraSql, extraParams = []) {
      const params = p.concat(extraParams);
      const q = `
        SELECT COUNT(*)::int AS n
        FROM booking_bookings b
        WHERE 1=1
          ${whereCourse}
          ${extraSql}
      `;
      const r = await db.query(q, params);
      return Number(r.rows[0]?.n || 0);
    }

    let today = 0, week = 0, month = 0;

    if (wantsPreset && spanDays != null) {
      // preset mode (range buttons)
      if (spanDays <= 1) {
        // TODAY preset
        today = await countWhere(`AND b.created_at::date = $${p.length + 1}::date`, [start]);
        week = 0;
        month = 0;
      } else if (spanDays <= 7) {
        // WEEK preset
        week = await countWhere(
          `AND b.created_at::date BETWEEN $${p.length + 1}::date AND $${p.length + 2}::date`,
          [start, end]
        );
        today = 0;
        month = 0;
      } else {
        // MONTH preset (or custom long range)
        month = await countWhere(
          `AND b.created_at::date BETWEEN $${p.length + 1}::date AND $${p.length + 2}::date`,
          [start, end]
        );
        today = 0;
        week = 0;
      }
    } else {
      // normal mode
      today = await countWhere(`AND b.created_at::date = CURRENT_DATE`);
      week = await countWhere(`AND b.created_at >= date_trunc('week', NOW())`);
      month = await countWhere(`AND b.created_at >= date_trunc('month', NOW())`);
    }

    res.json({ ok: true, bookings: { today, week, month } });
  } catch (e) {
    console.error("admin/analytics/bookings", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// 3) Funnel (last N days) based on EXISTING analytics events you already record
// Views  = booking_course_view
// Times  = booking_availability_search
// Started = booking_created (proxy)
// Confirmed = booking_created (same for now)
router.get("/admin/analytics/funnel", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || "");
    const days = Number(req.query.days || 30);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "30 days";

    let courseName = null;
    if (slug) {
      const c = await db.query(`SELECT name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) {
        return res.json({
          ok: true,
          funnel: { views: 0, times: 0, started: 0, confirmed: 0 },
          conversion: { view_to_confirmed: 0, times_to_confirmed: 0, started_to_confirmed: 0 },
        });
      }
      courseName = c.rows[0].name;
    }

    // Build optional course filter
    const courseFilter = courseName ? `AND course_name = $2` : "";
    const params = courseName ? [range, courseName] : [range];

    const viewsQ = await db.query(
      `
      SELECT COUNT(*)::int AS n
      FROM analytics
      WHERE type='booking_course_view'
        AND occurred_at >= NOW() - $1::interval
        ${courseFilter}
      `,
      params
    );
    const timesQ = await db.query(
      `
      SELECT COUNT(*)::int AS n
      FROM analytics
      WHERE type='booking_availability_search'
        AND occurred_at >= NOW() - $1::interval
        ${courseFilter}
      `,
      params
    );
    const confirmedQ = await db.query(
      `
      SELECT COUNT(*)::int AS n
      FROM analytics
      WHERE type='booking_created'
        AND occurred_at >= NOW() - $1::interval
        ${courseFilter}
      `,
      params
    );

    const views = Number(viewsQ.rows[0]?.n || 0);
    const times = Number(timesQ.rows[0]?.n || 0);
    const confirmed = Number(confirmedQ.rows[0]?.n || 0);

    // proxy for now (until you log a true "booking_started")
    const started = confirmed;

    const conv = {
      view_to_confirmed: views > 0 ? confirmed / views : 0,
      times_to_confirmed: times > 0 ? confirmed / times : 0,
      started_to_confirmed: started > 0 ? confirmed / started : 0,
    };

    res.json({
      ok: true,
      funnel: { views, times, started, confirmed },
      conversion: conv,
    });
  } catch (e) {
    console.error("admin/analytics/funnel", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// 4) Daily series for charts (bookings + revenue) from booking_bookings
router.get("/admin/analytics/daily", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || "");
    const start = _parseYmd(req.query.start);
    const end = _parseYmd(req.query.end);

    let courseId = null;
    if (slug) {
      const c = await _courseIdAndNameFromSlug(slug);
      if (!c) return res.json({ ok: true, rows: [] });
      courseId = c.id;
    }

    const params = [];
    let where = `WHERE 1=1`;

    if (courseId) {
      params.push(courseId);
      where += ` AND b.course_id = $${params.length}`;
    }

    if (start && end) {
      params.push(start, end);
      where += ` AND b.created_at::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    } else if (start && !end) {
      params.push(start);
      where += ` AND b.created_at::date >= $${params.length}::date`;
    } else if (!start && end) {
      params.push(end);
      where += ` AND b.created_at::date <= $${params.length}::date`;
    } else {
      // default last 30 days
      where += ` AND b.created_at >= NOW() - INTERVAL '30 days'`;
    }

    const r = await db.query(
      `
      SELECT
        b.created_at::date::text AS day,
        COUNT(*)::int AS bookings,
        COALESCE(SUM(b.total_cents + b.cart_fee_cents + b.hire_clubs_fee_cents), 0)::bigint AS revenue_cents
      FROM booking_bookings b
      ${where}
      GROUP BY b.created_at::date
      ORDER BY b.created_at::date ASC;
      `,
      params
    );

    res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    console.error("admin/analytics/daily", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// 5) CSV export of bookings (uses booking_bookings)
router.get("/admin/analytics/export.csv", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || "");
    const start = _parseYmd(req.query.start);
    const end = _parseYmd(req.query.end);

    let courseId = null;
    if (slug) {
      const c = await _courseIdAndNameFromSlug(slug);
      if (!c) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="teeradar_bookings.csv"`);
        return res.send("course_slug,created_at,play_date,tee_time,holes,players,name,email,phone,reference,paid,gross_cents\n");
      }
      courseId = c.id;
    }

    const params = [];
    let where = `WHERE 1=1`;

    if (courseId) {
      params.push(courseId);
      where += ` AND b.course_id = $${params.length}`;
    }

    if (start && end) {
      params.push(start, end);
      where += ` AND b.created_at::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    } else if (start && !end) {
      params.push(start);
      where += ` AND b.created_at::date >= $${params.length}::date`;
    } else if (!start && end) {
      params.push(end);
      where += ` AND b.created_at::date <= $${params.length}::date`;
    } else {
      where += ` AND b.created_at >= NOW() - INTERVAL '30 days'`;
    }

    const r = await db.query(
      `
      SELECT
        c.slug AS course_slug,
        b.created_at,
        b.play_date::text AS play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_name,
        b.golfer_email,
        b.golfer_phone,
        b.reference,
        b.paid,
        (b.total_cents + b.cart_fee_cents + b.hire_clubs_fee_cents)::bigint AS gross_cents
      FROM booking_bookings b
      JOIN booking_courses c ON c.id = b.course_id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT 5000;
      `,
      params
    );

    const header = [
      "course_slug","created_at","play_date","tee_time","holes","players",
      "name","email","phone","reference","paid","gross_cents"
    ].join(",");

    const lines = (r.rows || []).map(row => {
      return [
        _csvEscape(row.course_slug),
        _csvEscape(row.created_at ? new Date(row.created_at).toISOString() : ""),
        _csvEscape(row.play_date),
        _csvEscape(row.tee_time),
        _csvEscape(row.holes),
        _csvEscape(row.players),
        _csvEscape(row.golfer_name),
        _csvEscape(row.golfer_email),
        _csvEscape(row.golfer_phone),
        _csvEscape(row.reference),
        _csvEscape(row.paid ? "true" : "false"),
        _csvEscape(row.gross_cents ?? 0),
      ].join(",");
    });

    const csv = [header].concat(lines).join("\n") + "\n";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="teeradar_bookings.csv"`);
    res.send(csv);
  } catch (e) {
    console.error("admin/analytics/export.csv", e);
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
async function syncBookedPlayersForTime({ courseId, play_date, tee_time, holes }) {
  // ✅ Ensure the booking_times row exists (manual sheet can create slots before times exist)
  await db.query(
    `
    INSERT INTO booking_times
      (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, created_at, updated_at)
    VALUES
      ($1, $2::date, $3, $4, 4, 0, 0, 'AVAILABLE', now(), now())
    ON CONFLICT (course_id, play_date, tee_time, holes)
    DO NOTHING;
    `,
    [courseId, play_date, tee_time, holes]
  );

  // 1) Count manual slots filled (1 row = 1 player slot)
  const ms = await db.query(
    `
    SELECT COUNT(*)::int AS n
    FROM booking_manual_slots
    WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
      AND COALESCE(name,'') <> ''
    `,
    [courseId, play_date, tee_time, holes]
  );
  const manualCount = Number(ms.rows[0]?.n || 0);

  // 2) Count CONFIRMED booking players for same time
  const bb = await db.query(
    `
    SELECT COALESCE(SUM(players),0)::int AS n
    FROM booking_bookings
    WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
      AND status='CONFIRMED'
    `,
    [courseId, play_date, tee_time, holes]
  );
  const bookingPlayers = Number(bb.rows[0]?.n || 0);

  const totalBooked = manualCount + bookingPlayers;

  // 3) Apply to booking_times (preserve BLOCKED)
  const upd = await db.query(
    `
    UPDATE booking_times
    SET
      booked_players = $5,
      status = CASE
        WHEN booking_times.status = 'BLOCKED' THEN 'BLOCKED'
        WHEN $5 >= max_players THEN 'BOOKED'
        ELSE 'AVAILABLE'
      END,
      updated_at = now()
    WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
    RETURNING id, max_players, booked_players, status;
    `,
    [courseId, play_date, tee_time, holes, totalBooked]
  );

  return {
    manualCount,
    bookingPlayers,
    totalBooked,
    timeRow: upd.rows[0] || null,
  };
}
// -----------------------------
// ✅ Platform admin manual slots (book-admin.html)
// -----------------------------

// GET manual slots for a course + date
// /api/book/admin/manual-slots?slug=xxx&date=YYYY-MM-DD&holes=18(optional)
router.get("/admin/manual-slots", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const date = String(req.query.date || "").trim();
    const holes = req.query.holes ? Number(req.query.holes) : null;

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (holes !== null && ![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const params = [courseId, date];
    let q = `
            SELECT
        play_date::text AS play_date,
        tee_time,
        holes,
        slot_index,
        reference,
        name,
        email,
        phone,
        paid,
        checked_in,
        has_cart,
        has_hire_clubs,
        cart_qty,
        hire_clubs_qty,
        notes
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date
    `;

    if (holes !== null) {
      params.push(holes);
      q += ` AND holes = $3`;
    }

    q += ` ORDER BY tee_time ASC, holes DESC, slot_index ASC;`;

    const r = await db.query(q, params);
    res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    console.error("admin/manual-slots GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// POST upsert manual slot (platform admin)
// body: { slug, date, time, holes, slotIndex, reference?, name?, email?, phone?, paid?, checked_in?, has_cart?, has_hire_clubs? }
router.post("/admin/manual-slot", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const play_date = String(req.body?.date || "").trim();
    const tee_time = String(req.body?.time || "").trim();
    const holes = Number(req.body?.holes || 18);
    const slot_index = Number(req.body?.slotIndex || 0);

    // ✅ accept holdName aliases from frontend
const name =
  req.body?.holdName
    ? String(req.body.holdName).trim()
    : req.body?.hold_name
      ? String(req.body.hold_name).trim()
      : req.body?.name
        ? String(req.body.name).trim()
        : "";
    const email = req.body?.email ? String(req.body.email).trim() : "";
    const phone = req.body?.phone ? String(req.body.phone).trim() : "";

    const paid = parseBool(req.body?.paid, false);
    const checked_in = parseBool(req.body?.checked_in, false);
    const has_cart = parseBool(req.body?.has_cart, false);
const has_hire_clubs = parseBool(req.body?.has_hire_clubs, false);
// ✅ ADD: store quantities + notes (needed for addon overlap + daily sheet)
const cart_qty = Math.max(0, Math.min(4, Number(req.body?.cart_qty ?? req.body?.cartQty ?? 0)));
const hire_clubs_qty = Math.max(0, Math.min(4, Number(req.body?.hire_clubs_qty ?? req.body?.hireClubsQty ?? 0)));
const notes = req.body?.notes ? String(req.body.notes).trim() : "";
    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });
    // ✅ reference: reuse existing ref for this tee time if present, otherwise create one
let reference = String(req.body?.reference || "").trim();
if (!reference) {
  reference = await getExistingManualRef(courseId, play_date, tee_time, holes);
}
if (!reference) {
  reference = makeRef("MAN");
}

// ✅ compute usage window for addon overlap checks
const courseRowQ = await db.query(
  `SELECT duration_9_mins, duration_18_mins FROM booking_courses WHERE id=$1 LIMIT 1;`,
  [courseId]
);
const courseRow = courseRowQ.rows[0] || {};
const startAtIso = toIsoDateTimeLocal(play_date, tee_time);
const dur = durationMinsForHoles(courseRow, holes);
const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();
// ✅ ENFORCE add-on inventory (carts/clubs) before upsert
const inv = await enforceAddonInventory(db, {
  courseId,
  startAtIso,
  endAtIso,
  cartQtyWanted: cart_qty,
  hireClubsQtyWanted: hire_clubs_qty,
});
if (!inv.ok) {
  return res.status(409).json({ ok: false, ...inv });
}
    const r = await db.query(
      `
      INSERT INTO booking_manual_slots
  (course_id, play_date, tee_time, holes, slot_index, reference, name, email, phone,
   paid, checked_in, has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
   start_at, end_at,
   updated_at)
VALUES
  ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
   $17::timestamptz, $18::timestamptz,
   now())
ON CONFLICT (course_id, play_date, tee_time, holes, slot_index)
DO UPDATE SET
  reference = EXCLUDED.reference,
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  paid = EXCLUDED.paid,
  checked_in = EXCLUDED.checked_in,
  has_cart = EXCLUDED.has_cart,
  has_hire_clubs = EXCLUDED.has_hire_clubs,
  cart_qty = EXCLUDED.cart_qty,
  hire_clubs_qty = EXCLUDED.hire_clubs_qty,
  notes = EXCLUDED.notes,
  start_at = EXCLUDED.start_at,
  end_at = EXCLUDED.end_at,
  updated_at = now()
RETURNING *;
      `,
      [
  courseId,
  play_date,
  tee_time,
  holes,
  slot_index,
  reference,
  name || null,
  email || null,
  phone || null,
  paid,
  checked_in,
  has_cart,
  has_hire_clubs,
  cart_qty,
  hire_clubs_qty,
  notes || null,
  startAtIso,
  endAtIso,
]
    );

    const sync = await syncBookedPlayersForTime({
  courseId,
  play_date,
  tee_time,
  holes,
});

res.json({ ok: true, row: r.rows[0] || null, sync });
  } catch (e) {
    console.error("admin/manual-slot POST", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: Admin "fill slot" (click empty daily-sheet slot -> enter name/email)
// POST /api/book/admin/fill-slot
// Body: { slug, date, time, holes, slotIndex, name, email, phone?, paid?, checked_in?, cartQty?, hireClubsQty? }
router.post("/admin/fill-slot", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const play_date = String(req.body?.date || "").trim(); // MUST be YYYY-MM-DD
    const tee_time = String(req.body?.time || "").trim();
    const holes = Number(req.body?.holes || 18);
    const slot_index = Number(req.body?.slotIndex || 0);

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = req.body?.phone ? String(req.body.phone).trim() : "";

    const paid = parseBool(req.body?.paid, false);
    const checked_in = parseBool(req.body?.checked_in, false);

    // ✅ quantities + notes (accept both snake_case + camelCase)
const cart_qty = Math.max(0, Math.min(4, Number(req.body?.cart_qty ?? req.body?.cartQty ?? 0)));
const hire_clubs_qty = Math.max(0, Math.min(4, Number(req.body?.hire_clubs_qty ?? req.body?.hireClubsQty ?? 0)));
const notes = req.body?.notes ? String(req.body.notes).trim() : "";

// ✅ derive flags from qty (so SQL params always exist)
const has_cart = cart_qty > 0;
const has_hire_clubs = hire_clubs_qty > 0;
    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    // ✅ name required (allow single name for walk-ins if you want)
// If you still want first+last only, keep hasFirstAndLastName() instead.
if (!String(name || "").trim()) {
  return res.status(400).json({ ok: false, error: "name_required" });
}

// ✅ email optional — only validate if provided
if (email && !isLikelyEmail(email)) {
  return res.status(400).json({ ok: false, error: "email_invalid" });
}
    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });
const courseRowQ = await db.query(
  `SELECT duration_9_mins, duration_18_mins FROM booking_courses WHERE id=$1 LIMIT 1;`,
  [courseId]
);
const courseRow = courseRowQ.rows[0] || {};
const startAtIso = toIsoDateTimeLocal(play_date, tee_time);
const dur = durationMinsForHoles(courseRow, holes);
const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();
// ✅ ENFORCE add-on inventory (carts/clubs) before upsert
const inv = await enforceAddonInventory(db, {
  courseId,
  startAtIso,
  endAtIso,
  cartQtyWanted: cart_qty,
  hireClubsQtyWanted: hire_clubs_qty,
});
if (!inv.ok) {
  return res.status(409).json({ ok: false, ...inv });
}
    // One reference groups multiple manual slots (if you ever fill multiple slots for one booking)
    let reference = String(req.body?.reference || "").trim();

    // Upsert into booking_manual_slots
    const r = await db.query(
      `
      INSERT INTO booking_manual_slots
  (course_id, play_date, tee_time, holes, slot_index, reference, name, email, phone,
   paid, checked_in, has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
   start_at, end_at,
   updated_at)
VALUES
  ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
   $17::timestamptz, $18::timestamptz,
   now())
ON CONFLICT (course_id, play_date, tee_time, holes, slot_index)
DO UPDATE SET
  reference = EXCLUDED.reference,
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  paid = EXCLUDED.paid,
  checked_in = EXCLUDED.checked_in,
  has_cart = EXCLUDED.has_cart,
  has_hire_clubs = EXCLUDED.has_hire_clubs,
  cart_qty = EXCLUDED.cart_qty,
  hire_clubs_qty = EXCLUDED.hire_clubs_qty,
  notes = EXCLUDED.notes,
  start_at = EXCLUDED.start_at,
  end_at = EXCLUDED.end_at,
  updated_at = now()
RETURNING *;
      `,
      [
  courseId,
  play_date,
  tee_time,
  holes,
  slot_index,
  reference,
  name || null,
  email || null,
  phone || null,
  paid,
  checked_in,
  has_cart,
  has_hire_clubs,
  cart_qty,
  hire_clubs_qty,
  notes || null,
  startAtIso,
  endAtIso,
]
    );

    const sync = await syncBookedPlayersForTime({
  courseId,
  play_date,
  tee_time,
  holes,
});
    // ✅ NEW: send confirmation email when admin fills a slot (if email provided)
    try {
      if (email && isLikelyEmail(email)) {
        const courseInfo = await db.query(
          `SELECT name, cart_fee_cents, hire_clubs_fee_cents FROM booking_courses WHERE id=$1 LIMIT 1;`,
          [courseId]
        );
        const courseName = String(courseInfo.rows[0]?.name || slug);

        const cartFee = Number(courseInfo.rows[0]?.cart_fee_cents || 0);
        const clubsFee = Number(courseInfo.rows[0]?.hire_clubs_fee_cents || 0);

        const cartCents = cart_qty > 0 ? cartFee * cart_qty : 0;
        const hireClubsCents = hire_clubs_qty > 0 ? clubsFee * hire_clubs_qty : 0;

        await sendBookingEmail({
          to: email,
          courseName,
          date: play_date,
          time: tee_time,
          holes,
          players: 1,
          reference,
          pricePerPlayerCents: 0,
          totalCents: 0,
          cartCents,
          hireClubsCents,
          source: "manual",
        });
      }
    } catch (e) {
      console.warn("admin fill-slot email failed (non-fatal):", e?.message || e);
    }
return res.json({ ok: true, row: r.rows[0] || null, cart_qty, hire_clubs_qty, sync });
  } catch (e) {
    console.error("admin/fill-slot POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// DELETE manual slot (platform admin)
// /api/book/admin/manual-slot?slug=xxx&date=YYYY-MM-DD&time=HH:MM&holes=18&slotIndex=1
router.delete("/admin/manual-slot", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const play_date = String(req.query?.date || "").trim();
    const tee_time = String(req.query?.time || "").trim();
    const holes = Number(req.query?.holes || 18);
    const slot_index = Number(req.query?.slotIndex || 0);

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const r = await db.query(
      `
      DELETE FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
      `,
      [courseId, play_date, tee_time, holes, slot_index]
    );

    const sync = await syncBookedPlayersForTime({
  courseId,
  play_date,
  tee_time,
  holes,
});

res.json({ ok: true, deleted: r.rowCount || 0, sync });
  } catch (e) {
    console.error("admin/manual-slot DELETE", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
/* ✅✅✅ PASTE NEW MANUAL SLOT ROUTES HERE ✅✅✅ */

// GET manual slots for a date
router.get("/course-admin/manual-slots", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const date = String(req.query.date || "").trim();
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const r = await db.query(
      `
      SELECT
        play_date::text AS play_date,
        tee_time,
        holes,
        slot_index,
        reference,
        name,
        email,
        phone,
        paid,
        checked_in,
        has_cart,
        has_hire_clubs,
        cart_qty,
        hire_clubs_qty,
        notes
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date
      ORDER BY tee_time ASC, holes DESC, slot_index ASC;
      `,
      [courseId, date]
    );

    res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    console.error("course-admin/manual-slots GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
    
// ✅ REPLACE your existing manual-slot create route with THIS
// Supports booking multiple players by inserting multiple rows into booking_manual_slots
router.post("/course-admin/manual-slot", requireCourseAdmin, async (req, res) => {
  let client = null;
  let didBegin = false;

  try {
    const slug = req.courseAdmin.slug;

    // Accept a few body aliases so we don't break existing frontend calls
    const playDate = String(_pickAny(req.body, ["play_date", "playDate", "date"], "") || "").trim();
    const tee_time = String(_pickAny(req.body, ["tee_time", "teeTime", "time"], "") || "").trim();
    const holes = Number(_pickAny(req.body, ["holes"], 18));

    // ✅ NEW: players count (default 1, clamp 1..4)
    const playersRaw = Number(_pickAny(req.body, ["players", "numPlayers"], 1));
    const players = Math.max(1, Math.min(4, Number.isFinite(playersRaw) ? playersRaw : 1));

    const name = String(_pickAny(req.body, ["name"], "") || "").trim();
    const email = String(_pickAny(req.body, ["email"], "") || "").trim().toLowerCase();
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;

    const paid = parseBool(_pickAny(req.body, ["paid"], false), false);
    const checked_in = parseBool(_pickAny(req.body, ["checked_in", "checkedIn"], false), false);

    const has_cart = parseBool(_pickAny(req.body, ["has_cart", "hasCart"], false), false);
    const has_hire_clubs = parseBool(_pickAny(req.body, ["has_hire_clubs", "hasHireClubs"], false), false);

    // quantities (default 1 if selected)
    const cart_qty_raw = Number(_pickAny(req.body, ["cart_qty", "cartQty"], has_cart ? 1 : 0));
    const hire_clubs_qty_raw = Number(
      _pickAny(req.body, ["hire_clubs_qty", "hireClubsQty"], has_hire_clubs ? 1 : 0)
    );

    const cart_qty = Math.max(0, Math.min(4, Number.isFinite(cart_qty_raw) ? cart_qty_raw : (has_cart ? 1 : 0)));
    const hire_clubs_qty = Math.max(
      0,
      Math.min(4, Number.isFinite(hire_clubs_qty_raw) ? hire_clubs_qty_raw : (has_hire_clubs ? 1 : 0))
    );

    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    // Basic validations (keep light so we don't break existing behavior)
    if (!playDate) return res.status(400).json({ ok: false, error: "date_required" });
    if (!tee_time || !/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    client = await db.connect();
    await client.query("BEGIN");
    didBegin = true;

    // ✅ Lock this tee time manual-slot group so two admins can't collide slot_index
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [
      `manualslots:${courseId}:${playDate}:${tee_time}:${holes}`,
    ]);

    // Determine next slot_index start for this tee time
    const mx = await client.query(
      `
      SELECT COALESCE(MAX(slot_index), 0)::int AS max_slot
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4;
      `,
      [courseId, playDate, tee_time, holes]
    );

    const startIndex = Number(mx.rows[0]?.max_slot || 0) + 1;

    // Use one shared reference for the whole group
    const reference = String(_pickAny(req.body, ["reference"], "") || "").trim() || makeRef("MS");

    const insertedRows = [];

    // ✅ Insert N rows (one per player)
    for (let i = 0; i < players; i++) {
      const slot_index = startIndex + i;

      const ins = await client.query(
        `
        INSERT INTO booking_manual_slots
          (course_id, play_date, tee_time, holes, slot_index,
           reference, name, email, phone,
           paid, checked_in,
           has_cart, has_hire_clubs,
           cart_qty, hire_clubs_qty,
           notes,
           created_at, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11,
           $12, $13,
           $14, $15,
           $16,
           now(), now())
        RETURNING
          play_date::text AS play_date,
          tee_time, holes, slot_index, reference,
          name, email, phone, paid, checked_in,
          has_cart, has_hire_clubs, cart_qty, hire_clubs_qty,
          notes, created_at, updated_at;
        `,
        [
          courseId,
          playDate,
          tee_time,
          holes,
          slot_index,
          reference,
          name || null,
          email || null,
          phone || null,
          paid,
          checked_in,
          cart_qty > 0,
          hire_clubs_qty > 0,
          cart_qty,
          hire_clubs_qty,
          notes,
        ]
      );

      insertedRows.push(ins.rows[0]);
    }

    // ✅ OPTIONAL BUT RECOMMENDED:
    // If you track tee-time capacity using booking_times.booked_players,
    // increment it by "players" so availability doesn't oversell.
    // This is safe: if booking_times row doesn't exist, it does nothing.
    await client.query(
      `
      UPDATE booking_times
      SET
        booked_players = booked_players + $5,
        status = CASE
          WHEN status = 'BLOCKED' THEN 'BLOCKED'
          WHEN (booked_players + $5) >= max_players THEN 'BOOKED'
          ELSE status
        END,
        updated_at = now()
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4;
      `,
      [courseId, playDate, tee_time, holes, players]
    );

    await client.query("COMMIT");
    didBegin = false;

    return res.json({
      ok: true,
      course_slug: slug,
      play_date: playDate,
      tee_time,
      holes,
      players,
      reference,
      manualSlotsInserted: insertedRows,
    });
  } catch (e) {
    console.error("course-admin/manual-slot POST", e);

    try {
      if (client && didBegin) {
        await client.query("ROLLBACK");
        didBegin = false;
      }
    } catch (rbErr) {
      console.error("manual-slot rollback failed", rbErr);
    }

    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    try {
      if (client) client.release();
    } catch {}
  }
});

    // ✅ Course admin — add booking (alias for frontend)
// POST /api/book/course-admin/booking
router.post("/course-admin/booking", requireCourseAdmin, async (req, res) => {
  try {
    // ✅ your course-admin is always scoped to their own slug
    const slug = req.courseAdmin.slug;

    // ✅ accept multiple payload shapes
    const play_date = String(req.body?.play_date || req.body?.date || "").trim(); // YYYY-MM-DD
    const tee_time = String(req.body?.tee_time || req.body?.teeTime || req.body?.time || "").trim(); // HH:MM
    const holes = Number(req.body?.holes || 18);
    const players = Math.max(1, Math.min(4, Number(req.body?.players || 1)));

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase(); // optional
    const phone = req.body?.phone ? String(req.body.phone).trim() : "";

    const paid = parseBool(req.body?.paid, false);
const checked_in = parseBool(req.body?.checked_in, false);

const notes = req.body?.notes ? String(req.body.notes).trim() : "";
    // required
    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // Ensure tee time exists (so daily sheet renders consistently)
    await db.query(
      `
      INSERT INTO booking_times
        (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, created_at, updated_at)
      VALUES
        ($1, $2::date, $3, $4, 4, 0, 0, 'AVAILABLE', now(), now())
      ON CONFLICT (course_id, play_date, tee_time, holes)
      DO NOTHING;
      `,
      [courseId, play_date, tee_time, holes]
    );

    // Find empty slots
    const taken = await db.query(
      `
      SELECT slot_index
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        AND COALESCE(name,'') <> ''
      `,
      [courseId, play_date, tee_time, holes]
    );

    const takenSet = new Set((taken.rows || []).map((r) => Number(r.slot_index)));
    const freeSlots = [1, 2, 3, 4].filter((i) => !takenSet.has(i));

    // ✅ IMPORTANT: this block MUST close properly
    if (freeSlots.length < players) {
      return res.status(409).json({
        ok: false,
        error: "not_enough_empty_slots",
        remainingSlots: freeSlots.length,
      });
    }

    const reference = makeRef("MAN");
    const filled = [];

    for (let i = 0; i < players; i++) {
      const slot_index = freeSlots[i];

      const courseDurQ = await db.query(
        `SELECT duration_9_mins, duration_18_mins FROM booking_courses WHERE id=$1 LIMIT 1;`,
        [courseId]
      );
      const courseDurRow = courseDurQ.rows[0] || {};
      const startAtIso = toIsoDateTimeLocal(play_date, tee_time);
      const durMins = durationMinsForHoles(courseDurRow, holes);
      const endAtIso = new Date(new Date(startAtIso).getTime() + durMins * 60 * 1000).toISOString();
// ✅ ENFORCE add-on inventory (carts/clubs) before upsert
const inv = await enforceAddonInventory(db, {
  courseId,
  startAtIso,
  endAtIso,
  cartQtyWanted: 0,
  hireClubsQtyWanted: 0,
});
if (!inv.ok) {
  return res.status(409).json({ ok: false, ...inv });
}
      const r = await db.query(
        `
        INSERT INTO booking_manual_slots
          (course_id, play_date, tee_time, holes, slot_index, reference, name, email, phone,
           paid, checked_in, has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
           start_at, end_at,
           updated_at)
        VALUES
          ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17::timestamptz, $18::timestamptz,
           now())
        ON CONFLICT (course_id, play_date, tee_time, holes, slot_index)
        DO UPDATE SET
          reference = EXCLUDED.reference,
          name = EXCLUDED.name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          paid = EXCLUDED.paid,
          checked_in = EXCLUDED.checked_in,
          has_cart = EXCLUDED.has_cart,
          has_hire_clubs = EXCLUDED.has_hire_clubs,
          cart_qty = EXCLUDED.cart_qty,
          hire_clubs_qty = EXCLUDED.hire_clubs_qty,
          notes = EXCLUDED.notes,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          updated_at = now()
        RETURNING *;
        `,
        [
          courseId,
          play_date,
          tee_time,
          holes,
          slot_index,
          reference,
          name,
          email || null,
          phone || null,
          paid,
          checked_in,
          cartQty > 0,
          hireClubsQty > 0,
          cartQty,
          hireClubsQty,
          notes || null,
          startAtIso,
          endAtIso,
        ]
      );

      filled.push(r.rows[0]);
    }

    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date,
      tee_time,
      holes,
    });

    // optional confirmation email
    try {
      if (email && isLikelyEmail(email)) {
        const courseInfo = await db.query(
          `SELECT name, cart_fee_cents, hire_clubs_fee_cents FROM booking_courses WHERE id=$1 LIMIT 1;`,
          [courseId]
        );
        const courseName = String(courseInfo.rows[0]?.name || slug);

        const cartFee = Number(courseInfo.rows[0]?.cart_fee_cents || 0);
        const clubsFee = Number(courseInfo.rows[0]?.hire_clubs_fee_cents || 0);

        const cartCents = cartQty > 0 ? cartFee * cartQty : 0;
        const hireClubsCents = hireClubsQty > 0 ? clubsFee * hireClubsQty : 0;

        const ppp = 0; // you can wire this later if needed
        const totalCents = ppp * Number(players || 1);

        await sendBookingEmail({
          to: email,
          courseName,
          date: play_date,
          time: tee_time,
          holes,
          players,
          reference,
          pricePerPlayerCents: ppp,
          totalCents,
          cartCents,
          hireClubsCents,
          source: "manual",
        });
      }
    } catch (e) {
      console.warn("manual booking email failed (non-fatal):", e?.message || e);
    }

    return res.json({ ok: true, reference, rows: filled, sync });
  } catch (e) {
    console.error("course-admin/booking POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// DELETE manual slot
router.delete("/course-admin/manual-slot", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;

    const play_date = String(req.query?.date || "").trim();
    const tee_time = String(req.query?.time || "").trim();
    const holes = Number(req.query?.holes || 18);
    const slot_index = Number(req.query?.slotIndex || 0);

    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const r = await db.query(
      `
      DELETE FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
      `,
      [courseId, play_date, tee_time, holes, slot_index]
    );

    const sync = await syncBookedPlayersForTime({
  courseId,
  play_date,
  tee_time,
  holes,
});

res.json({ ok: true, deleted: r.rowCount || 0, sync });
  } catch (e) {
    console.error("course-admin/manual-slot DELETE", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: toggle PAID for MANUAL slots (course admin)
router.post("/course-admin/manual-slot-paid", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const id = req.body?.id ? Number(req.body.id) : null;
    const paid = parseBool(req.body?.paid, false);

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    let r;

    if (Number.isFinite(id) && id > 0) {
      r = await db.query(
        `UPDATE booking_manual_slots
         SET paid=$3, updated_at=now()
         WHERE id=$1 AND course_id=$2
         RETURNING id, paid;`,
        [id, courseId, paid]
      );
    } else {
      const play_date = String(req.body?.date || "").trim();
      const tee_time = String(req.body?.time || "").trim();
      const holes = Number(req.body?.holes || 18);
      const slot_index = Number(req.body?.slotIndex || 0);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
      if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
      if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
      if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4)
        return res.status(400).json({ ok: false, error: "slotIndex_invalid" });

      r = await db.query(
        `UPDATE booking_manual_slots
         SET paid=$6, updated_at=now()
         WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
         RETURNING id, paid;`,
        [courseId, play_date, tee_time, holes, slot_index, paid]
      );
    }

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "manual_slot_not_found" });
    return res.json({ ok: true, id: r.rows[0].id, paid: r.rows[0].paid });
  } catch (e) {
    console.error("course-admin/manual-slot-paid POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ NEW: toggle CHECKED-IN for MANUAL slots (course admin)
router.post("/course-admin/manual-slot-checkin", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const id = req.body?.id ? Number(req.body.id) : null;
    const checked_in = parseBool(req.body?.checked_in, false);

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    let r;

    if (Number.isFinite(id) && id > 0) {
      r = await db.query(
        `UPDATE booking_manual_slots
         SET checked_in=$3, updated_at=now()
         WHERE id=$1 AND course_id=$2
         RETURNING id, checked_in;`,
        [id, courseId, checked_in]
      );
    } else {
      const play_date = String(req.body?.date || "").trim();
      const tee_time = String(req.body?.time || "").trim();
      const holes = Number(req.body?.holes || 18);
      const slot_index = Number(req.body?.slotIndex || 0);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
      if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
      if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
      if (!Number.isFinite(slot_index) || slot_index < 1 || slot_index > 4)
        return res.status(400).json({ ok: false, error: "slotIndex_invalid" });

      r = await db.query(
        `UPDATE booking_manual_slots
         SET checked_in=$6, updated_at=now()
         WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
         RETURNING id, checked_in;`,
        [courseId, play_date, tee_time, holes, slot_index, checked_in]
      );
    }

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "manual_slot_not_found" });
    return res.json({ ok: true, id: r.rows[0].id, checked_in: r.rows[0].checked_in });
  } catch (e) {
    console.error("course-admin/manual-slot-checkin POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
/* ✅✅✅ END NEW MANUAL SLOT ROUTES ✅✅✅ */

// GET current template for course
router.get("/course-template", requireCourseAdmin, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });

    const c = await db.query(
      `SELECT id, slug, name FROM booking_courses WHERE slug = $1 LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = c.rows[0].id;

    const t = await db.query(
      `SELECT timezone, template, updated_at
       FROM booking_time_templates
       WHERE course_id = $1
       LIMIT 1;`,
      [courseId]
    );

    if (!t.rows.length) {
      return res.json({
        ok: true,
        course: c.rows[0],
        timezone: "Australia/Perth",
        template: {},
        updated_at: null,
        found: false,
      });
    }

    return res.json({
      ok: true,
      course: c.rows[0],
      timezone: t.rows[0].timezone,
      template: t.rows[0].template || {},
      updated_at: t.rows[0].updated_at,
      found: true,
    });
  } catch (err) {
    console.error("GET /course-template error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// PUT save template for course
router.put("/course-template", requireCourseAdmin, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    const timezone = String(req.body?.timezone || "Australia/Perth").trim() || "Australia/Perth";
    const template =
  req.body?.template && typeof req.body.template === "object"
    ? req.body.template
    : null;

    if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });
    if (!template) return res.status(400).json({ ok: false, error: "template_required" });

    const c = await db.query(
      `SELECT id, slug, name FROM booking_courses WHERE slug = $1 LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = c.rows[0].id;

    await db.query(
      `INSERT INTO booking_time_templates (course_id, timezone, template, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (course_id)
       DO UPDATE SET timezone = EXCLUDED.timezone, template = EXCLUDED.template, updated_at = now();`,
      [courseId, timezone, JSON.stringify(template)]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /course-template error:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});

// POST generate times from saved template
// Body: { slug, startDate, daysAhead, mode }
// mode: "skip" (default) OR "overwrite-range"
router.post("/generate-from-template", requireCourseAdmin, async (req, res) => {
  try {
    const slug = String(req.body?.slug || "").trim().toLowerCase();
    const startDate = String(req.body?.startDate || "").trim(); // YYYY-MM-DD
    const daysAhead = Math.max(1, Math.min(120, Number(req.body?.daysAhead || 30)));
    const mode = String(req.body?.mode || "skip").trim().toLowerCase();

    if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });
    if (!startDate) return res.status(400).json({ ok: false, error: "startDate_required" });

    const c = await db.query(
      `SELECT id, slug, name FROM booking_courses WHERE slug = $1 LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = c.rows[0].id;

    const t = await db.query(
      `SELECT template
       FROM booking_time_templates
       WHERE course_id = $1
       LIMIT 1;`,
      [courseId]
    );
    if (!t.rows.length) return res.status(400).json({ ok: false, error: "no_template_saved" });

    const template = t.rows[0].template || {};
    const daysCfg = template.days || {}; // expects keys "1".."7"

    // Parse startDate safely
    const m = startDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return res.status(400).json({ ok: false, error: "startDate_invalid" });

    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(start.getTime())) return res.status(400).json({ ok: false, error: "startDate_invalid" });

    const end = new Date(start);
    end.setDate(end.getDate() + daysAhead);

    // Optional overwrite range
    if (mode === "overwrite-range") {
      await db.query(
        `DELETE FROM booking_times
         WHERE course_id = $1
           AND play_date >= $2::date
           AND play_date < $3::date;`,
        [courseId, startDate, _isoDate(end)]
      );
    }

    let inserted = 0;
    let skipped = 0;

    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const playDate = _isoDate(d);
      const wd = String(_weekdayISO(d)); // "1".."7"
      const cfg = daysCfg[wd];

      if (!cfg || cfg.enabled === false) continue;

      const windows = Array.isArray(cfg.windows) ? cfg.windows : [];
      for (const w of windows) {
        const holes = Number(w.holes);
        const interval = Number(w.intervalMins || w.interval || 10);
        const maxPlayers = Number(w.maxPlayers || 4);
        const pricePerPlayerCents = Number(w.pricePerPlayerCents || w.price_per_player_cents || 0);

        const startMin = _timeToMinutes(w.start);
        const endMin = _timeToMinutes(w.end);

        if (![9, 18].includes(holes)) continue;
        if (!Number.isFinite(interval) || interval < 5 || interval > 60) continue;
        if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4) continue;
        if (!Number.isFinite(pricePerPlayerCents) || pricePerPlayerCents < 0) continue;
        if (startMin === null || endMin === null || endMin <= startMin) continue;

        for (let mins = startMin; mins < endMin; mins += interval) {
          const teeTime = _minutesToTime(mins);

          const r = await db.query(
            `INSERT INTO booking_times (
              course_id, play_date, tee_time, holes,
              max_players, price_per_player_cents,
              status, created_at, updated_at
            )
            VALUES ($1, $2::date, $3, $4, $5, $6, 'AVAILABLE', now(), now())
            ON CONFLICT (course_id, play_date, tee_time, holes) DO NOTHING;`,
            [courseId, playDate, teeTime, holes, maxPlayers, pricePerPlayerCents]
          );

          if (r.rowCount === 1) inserted += 1;
          else skipped += 1;
        }
      }
    }

    return res.json({
      ok: true,
      course: c.rows[0],
      startDate,
      daysAhead,
      mode,
      inserted,
      skipped,
    });
  } catch (err) {
    console.error("POST /generate-from-template error:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});
// ✅ NEW: Course admin — booking analytics summary (scoped)
// Uses booking_bookings + booking_analytics_events (source of truth)
router.get("/course-admin/analytics/summary", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const days = Number(req.query.days || 7);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "7 days";

    const c = await db.query(`SELECT id, name FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = c.rows[0].id;
    const courseName = c.rows[0].name;

    const totals = await db.query(
      `
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM(
          COALESCE(total_cents,0)
          + COALESCE(cart_fee_cents,0)
          + COALESCE(hire_clubs_fee_cents,0)
        ), 0)::bigint AS gross_cents
      FROM booking_bookings
      WHERE course_id = $1
        AND created_at >= NOW() - $2::interval
      `,
      [courseId, range]
    );

    const funnel = await db.query(
      `
      SELECT
        (SELECT COUNT(*)::int
         FROM booking_analytics_events
         WHERE course_slug=$1
           AND event_type='course_view'
           AND occurred_at >= NOW() - $2::interval) AS course_views,

        (SELECT COUNT(*)::int
         FROM booking_analytics_events
         WHERE course_slug=$1
           AND event_type='times_view'
           AND occurred_at >= NOW() - $2::interval) AS availability_searches,

        (SELECT COUNT(*)::int
         FROM booking_analytics_events
         WHERE course_slug=$1
           AND event_type='booking_confirmed'
           AND occurred_at >= NOW() - $2::interval) AS bookings
      `,
      [slug, range]
    );

    const grossCents = Number(totals.rows[0]?.gross_cents || 0);

    res.json({
      ok: true,
      slug,
      courseName,
      days: days || 7,
      bookings: totals.rows[0]?.bookings || 0,
      grossCents,
      gross: grossCents / 100,
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
    q += ` ORDER BY tee_time ASC, holes DESC`;

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
        b.checked_in,
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

        // ✅ ADD: manual slots for course-admin daily sheet
    const ms = await db.query(
      `
      SELECT
        play_date::text AS play_date,
        tee_time,
        holes,
        slot_index,
        reference,
        name,
        email,
        phone,
        paid,
        checked_in,
        has_cart,
        has_hire_clubs,
        cart_qty,
        hire_clubs_qty,
        notes,
        created_at,
        updated_at
      FROM booking_manual_slots
      WHERE course_id = $1
        ${date ? "AND play_date = $2::date" : ""}
      ORDER BY play_date DESC, tee_time ASC, holes DESC, slot_index ASC;
      `,
      date ? [courseId, date] : [courseId]
    );

    res.json({
      ok: true,
      bookings: r.rows || [],
      manualSlots: ms.rows || [], // ✅ NEW
      course_slug: slug,
    });
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
    const paid = parseBool(req.body?.paid, false);
    if (!reference) return res.status(400).json({ ok: false, error: "reference_required" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // 1) Try real bookings table first
let r = await db.query(
  `
  UPDATE booking_bookings
  SET paid=$3
  WHERE reference=$1 AND course_id=$2
  RETURNING reference, paid;
  `,
  [reference, courseId, paid]
);

// 2) If not found, try manual slots table
if (!r.rows.length) {
  r = await db.query(
    `
    UPDATE booking_manual_slots
    SET paid=$3, updated_at=now()
    WHERE reference=$1 AND course_id=$2
    RETURNING reference, paid;
    `,
    [reference, courseId, paid]
  );
}

if (!r.rows.length) return res.status(404).json({ ok: false, error: "booking_not_found" });
res.json({ ok: true, reference, paid });
  } catch (e) {
    console.error("course-admin/booking-paid", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ ADD: toggle checked-in flag (course admin)
router.post("/course-admin/booking-checkin", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const reference = String(req.body?.reference || "").trim();
    const checked_in = parseBool(req.body?.checked_in, false);
    if (!reference) return res.status(400).json({ ok: false, error: "reference_required" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // 1) Try real bookings table first
let r = await db.query(
  `
  UPDATE booking_bookings
  SET checked_in=$3
  WHERE reference=$1 AND course_id=$2
  RETURNING reference, checked_in;
  `,
  [reference, courseId, checked_in]
);

// 2) If not found, try manual slots table
if (!r.rows.length) {
  r = await db.query(
    `
    UPDATE booking_manual_slots
    SET checked_in=$3, updated_at=now()
    WHERE reference=$1 AND course_id=$2
    RETURNING reference, checked_in;
    `,
    [reference, courseId, checked_in]
  );
}

if (!r.rows.length) return res.status(404).json({ ok: false, error: "booking_not_found" });
res.json({ ok: true, reference, checked_in });
  } catch (e) {
    console.error("course-admin/booking-checkin", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// -----------------------------
// Public course + availability + booking
// -----------------------------
// -----------------------------
// ✅ Public: course add-ons (for book-course.html dynamic add-ons UI)
// GET /api/book/addons?slug=COURSE
// Returns "cart" + "hire_clubs" add-ons derived from booking_courses columns.
// -----------------------------
router.get("/addons", async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
    }

    const c = await db.query(
      `
      SELECT
        slug, name,
        cart_fee_cents, hire_clubs_fee_cents,
        cart_qty, hire_clubs_qty
      FROM booking_courses
      WHERE slug=$1
      LIMIT 1;
      `,
      [slug]
    );

    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const row = c.rows[0];

    const addons = [];

    // Show Cart add-on if course has any cart setup (fee or qty)
    if (Number(row.cart_fee_cents || 0) > 0 || Number(row.cart_qty || 0) > 0) {
      addons.push({
        id: "cart",
        label: "Cart",
        price_cents: Number(row.cart_fee_cents || 0),
        per_player: false,
        active: true,
      });
    }

    // Show Hire Clubs add-on if course has any clubs setup (fee or qty)
    if (Number(row.hire_clubs_fee_cents || 0) > 0 || Number(row.hire_clubs_qty || 0) > 0) {
      addons.push({
        id: "hire_clubs",
        label: "Hire clubs",
        price_cents: Number(row.hire_clubs_fee_cents || 0),
        per_player: false,
        active: true,
      });
    }

    return res.json({ ok: true, addons });
  } catch (e) {
    console.error("addons GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
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
const c = await db.query(`
  SELECT id, slug, name, cart_qty, hire_clubs_qty, duration_9_mins, duration_18_mins
  FROM booking_courses
  WHERE slug=$1
  LIMIT 1;
`, [slug]);

if (!c.rows.length) return res.status(404).json({ ok:false, error:"course_not_found" });
    const courseRow = c.rows[0];
const courseId = courseRow.id;

// ✅ FIX: define these in THIS scope (used later below)
const courseName = String(courseRow.name || "");
const courseCartQty = Number(courseRow.cart_qty || 0);
const courseHireClubsQty = Number(courseRow.hire_clubs_qty || 0);

// ✅ duration window helpers (used for add-on overlap checks)
const durationMins = durationMinsForHoles(courseRow, holes);

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

    const slots = await Promise.all(
      (rows || []).map(async (r) => {
        const startAtIso = toIsoDateTimeLocal(date, r.tee_time);
        const dur = durationMinsForHoles(courseRow, r.holes);
        const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();
// ✅ ENFORCE add-on inventory (carts/clubs) before upsert
const inv = await enforceAddonInventory(db, {
  courseId,
  startAtIso,
  endAtIso,
  cartQtyWanted: cart_qty,
  hireClubsQtyWanted: hire_clubs_qty,
});
if (!inv.ok) {
  return res.status(409).json({ ok: false, ...inv });
}
        const { cartsUsed, clubsUsed } = await countOverlappingAddonUsage(client, {
  courseId,
  startAtIso,
  endAtIso,
});

        const cartRemaining = Math.max(0, courseCartQty - cartsUsed);
const clubsRemaining = Math.max(0, courseHireClubsQty - clubsUsed);

return {
  time: r.tee_time,
  holes: r.holes,
  maxPlayers: r.max_players,
  bookedPlayers: r.booked_players,
  remaining: Math.max(0, Number(r.max_players || 0) - Number(r.booked_players || 0)),
  pricePerPlayerCents: r.price_per_player_cents,
  pricePerPlayer: Number(r.price_per_player_cents || 0) / 100,

  // ✅ add-on availability
  cartRemaining,
  clubsRemaining,
  cartSoldOut: courseCartQty > 0 && cartRemaining <= 0,
  clubsSoldOut: courseHireClubsQty > 0 && clubsRemaining <= 0,
  cartQty: courseCartQty,
  clubsQty: courseHireClubsQty,
  durationMins: dur,
};
      })
    );

    res.json({ ok: true, slots });
  } catch (e) {
    console.error("availability", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: per-slot transaction lock key (prevents race + addon oversell)
function advisoryKeyForSlot({ courseId, dateYmd, timeHhMm }) {
  // key = courseId * 10^12 + yyyymmdd * 10^4 + minutes
  const ymdNum = Number(String(dateYmd || "").replace(/-/g, ""));
  const mins = toMinutes(timeHhMm);
  if (!Number.isFinite(ymdNum) || mins === null) return null;

  const key =
    BigInt(courseId) * 1000000000000n +
    BigInt(ymdNum) * 10000n +
    BigInt(mins);

  return key.toString(); // pass as string to pg bigint
}
async function advisoryLockForSlot(client, { courseId, dateYmd, timeHhMm }) {
  const key = advisoryKeyForSlot({ courseId, dateYmd, timeHhMm });
  if (!key) return null;
  // pg_advisory_xact_lock is released automatically on COMMIT/ROLLBACK
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint);`, [key]);
  return key;
}
router.post("/book", async (req, res) => {
  let client = null;
  let didBegin = false;

  try {
    client = await db.connect();
    const slug = normSlug(req.body?.slug);
    const date = String(req.body?.date || "").trim();
    const time = String(req.body?.time || "").trim();
    const holes = Number(req.body?.holes || 18);
    const players = Number(req.body?.players || 2);

    const golfer_name = req.body?.name ? String(req.body.name).trim() : "";
    const golfer_email = req.body?.email ? String(req.body.email).trim().toLowerCase() : "";
    const golfer_phone = req.body?.phone ? String(req.body.phone).trim() : null;

    // ✅ cart / hire clubs selection (optional)
// Accept either:
// - addonIds: ["cart","hire_clubs"]
// - booleans: has_cart / has_hire_clubs
// - optional quantities: cartQty / hireClubsQty (or snake_case)
const addonIds = Array.isArray(req.body?.addonIds)
  ? req.body.addonIds.map((x) => String(x))
  : [];

const picked = new Set(
  addonIds.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
);

// addonIds wins, but booleans still supported
const has_cart =
  picked.size > 0 ? picked.has("cart") : parseBool(req.body?.has_cart, false);

const has_hire_clubs =
  picked.size > 0 ? picked.has("hire_clubs") : parseBool(req.body?.has_hire_clubs, false);

// quantities (default 1 if selected, clamp 0..4)
const cart_qty_raw = Number(
  req.body?.cart_qty ?? req.body?.cartQty ?? (has_cart ? 1 : 0)
);
const hire_clubs_qty_raw = Number(
  req.body?.hire_clubs_qty ?? req.body?.hireClubsQty ?? (has_hire_clubs ? 1 : 0)
);

const cart_qty = Math.max(
  0,
  Math.min(4, Number.isFinite(cart_qty_raw) ? cart_qty_raw : (has_cart ? 1 : 0))
);

const hire_clubs_qty = Math.max(
  0,
  Math.min(
    4,
    Number.isFinite(hire_clubs_qty_raw)
      ? hire_clubs_qty_raw
      : (has_hire_clubs ? 1 : 0)
  )
);

// final derived flags (qty can force false)
const final_has_cart = cart_qty > 0;
const final_has_hire_clubs = hire_clubs_qty > 0;
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

    // ✅ Load course (includes addon qty + durations)
    const c = await client.query(
      `
      SELECT id, slug, name, notes,
        cart_fee_cents, hire_clubs_fee_cents,
        cart_qty, hire_clubs_qty,
        duration_9_mins, duration_18_mins
      FROM booking_courses
      WHERE slug=$1
      LIMIT 1;
      `,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseRow = c.rows[0];
    const courseId = courseRow.id;
// ✅ begin transaction + lock this specific slot to prevent double-book + addon oversell
await client.query("BEGIN");
didBegin = true;

// lock per-slot (course+date+time). If two people try same tee time, one waits.
await advisoryLockForSlot(client, { courseId, dateYmd: date, timeHhMm: time });

// ✅ NEW: lock addon inventory per course BEFORE any overlap counting / enforcement
await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [
  `addons:${courseId}`,
]);

// ✅ compute booking window (needed for addon overlap inventory checks)
let startAtIso = toIsoDateTimeLocal(date, time);
const dur = durationMinsForHoles(courseRow, holes);
const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();
// ✅ check addon overlap usage (confirmed bookings + filled manual slots)
const courseCartQty = Number(courseRow.cart_qty || 0);
const courseClubsQty = Number(courseRow.hire_clubs_qty || 0);
// ✅ NEW: if course doesn't offer the addon (qty=0), block selecting it
if (cart_qty > 0 && courseCartQty <= 0) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(400).json({ ok: false, error: "cart_not_offered" });
}

if (hire_clubs_qty > 0 && courseClubsQty <= 0) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(400).json({ ok: false, error: "hire_clubs_not_offered" });
}
const { cartsUsed, clubsUsed } = await countOverlappingAddonUsage(client, {
  courseId,
  startAtIso,
  endAtIso,
});

const cartRemaining = Math.max(0, courseCartQty - cartsUsed);
const clubsRemaining = Math.max(0, courseClubsQty - clubsUsed);

// if course has inventory configured (>0), enforce it
if (cart_qty > 0 && courseCartQty > 0 && cart_qty > cartRemaining) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(409).json({
    ok: false,
    error: "cart_sold_out",
    cartRemaining,
  });
}

if (hire_clubs_qty > 0 && courseClubsQty > 0 && hire_clubs_qty > clubsRemaining) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(409).json({
    ok: false,
    error: "hire_clubs_sold_out",
    clubsRemaining,
  });
}
    const courseCartFeeCents = Number(courseRow.cart_fee_cents || 0);
const courseHireClubsFeeCents = Number(courseRow.hire_clubs_fee_cents || 0);

// charge per unit (qty). if you want “per booking” instead, keep your old version.
const cart_fee_cents = cart_qty > 0 ? courseCartFeeCents * cart_qty : 0;
const hire_clubs_fee_cents = hire_clubs_qty > 0 ? courseHireClubsFeeCents * hire_clubs_qty : 0;

    if (!Number.isFinite(cart_fee_cents) || cart_fee_cents < 0 || cart_fee_cents > 10000000) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(400).json({ ok: false, error: "cart_fee_invalid" });
}

if (!Number.isFinite(hire_clubs_fee_cents) || hire_clubs_fee_cents < 0 || hire_clubs_fee_cents > 10000000) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(400).json({ ok: false, error: "hire_clubs_fee_invalid" });
}

    // 1) Lock the booking_times row for this slot
    const t = await client.query(
      `
      SELECT id, max_players, booked_players, price_per_player_cents, status
      FROM booking_times
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
      LIMIT 1
      FOR UPDATE;
      `,
      [courseId, date, time, holes]
    );

    if (!t.rows.length) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(404).json({ ok: false, error: "time_not_found" });
}

    const timeRow = t.rows[0];

    if (String(timeRow.status || "").toUpperCase() !== "AVAILABLE") {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(409).json({ ok: false, error: "time_not_available" });
}

    const maxPlayers = Number(timeRow.max_players || 0);
    const bookedPlayers = Number(timeRow.booked_players || 0);

    if (players > (maxPlayers - bookedPlayers)) {
  await client.query("ROLLBACK");
  didBegin = false;
  return res.status(409).json({ ok: false, error: "not_enough_spots" });
}


    // 3) Price calc
const ppp = Number(timeRow.price_per_player_cents || 0);
const baseTotalCents = ppp * players;

// add-ons are per-booking (not per-player) in your schema
const addonsCents =
  (cart_qty > 0 ? cart_fee_cents : 0) +
  (hire_clubs_qty > 0 ? hire_clubs_fee_cents : 0);

// ✅ store full total in DB
const totalCents = baseTotalCents + addonsCents;
const reference = makeRef("TR");

    // 4) Insert booking
    const ins = await client.query(
      `
      INSERT INTO booking_bookings
        (course_id, play_date, tee_time, holes, players,
         golfer_name, golfer_email, golfer_phone,
         price_per_player_cents, total_cents, reference, status,
         start_at, end_at,
         paid, checked_in,
         has_cart, cart_qty, cart_fee_cents,
         has_hire_clubs, hire_clubs_qty, hire_clubs_fee_cents,
         created_at)
      VALUES
        ($1,$2::date,$3,$4,$5,
         $6,$7,$8,
         $9,$10,$11,'CONFIRMED',
         $12::timestamptz,$13::timestamptz,
         false,false,
         $14,$15,$16,
         $17,$18,$19,
         now())
      RETURNING id, reference;
      `,
      [
        courseId,
        date,
        time,
        holes,
        players,
        golfer_name || null,
        golfer_email || null,
        golfer_phone || null,
        ppp,
        totalCents,
        reference,
        startAtIso,
        endAtIso,
        cart_qty > 0,
        cart_qty,
        cart_fee_cents,
        hire_clubs_qty > 0,
        hire_clubs_qty,
        hire_clubs_fee_cents,
      ]
    );

    // 5) Update booking_times booked_players + status
    const newBooked = bookedPlayers + players;

    await client.query(
      `
      UPDATE booking_times
      SET
        booked_players = $5,
        status = CASE
          WHEN status = 'BLOCKED' THEN 'BLOCKED'
          WHEN $5 >= max_players THEN 'BOOKED'
          ELSE 'AVAILABLE'
        END,
        updated_at = now()
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4;
      `,
      [courseId, date, time, holes, newBooked]
    );

    // 6) Commit
    await client.query("COMMIT");
didBegin = false;

    // ✅ analytics
    recordEvent({
      type: "booking_created",
      userId: getClientIp(req) || null,
      courseName: courseRow.name,
      meta: { slug, date, time, holes, players, reference, cart_qty, hire_clubs_qty },
    }).catch(() => {});
    recordBookingEvent(req, {
      courseSlug: slug,
      eventType: "booking_confirmed",
      payload: { slug, date, time, holes, players, reference, cart_qty, hire_clubs_qty },
    }).catch(() => {});

    // 7) Email (non-fatal)
    const emailResult = await sendBookingEmail({
      to: golfer_email,
      courseName: courseRow.name,
      date,
      time,
      holes,
      players,
      reference,
      pricePerPlayerCents: ppp,
      totalCents: totalCents,
      cartCents: cart_fee_cents,
      hireClubsCents: hire_clubs_fee_cents,
    });

    return res.json({
      ok: true,
      reference,
      course: { slug: courseRow.slug, name: courseRow.name },
      booking: {
        date,
        time,
        holes,
        players,
        pricePerPlayerCents: ppp,
        totalCents,
        addonsCents,
        cart_qty,
        hire_clubs_qty,
      },
      emailOk: emailResult.emailOk,
      emailReason: emailResult.emailReason || null,
    });
  } catch (e) {
  console.error("book POST", e);

  try {
    if (client && didBegin) {
      await client.query("ROLLBACK");
      didBegin = false;
    }
  } catch (rbErr) {
    console.error("book POST rollback failed", rbErr);
  }

  return res.status(500).json({ ok: false, error: "internal_error" });
} finally {
  try {
    if (client) client.release();
  } catch {}
}
});
// ✅ NEW: Booking Analytics (uses real bookings + existing analytics table)
router.get("/admin/booking-analytics/summary", requirePlatformAdmin, async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const range = Number.isFinite(days) && days > 0 ? `${days} days` : "30 days";

    // --- bookings counts ---
    const today = await db.query(`
      SELECT COUNT(*)::int AS c
      FROM booking_bookings
      WHERE created_at >= date_trunc('day', now())
    `);

    const week = await db.query(`
      SELECT COUNT(*)::int AS c
      FROM booking_bookings
      WHERE created_at >= now() - interval '7 days'
    `);

    const month = await db.query(`
      SELECT COUNT(*)::int AS c
      FROM booking_bookings
      WHERE created_at >= now() - interval '30 days'
    `);

    // --- funnel (from analytics table you already have data in) ---
    const funnel = await db.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_course_view' AND occurred_at >= NOW() - $1::interval) AS views,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_availability_search' AND occurred_at >= NOW() - $1::interval) AS times,
        0::int AS started,
        (SELECT COUNT(*)::int FROM analytics WHERE type='booking_created' AND occurred_at >= NOW() - $1::interval) AS confirmed
      `,
      [range]
    );

    res.json({
      ok: true,
      bookingsToday: today.rows[0]?.c || 0,
      bookingsThisWeek: week.rows[0]?.c || 0,
      bookingsThisMonth: month.rows[0]?.c || 0,
      funnelLast30Days: funnel.rows[0] || { views: 0, times: 0, started: 0, confirmed: 0 },
    });
  } catch (e) {
    console.error("admin/booking-analytics/summary", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;