// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";
import { Resend } from "resend";
import cookieParser from "cookie-parser"; // ✅ ADD
import { recordEvent } from "./analytics.js";
import jwt from "jsonwebtoken";

const router = express.Router();
// ✅ CORS for booking admin + course admin UIs (fixes “buttons do nothing” due to blocked preflight)
router.use((req, res, next) => {
  const origin = String(req.headers.origin || "");

  // If the request has an Origin header, reflect it (required for cookies/credentials).
  // If no Origin (server-to-server), just continue.
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  // Allow the headers your frontends actually send
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "x-booking-admin-secret",
      "x-course-admin-key",
      "x-course-slug",
      "x-session-id",
    ].join(", ")
  );

  // Allow methods used by your UIs
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  // ✅ End preflight fast (this is what unblocks “dead buttons”)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});
// ✅ Add request id + timing + end-of-request status log
router.use((req, res, next) => {
  req._rid = Math.random().toString(16).slice(2, 10);
  const start = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`🧾 [${req._rid}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
});
// ✅ DEBUG flag (Render env var DEBUG_BOOKING=1)
const debug = String(process.env.DEBUG_BOOKING || "").trim() === "1";
console.log("🧪 DEBUG_BOOKING enabled?", debug, "raw=", process.env.DEBUG_BOOKING);
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

async function getTeePricePerPlayerCents({ courseId, playDate, teeTime, holes }) {
  const r = await db.query(
    `
    SELECT COALESCE(price_per_player_cents, 0)::int AS p
    FROM booking_times
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
    LIMIT 1;
    `,
    [courseId, playDate, teeTime, holes]
  );
  return Number(r.rows[0]?.p || 0);
}
// ------------------------------
// ✅ Course Admin JWT helpers
// ------------------------------
function getCourseAdminSecret() {
  return COURSE_ADMIN_JWT_SECRET || JWT_SECRET_FALLBACK || "";
}

function signCourseAdminToken(payload) {
  const secret = getCourseAdminSecret();
  if (!secret) throw new Error("COURSE_ADMIN_JWT_SECRET_not_set");
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

function verifyCourseAdminToken(token) {
  const secret = getCourseAdminSecret();
  if (!secret) throw new Error("COURSE_ADMIN_JWT_SECRET_not_set");
  return jwt.verify(token, secret);
}

function getBearer(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
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
async function requireCourseAdmin(req, res, next) {
  try {
    // ✅ 1) BYPASS mode (if you still support it)
    const { key, slug } = getBypassProvided(req);
    if (key && slug) {
      const expected = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
      if (expected && key === expected) {
        // attach course_id from slug
        const cr = await db.query(
          `SELECT id, name, slug FROM booking_courses WHERE lower(slug)=lower($1) LIMIT 1`,
          [slug]
        );
        const course = cr.rows?.[0];
        if (!course?.id) {
          return res.status(401).json({ ok: false, error: "course_not_found" });
        }

        req.courseAdmin = {
          slug: course.slug,
          email: "bypass@local",
          role: "proshop",
          course_id: course.id,
          course_name: course.name || "",
        };
        return next();
      }
    }

    // ✅ 2) Normal mode (token/cookies)
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const bearer = m ? m[1].trim() : "";
    const token = bearer || String(req.cookies?.tr_course_admin_token || "");
    const verified = token ? verifyCourseAdminToken(token) : null;

    if (verified?.slug && verified?.email) {
      // attach course_id from slug
      const cr = await db.query(
        `SELECT id, name, slug FROM booking_courses WHERE lower(slug)=lower($1) LIMIT 1`,
        [verified.slug]
      );
      const course = cr.rows?.[0];
      if (!course?.id) {
        return res.status(401).json({ ok: false, error: "course_not_found" });
      }

      req.courseAdmin = {
        slug: course.slug,
        email: verified.email,
        role: verified.role || "proshop",
        course_id: course.id,
        course_name: course.name || "",
      };
      return next();
    }

    // ✅ 3) fallback: old cookies (backwards compatible)
    const slug2 = String(req.cookies?.tr_course_admin_slug || "");
    const email2 = String(req.cookies?.tr_course_admin_email || "");
    if (!slug2 || !email2) {
      return res.status(401).json({ ok: false, error: "not_course_admin" });
    }

    // attach course_id from slug
    const cr2 = await db.query(
      `SELECT id, name, slug FROM booking_courses WHERE lower(slug)=lower($1) LIMIT 1`,
      [slug2]
    );
    const course2 = cr2.rows?.[0];
    if (!course2?.id) {
      return res.status(401).json({ ok: false, error: "course_not_found" });
    }

    req.courseAdmin = {
      slug: course2.slug,
      email: email2,
      role: "proshop",
      course_id: course2.id,
      course_name: course2.name || "",
    };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "not_course_admin" });
  }
}
// ✅ NEW: allow analytics access for either:
// - course-admin token (cookie or Bearer)
// - normal app "manager" JWT (cookie) that includes course_id
async function requireCourseAdminOrManager(req, res, next) {
  try {
    // ---------- 1) Try COURSE ADMIN token ----------
    const jwtSecret = (COURSE_ADMIN_JWT_SECRET || JWT_SECRET_FALLBACK || "").trim();

    const bearer = String(req.headers.authorization || "");
    const bearerToken =
      bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";

    const courseAdminToken = String(
      bearerToken || req.cookies?.tr_course_admin_token || ""
    ).trim();

    if (courseAdminToken && jwtSecret) {
      try {
        const decoded = jwt.verify(courseAdminToken, jwtSecret);
        const adminId = decoded?.admin_id || decoded?.id;
        if (adminId) {
          const r = await db.query(
            `SELECT id, course_id, role, email
             FROM booking_course_admins
             WHERE id = $1
             LIMIT 1`,
            [adminId]
          );

          const admin = r.rows?.[0];
          if (admin?.course_id) {
            req.courseAdmin = admin;
            return next();
          }
        }
      } catch (e) {
        // fall through to manager jwt
      }
    }

    // ---------- 2) Try NORMAL APP MANAGER JWT ----------
    // Adjust cookie names here if yours differs:
    const userToken = String(
      req.cookies?.tr_token ||
      req.cookies?.token ||
      req.cookies?.jwt ||
      ""
    ).trim();

    const userSecret = (JWT_SECRET_FALLBACK || "").trim();

    if (userToken && userSecret) {
      try {
        const u = jwt.verify(userToken, userSecret);

        // accept either role field
        const role = String(u?.role || u?.user?.role || "").toLowerCase();

        // accept either course_id field
        const courseId =
          u?.course_id || u?.courseId || u?.user?.course_id || u?.user?.courseId;

        if (role === "manager" && courseId) {
          req.courseAdmin = { course_id: courseId, role: "manager" };
          return next();
        }
      } catch (e) {
        // ignore
      }
    }

    return res.status(401).json({ ok: false, error: "unauthorized" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
}
function requireCourseAdminManager(req, res, next) {
  const role = String(req.courseAdmin?.role || "").trim().toLowerCase();

  // allow both course-admin staff and manager
  if (role !== "manager" && role !== "proshop" && role !== "admin") {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  next();
}
// ✅ DEBUG logger (safe anywhere)
const DEBUG_BOOKING = String(process.env.DEBUG_BOOKING || "").trim() === "1";
function dlog(...args) {
  if (DEBUG_BOOKING) console.log(...args);
}
// ✅ STEP 4: capacity-aware manual slots (players + carts + hire clubs)
function toDateKey(playDate) {
  // Accepts "2026-01-13" OR ISO string like "2026-01-13T00:00:00.000Z"
  if (!playDate) return "";
  const s = String(playDate);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

async function getCapacitySnapshot({ courseId, playDateKey }) {
  // 1) course inventory totals (from booking_courses)
  const courseQ = await db.query(
    `
    SELECT
      COALESCE(cart_qty,0)::int          AS carts_total,
      COALESCE(hire_clubs_qty,0)::int    AS hire_clubs_total,
      COALESCE(duration_9_mins,210)::int AS duration_9_mins,
      COALESCE(duration_18_mins,390)::int AS duration_18_mins
    FROM booking_courses
    WHERE id = $1
    LIMIT 1;
    `,
    [courseId]
  );
  const course = courseQ.rows[0] || null;

  const cartsTotal = Number(course?.carts_total ?? 0);
  const clubsTotal = Number(course?.hire_clubs_total ?? 0);

  // 2) used add-ons from confirmed online bookings for that day
  const usedBookings = await db.query(
    `
    SELECT
      COALESCE(SUM(COALESCE(cart_qty,0)), 0)::int       AS carts_used,
      COALESCE(SUM(COALESCE(hire_clubs_qty,0)), 0)::int AS clubs_used
    FROM booking_bookings
    WHERE course_id = $1
      AND play_date = $2::date
      AND status = 'CONFIRMED';
    `,
    [courseId, playDateKey]
  );

  // 3) used add-ons from manual slots for that day (count ONCE per reference)
  const usedManual = await db.query(
    `
    SELECT
      COALESCE(SUM(COALESCE(cart_qty,0)), 0)::int       AS carts_used,
      COALESCE(SUM(COALESCE(hire_clubs_qty,0)), 0)::int AS clubs_used
    FROM booking_manual_slots m
    WHERE course_id = $1
      AND play_date = $2::date
      AND COALESCE(name,'') <> ''
      AND slot_index = (
        SELECT MIN(slot_index)
        FROM booking_manual_slots
        WHERE reference = m.reference
          AND course_id = $1
          AND play_date = $2::date
      );
    `,
    [courseId, playDateKey]
  );

  return {
    cartsTotal,
    clubsTotal,
    cartsUsed: Number(usedBookings.rows[0]?.carts_used || 0) + Number(usedManual.rows[0]?.carts_used || 0),
    clubsUsed: Number(usedBookings.rows[0]?.clubs_used || 0) + Number(usedManual.rows[0]?.clubs_used || 0),
  };
}

async function manualSlotAllowed({
  courseId,
  playDate,
  teeTime,      // "06:00"
  holes,
  playersWanted,
  cartsWanted,
  clubsWanted,
}) {
  const playDateKey = toDateKey(playDate);

  // A) per-tee-time player capacity (manual slots + confirmed bookings)
  const ms = await db.query(
    `
    SELECT COUNT(*)::int AS players_booked
    FROM booking_manual_slots
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND COALESCE(name,'') <> '';
    `,
    [courseId, playDateKey, teeTime, holes]
  );

  const bb = await db.query(
    `
    SELECT COALESCE(SUM(players),0)::int AS players_booked
    FROM booking_bookings
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND status = 'CONFIRMED';
    `,
    [courseId, playDateKey, teeTime, holes]
  );

  const alreadyBookedPlayers =
    Number(ms.rows[0]?.players_booked || 0) + Number(bb.rows[0]?.players_booked || 0);

  // Use booking_times.max_players if it exists; otherwise default 4
  const cap = await db.query(
    `
    SELECT COALESCE(max_players,4)::int AS max_players
    FROM booking_times
    WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
    LIMIT 1;
    `,
    [courseId, playDateKey, teeTime, holes]
  );

  const maxPlayersPerSlot = Number(cap.rows[0]?.max_players || 4);

  const playersOk = (alreadyBookedPlayers + Number(playersWanted || 0)) <= maxPlayersPerSlot;

  // B) daily carts/clubs capacity (only if course has totals set)
  const snap = await getCapacitySnapshot({ courseId, playDateKey });

  const cartsOk =
    snap.cartsTotal <= 0 ? true : (snap.cartsUsed + Number(cartsWanted || 0)) <= snap.cartsTotal;

  const clubsOk =
    snap.clubsTotal <= 0 ? true : (snap.clubsUsed + Number(clubsWanted || 0)) <= snap.clubsTotal;

  return playersOk && cartsOk && clubsOk;
}
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
// -----------------------------
// ✅ Course admin password helpers (PBKDF2)
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
// ✅ NEW: make a safe "key" from a layout label (e.g. "Pines" -> "pines")
function layoutKey(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
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
  // Force UTC interpretation so overlap windows are stable on Render
  return `${dateYmd}T${timeHhMm}:00Z`;
}

function durationMinsForHoles(courseRow, holes) {
  const h = Number(holes || 18);
  if (h === 9) return Number(courseRow?.duration_9_mins || 210);
  return Number(courseRow?.duration_18_mins || 390);
}
async function getManualAddonUsage({ courseId, teeDate, teeTime }) {
  // sums quantities already reserved in manual slots for that exact tee time
  const row = await db.get(
    `
    SELECT
      COALESCE(SUM(cart_qty), 0) AS carts_used,
      COALESCE(SUM(hire_clubs_qty), 0) AS clubs_used
    FROM booking_manual_slots
    WHERE course_id = ?
      AND tee_date = ?
      AND tee_time = ?
      AND (status IS NULL OR status NOT IN ('cancelled','canceled','refunded'))
    `,
    [courseId, teeDate, teeTime]
  );

  return {
    carts_used: Number(row?.carts_used || 0),
    clubs_used: Number(row?.clubs_used || 0),
  };
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

      -- manual slots: count carts/clubs ONCE per booking (lowest slot_index per reference)
      SELECT
        COALESCE(SUM(COALESCE(cart_qty,0)),0) AS carts_used,
        COALESCE(SUM(COALESCE(hire_clubs_qty,0)),0) AS clubs_used
      FROM booking_manual_slots m
      WHERE course_id = $1
        AND COALESCE(name,'') <> ''
        AND start_at IS NOT NULL
        AND end_at IS NOT NULL
        AND start_at < $3::timestamptz
        AND end_at   > $2::timestamptz
        AND slot_index = (
        SELECT MIN(slot_index)
        FROM booking_manual_slots
        WHERE reference = m.reference
        AND course_id = $1
      )
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
      remaining: { carts: cartsRemaining, hireClubs: clubsRemaining },
      requested: { carts: wantedCarts, hireClubs: wantedClubs },
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
// -----------------------------
// ✅ Debug helpers (used by POST /availability logs)
// -----------------------------
function makeDebugId() {
  return "dbg_" + crypto.randomBytes(4).toString("hex");
}

function dbgLog(id, label, obj = {}) {
  try {
    console.log(`🧪 ${id} ${label}`, obj);
  } catch {}
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

  // ✅ allow query/header secret (existing)
  const provided =
    String(req.query?.secret || "").trim() ||
    String(req.headers["x-booking-admin-secret"] || "").trim();

  if (provided && provided === ADMIN_SECRET) return next();

  // ✅ NEW: allow normal site JWT (Authorization: Bearer <teeradar_jwt>)
  // This is what your /analytics page is sending.
  const bearer = typeof getBearer === "function" ? getBearer(req) : "";
  if (bearer) {
    try {
      // Your file already has JWT_SECRET_FALLBACK in earlier sections (from your other snippets).
      const secret = (JWT_SECRET_FALLBACK || "").trim();

      if (secret) {
        const decoded = jwt.verify(bearer, secret);

        const adminEmail = String(process.env.ADMIN_EMAIL || "declan7pin@gmail.com")
          .trim()
          .toLowerCase();

        const tokenEmail = String(decoded?.email || decoded?.user?.email || "")
          .trim()
          .toLowerCase();

        if (tokenEmail && tokenEmail === adminEmail) return next();
      }
    } catch (e) {
      // ignore and fall through to not_authorized
    }
  }

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

  // ✅ NEW: course layouts (9-hole loops + optional 18-hole routing)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_layouts (
      course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,
      layouts JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key,label}]
      routes18 JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{key,label,front9_key,back9_key}]
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ✅ NEW: store named 9s + 18-hole routings (as JSON, editable by course)
  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS layouts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ✅ NEW: role-based access for course users (manager vs proshop)
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
    ALTER TABLE booking_course_users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'proshop';
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_time_templates (
      course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Australia/Perth',
      template JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // ✅ booking_times (base table)
  // ✅ IMPORTANT: DO NOT keep the old UNIQUE(course_id, play_date, tee_time, holes)
  // because it causes layouts to be treated as duplicates.
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
      updated_at TIMESTAMPTZ DEFAULT now()
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

  // ✅ NEW: optional layout keys for named 9s + 18 routings (e.g. lakes, pines+lakes)
  // (MUST exist before we enforce the new unique constraint)
  await db.query(`ALTER TABLE booking_times ADD COLUMN IF NOT EXISTS layout_key TEXT;`);
  await db.query(`ALTER TABLE booking_times ADD COLUMN IF NOT EXISTS front_nine_key TEXT;`);
  await db.query(`ALTER TABLE booking_times ADD COLUMN IF NOT EXISTS back_nine_key TEXT;`);

  // ✅ IMPORTANT: normalize NULL keys so uniqueness works predictably
  await db.query(`
    UPDATE booking_times
    SET
      layout_key = COALESCE(layout_key, ''),
      front_nine_key = COALESCE(front_nine_key, ''),
      back_nine_key = COALESCE(back_nine_key, '')
    WHERE
      layout_key IS NULL
      OR front_nine_key IS NULL
      OR back_nine_key IS NULL;
  `);

  // ✅ ADD: remove legacy blank-layout rows ONLY when real layout rows exist for same slot
  // This fixes "Inserted 0, skipped X" after layouts are introduced.
  await db.query(`
    DELETE FROM booking_times bt
    WHERE COALESCE(bt.layout_key,'') = ''
      AND COALESCE(bt.front_nine_key,'') = ''
      AND COALESCE(bt.back_nine_key,'') = ''
      AND EXISTS (
        SELECT 1
        FROM booking_times bx
        WHERE bx.course_id = bt.course_id
          AND bx.play_date = bt.play_date
          AND bx.tee_time  = bt.tee_time
          AND bx.holes     = bt.holes
          AND (
            COALESCE(bx.layout_key,'') <> ''
            OR COALESCE(bx.front_nine_key,'') <> ''
            OR COALESCE(bx.back_nine_key,'') <> ''
          )
      );
  `);

  // ✅ CRITICAL: drop the legacy unique constraint that ignores layout keys
  // (Postgres usually auto-names it like booking_times_course_id_play_date_tee_time_holes_key)
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'booking_times'::regclass
          AND contype = 'u'
          AND conname = 'booking_times_course_id_play_date_tee_time_holes_key'
      ) THEN
        ALTER TABLE booking_times
        DROP CONSTRAINT booking_times_course_id_play_date_tee_time_holes_key;
      END IF;
    END
    $$;
  `);

  // ✅ ALSO drop any legacy UNIQUE INDEX that ignores layout keys
  // (some DBs have a unique index on course/date/time/holes with a different name)
  await db.query(`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE t.relname = 'booking_times'
          AND x.indisunique = true
          AND pg_get_indexdef(x.indexrelid) LIKE '%(course_id, play_date, tee_time, holes)%'
          AND pg_get_indexdef(x.indexrelid) NOT LIKE '%layout_key%'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
      END LOOP;
    END
    $$;
  `);

  // ✅ FIX #1: clean duplicates so we can add a unique constraint safely
  // ✅ UPDATED: duplicates are now determined INCLUDING layout/front/back keys
  await db.query(`
    WITH ranked AS (
      SELECT
        id,
        status,
        ROW_NUMBER() OVER (
          PARTITION BY course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key
          ORDER BY id ASC
        ) AS rn
      FROM booking_times
    )
    DELETE FROM booking_times bt
    USING ranked r
    WHERE bt.id = r.id
      AND r.rn > 1
      AND r.status <> 'BOOKED';
  `);

  // ✅ FIX #2: ensure ON CONFLICT has a matching unique constraint
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'booking_times_unique_slot'
      ) THEN
        ALTER TABLE booking_times
        DROP CONSTRAINT booking_times_unique_slot;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'booking_times_unique_slot'
      ) THEN
        ALTER TABLE booking_times
        ADD CONSTRAINT booking_times_unique_slot
        UNIQUE (course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key);
      END IF;
    END
    $$;
  `);

  await db.query(`DROP INDEX IF EXISTS booking_times_unique_layout_idx;`);
  await db.query(`DROP INDEX IF EXISTS booking_times_unique_slot_idx;`);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS booking_times_unique_slot_idx
    ON booking_times (
      course_id,
      play_date,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS booking_times_layout_idx ON booking_times (course_id, play_date, holes, layout_key, tee_time);`);

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

  await db.query(`
    ALTER TABLE booking_bookings
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE booking_bookings
    ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
  `);

  // ✅ NEW: persist chosen layout for bookings (named 9s + 18 routings)
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS layout_key TEXT;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS front_nine_key TEXT;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS back_nine_key TEXT;`);
  await db.query(`CREATE INDEX IF NOT EXISTS booking_bookings_layout_idx ON booking_bookings (course_id, play_date, holes, layout_key);`);

  // ✅ ADD: normalize booking layout keys too (avoids NULL mismatches in availability joins)
  await db.query(`
    UPDATE booking_bookings
    SET
      layout_key = COALESCE(layout_key, ''),
      front_nine_key = COALESCE(front_nine_key, ''),
      back_nine_key = COALESCE(back_nine_key, '')
    WHERE
      layout_key IS NULL
      OR front_nine_key IS NULL
      OR back_nine_key IS NULL;
  `);

  // ✅ NEW: store the "usage window" so inventory can be checked by overlap
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;`);
  await db.query(`CREATE INDEX IF NOT EXISTS booking_bookings_course_window_idx ON booking_bookings (course_id, start_at, end_at);`);

  // ✅ ADD: paid flag + cart tracking
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  // ✅ ADD: add-ons pricing stored per course
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  // ✅ NEW: inventory quantities + durations stored per course
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS duration_9_mins INTEGER NOT NULL DEFAULT 210;`);
  await db.query(`ALTER TABLE booking_courses ADD COLUMN IF NOT EXISTS duration_18_mins INTEGER NOT NULL DEFAULT 390;`);

  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_hire_clubs BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_bookings_course_date_idx
    ON booking_bookings (course_id, play_date);
  `);

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

  // ✅ NEW: per-course settings (inventory + durations + add-on fees)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_settings (
      course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,

      cart_qty INTEGER NOT NULL DEFAULT 0,
      hire_clubs_qty INTEGER NOT NULL DEFAULT 0,

      cart_fee_cents INTEGER NOT NULL DEFAULT 0,
      hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0,

      duration_18_mins INTEGER NOT NULL DEFAULT 360,
      duration_9_mins INTEGER NOT NULL DEFAULT 180,

      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_manual_slots (
      id BIGSERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      play_date DATE NOT NULL,
      tee_time TEXT NOT NULL,
      holes INTEGER NOT NULL,
      slot_index INTEGER NOT NULL,
      reference TEXT NOT NULL,
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

  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS notes TEXT;`);

  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS layout_key TEXT;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS front_nine_key TEXT;`);
  await db.query(`ALTER TABLE booking_manual_slots ADD COLUMN IF NOT EXISTS back_nine_key TEXT;`);

  // ✅ ADD: normalize manual slot layout keys (same reason as booking_times)
  await db.query(`
    UPDATE booking_manual_slots
    SET
      layout_key = COALESCE(layout_key, ''),
      front_nine_key = COALESCE(front_nine_key, ''),
      back_nine_key = COALESCE(back_nine_key, '')
    WHERE
      layout_key IS NULL
      OR front_nine_key IS NULL
      OR back_nine_key IS NULL;
  `);

  // ✅ ADD: drop the legacy unique constraint that ignores layout keys for manual slots
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'booking_manual_slots'::regclass
          AND contype = 'u'
          AND conname = 'booking_manual_slots_course_id_play_date_tee_time_holes_slot_index_key'
      ) THEN
        ALTER TABLE booking_manual_slots
        DROP CONSTRAINT booking_manual_slots_course_id_play_date_tee_time_holes_slot_index_key;
      END IF;
    END
    $$;
  `);

  // ✅ ADD: drop any unique indexes that still ignore layout keys
  await db.query(`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT i.relname AS index_name
        FROM pg_index x
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE t.relname = 'booking_manual_slots'
          AND x.indisunique = true
          AND pg_get_indexdef(x.indexrelid) LIKE '%(course_id, play_date, tee_time, holes, slot_index)%'
          AND pg_get_indexdef(x.indexrelid) NOT LIKE '%layout_key%'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
      END LOOP;
    END
    $$;
  `);

  // ✅ ADD: create layout-aware unique index for manual slots
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS booking_manual_slots_unique_slot_idx
    ON booking_manual_slots (
      course_id,
      play_date,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      slot_index
    );
  `);

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
    const roleRaw = String(req.body?.role || "proshop").trim().toLowerCase();
    const role = roleRaw === "manager" ? "manager" : "proshop";
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
            INSERT INTO booking_course_users (course_id, email, salt_hex, hash_hex, role)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (course_id, email)
      DO UPDATE SET
        salt_hex = EXCLUDED.salt_hex,
        hash_hex = EXCLUDED.hash_hex,
        role     = EXCLUDED.role
      `,
            [courseId, email, saltHex, hashHex, role]
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
      SELECT cu.course_id, cu.email, cu.salt_hex, cu.hash_hex, cu.role, c.slug
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
      courseAdminToken = signCourseAdminToken({
  courseId: u.course_id,
  slug: u.slug,
  email: u.email,
  role: u.role,
});
    } catch (err) {
      console.error("❌ course-admin/login token error", err);
      return res.status(500).json({ ok: false, error: "course_admin_token_failed" });
    }

    // ✅ Set cookies using your helper (handles cross-site properly)
    res.cookie("tr_course_admin_slug", String(u.slug), baseCookieOpts(req));
    res.cookie("tr_course_admin_email", String(u.email), baseCookieOpts(req));
    res.cookie("tr_course_admin_token", String(courseAdminToken), baseCookieOpts(req));
    res.cookie("tr_course_admin_role", String(u.role || "proshop"), baseCookieOpts(req));
    const response = {
  ok: true,
  slug: u.slug,
  email: u.email,
  role: u.role || "proshop",
  token: courseAdminToken,
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
  res.clearCookie("tr_course_admin_role", { path: "/" });
  res.json({ ok: true });
});

// ✅ ADD THIS (course admin "who am I")
// Place this EXACTLY where the stray res.json block currently is.
router.get("/course-admin/me", requireCourseAdmin, (req, res) => {
  return res.json({
    ok: true,
    slug: req.courseAdmin.slug,
    email: req.courseAdmin.email,
    role: req.courseAdmin.role || "proshop",
  });
});
// ✅ Manager-only: allow frontend to check access for Analytics page
router.get(
  "/course-admin/analytics/access",
  requireCourseAdmin,
  requireCourseAdminManager,
  (req, res) => {
    return res.json({ ok: true, access: "manager" });
  }
);
// view saved template JSON (course admin) - DEBUG helper
router.get("/course-admin/template", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    const t = await db.query(
      `SELECT template, updated_at
       FROM booking_time_templates
       WHERE course_id = $1
       LIMIT 1;`,
      [courseId]
    );

    return res.json({
      ok: true,
      slug,
      updatedAt: t.rows[0]?.updated_at || null,
      template: t.rows[0]?.template || null,
    });
  } catch (e) {
    console.error("course-admin/template GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
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
// ✅ NEW: Course admin — update course settings (manager-only)
router.post(
  "/course-admin/course-settings",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
      if (!slug || !isValidSlug(slug)) {
        return res.status(400).json({ ok: false, error: "slug_invalid" });
      }

      const cart_qty = Number(req.body?.cart_qty ?? req.body?.cartQty ?? 0);
      const hire_clubs_qty = Number(req.body?.hire_clubs_qty ?? req.body?.hireClubsQty ?? 0);
      const cart_fee_cents = Number(req.body?.cart_fee_cents ?? req.body?.cartFeeCents ?? 0);
      const hire_clubs_fee_cents = Number(req.body?.hire_clubs_fee_cents ?? req.body?.hireClubsFeeCents ?? 0);
      const duration_9_mins = Number(req.body?.duration_9_mins ?? req.body?.duration9 ?? 180);
      const duration_18_mins = Number(req.body?.duration_18_mins ?? req.body?.duration18 ?? 360);

      function okInt(n, min, max) {
        return Number.isFinite(n) && n >= min && n <= max;
      }

      if (!okInt(cart_qty, 0, 9999)) return res.status(400).json({ ok: false, error: "cart_qty_invalid" });
      if (!okInt(hire_clubs_qty, 0, 9999)) return res.status(400).json({ ok: false, error: "hire_clubs_qty_invalid" });
      if (!okInt(cart_fee_cents, 0, 10000000)) return res.status(400).json({ ok: false, error: "cart_fee_invalid" });
      if (!okInt(hire_clubs_fee_cents, 0, 10000000)) return res.status(400).json({ ok: false, error: "hire_clubs_fee_invalid" });
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

      return res.json({ ok: true, settings: r.rows[0] });
    } catch (e) {
      console.error("course-admin/course-settings POST", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);
// =======================
// Course layouts (9-hole loops + optional 18-hole routing)
// Stored in booking_course_layouts
// =======================

// GET layouts
router.get("/course-admin/course-layouts", requireCourseAdmin, async (req, res) => {
  try {
    const courseId = Number(req.courseAdmin.course_id);

    const r = await db.query(
      `
      SELECT layouts, routes18
      FROM booking_course_layouts
      WHERE course_id = $1
      LIMIT 1
      `,
      [courseId]
    );

    if (!r.rows.length) {
      return res.json({ ok: true, layouts: [], routes18: [] });
    }

    return res.json({
      ok: true,
      layouts: r.rows[0].layouts || [],
      routes18: r.rows[0].routes18 || [],
    });
  } catch (e) {
    console.error("course-admin/course-layouts GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// SAVE layouts
router.post("/course-admin/course-layouts", requireCourseAdmin, async (req, res) => {
  try {
    const courseId = Number(req.courseAdmin.course_id);
    const layouts = Array.isArray(req.body.layouts) ? req.body.layouts : [];
    const routes18 = Array.isArray(req.body.routes18) ? req.body.routes18 : [];

    await db.query(
      `
      INSERT INTO booking_course_layouts (course_id, layouts, routes18)
      VALUES ($1, $2::jsonb, $3::jsonb)
      ON CONFLICT (course_id)
      DO UPDATE SET
        layouts = EXCLUDED.layouts,
        routes18 = EXCLUDED.routes18,
        updated_at = now()
      `,
      [courseId, JSON.stringify(layouts), JSON.stringify(routes18)]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("course-admin/course-layouts POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: debug route so it returns JSON (won't fall into SPA index.html)

// =======================
// Named 9s / routings (layouts)
// =======================
// Course-admin can save a list of named nines + optional 18-hole routings.
// Stored in booking_course_layouts.
//
// layouts:  [{ key, label }]
// routes18: [{ key, label, front9_key, back9_key }]

function _layoutKey(v){
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

router.get("/course-admin/course-layouts", requireCourseAdmin, async (req, res) => {
  try {
    const courseId = Number(req.courseAdmin?.course_id || req.courseAdmin?.courseId || 0);
    const slug = String(req.courseAdmin?.slug || "");

    if (!courseId) return res.status(403).json({ ok: false, error: "course_not_found" });

    const r = await db.query(
      `SELECT layouts, routes18 FROM booking_course_layouts WHERE course_id = $1 LIMIT 1`,
      [courseId]
    );

    const layouts = r.rows?.[0]?.layouts || [];
    const routes18 = r.rows?.[0]?.routes18 || [];

    return res.json({ ok: true, slug, layouts, routes18 });
  } catch (e) {
    console.error("course-admin/course-layouts GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/course-admin/course-layouts", requireCourseAdmin, async (req, res) => {
  try {
    const courseId = Number(req.courseAdmin?.course_id || req.courseAdmin?.courseId || 0);
    if (!courseId) return res.status(403).json({ ok: false, error: "course_not_found" });

    const layoutsIn = Array.isArray(req.body?.layouts) ? req.body.layouts : null;
    const routes18In = Array.isArray(req.body?.routes18) ? req.body.routes18 : (Array.isArray(req.body?.routes18s) ? req.body.routes18s : null);

    if (!layoutsIn) return res.status(400).json({ ok: false, error: "layouts_required" });

    // ✅ 9-hole layouts (UI sends [{label}] — we add/normalize keys)
    const layouts = layoutsIn
      .filter(x => x && typeof x === "object")
      .map(x => {
        const label = String(x.label || x.name || x.key || "").trim();
        const key = _layoutKey(x.key || label);
        return key ? { key, label: label || key } : null;
      })
      .filter(Boolean);

    // ✅ Optional 18-hole routing (if you later add it to the UI)
    const routes18 = (routes18In || [])
      .filter(x => x && typeof x === "object")
      .map(x => {
        const label = String(x.label || x.name || x.key || "").trim();
        const key = _layoutKey(x.key || label);
        const front9_key = _layoutKey(x.front9_key || x.front || "");
        const back9_key = _layoutKey(x.back9_key || x.back || "");
        return key ? { key, label: label || key, front9_key, back9_key } : null;
      })
      .filter(Boolean);

    await db.query(
      `
      INSERT INTO booking_course_layouts (course_id, layouts, routes18, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, now())
      ON CONFLICT (course_id)
      DO UPDATE SET
        layouts = EXCLUDED.layouts,
        routes18 = EXCLUDED.routes18,
        updated_at = now();
      `,
      [courseId, JSON.stringify(layouts), JSON.stringify(routes18)]
    );

    return res.json({
      ok: true,
      slug: String(req.courseAdmin?.slug || ""),
      layouts,
      routes18,
    });
  } catch (e) {
    console.error("course-admin/course-layouts POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// Public read (used by book.html / search UI)
router.get("/course-layouts", async (req, res) => {
  try {
    const slug = String(req.query.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ ok: false, error: "slug_required" });

    const r = await db.query(
      `
      SELECT l.layouts, l.routes18
      FROM booking_courses c
      LEFT JOIN booking_course_layouts l ON l.course_id = c.id
      WHERE c.slug = $1
      LIMIT 1;
      `,
      [slug]
    );

    const layouts = r.rows?.[0]?.layouts || [];
    const routes18 = r.rows?.[0]?.routes18 || [];
    return res.json({ ok: true, slug, layouts, routes18 });
  } catch (e) {
    console.error("course-layouts GET", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

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
// ✅ NEW: set bypass cookies once (so user doesn't need to re-enter key)
// POST /api/book/course-admin/bypass
// Body: { slug, key }
router.post("/course-admin/bypass", (req, res) => {
  try {
    const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
    if (!bypassKey) {
      return res.status(400).json({ ok: false, error: "bypass_not_enabled" });
    }

    const slug = normSlug(req.body?.slug);
    const key = String(req.body?.key || "").trim();

    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
    }
    if (!key) {
      return res.status(400).json({ ok: false, error: "key_required" });
    }
    if (key !== bypassKey) {
      return res.status(401).json({ ok: false, error: "invalid_key" });
    }

    // ✅ store cookies so future visits work without re-entering
    res.cookie("tr_course_admin_bypass", key, baseCookieOpts(req));
    res.cookie("tr_course_admin_slug", slug, baseCookieOpts(req));

    return res.json({ ok: true, slug });
  } catch (e) {
    console.error("course-admin/bypass POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
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

    // ✅ NEW: allow admin to generate a specific layout (optional)
    const cleanKey = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return "";
      if (s.toLowerCase() === "select") return "";
      return s;
    };

    const layoutKey = cleanKey(_pickAny(req.body, ["layoutKey", "layout_key"], ""));
    const frontNineKey = cleanKey(_pickAny(req.body, ["frontNineKey", "front_nine_key", "front9Key", "front9_key"], ""));
    const backNineKey = cleanKey(_pickAny(req.body, ["backNineKey", "back_nine_key", "back9Key", "back9_key"], ""));

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

    // ✅ NEW: validate layout requirements
    // - for 18s: you MUST provide front+back keys (and a layoutKey if you want)
    // - for 9s: you MUST provide layoutKey
    if (holes === 18) {
      if (!frontNineKey || !backNineKey) {
        return res.status(400).json({ ok: false, error: "layout_required_for_18", detail: "frontNineKey and backNineKey are required for 18-hole generation" });
      }
    }
    if (holes === 9) {
      if (!layoutKey) {
        return res.status(400).json({ ok: false, error: "layout_required_for_9", detail: "layoutKey is required for 9-hole generation" });
      }
    }

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
      // ✅ FIX: existence check MUST include layout identity
      const exists = await db.query(
        `
        SELECT 1
        FROM booking_times
        WHERE course_id=$1
          AND play_date=$2::date
          AND tee_time=$3
          AND holes=$4
          AND layout_key=$5
          AND front_nine_key=$6
          AND back_nine_key=$7
        LIMIT 1;
        `,
        [courseId, playDate, t, holes, layoutKey, frontNineKey, backNineKey]
      );

      const isExisting = !!exists.rows.length;

      // ✅ FIX: upsert MUST use the correct unique constraint
      await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status,
           layout_key, front_nine_key, back_nine_key, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7,
           $8, $9, $10, now())
        ON CONFLICT ON CONSTRAINT booking_times_unique_slot
        DO UPDATE SET
          max_players = EXCLUDED.max_players,
          price_per_player_cents = EXCLUDED.price_per_player_cents,
          status = CASE
            WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
            WHEN booking_times.status = 'BLOCKED' THEN 'BLOCKED'
            ELSE EXCLUDED.status
          END,
          updated_at = now()
        `,
        [courseId, playDate, t, holes, maxPlayers, pricePerPlayerCents, status,
         layoutKey, frontNineKey, backNineKey]
      );

      if (isExisting) skipped += 1;
      else inserted += 1;
    }

    res.json({
      ok: true,
      slug,
      date: playDate,
      holes,
      layoutKey,
      frontNineKey,
      backNineKey,
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

    // ✅ NEW: allow legacy generator to be layout-aware too
    const cleanKey = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return "";
      if (s.toLowerCase() === "select") return "";
      return s;
    };

    const layoutKey = cleanKey(req.body?.layoutKey || req.body?.layout_key || "");
    const frontNineKey = cleanKey(req.body?.frontNineKey || req.body?.front_nine_key || req.body?.front9Key || req.body?.front9_key || "");
    const backNineKey = cleanKey(req.body?.backNineKey || req.body?.back_nine_key || req.body?.back9Key || req.body?.back9_key || "");

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_must_be_9_or_18" });
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 4 || intervalMinutes > 20)
      return res.status(400).json({ ok: false, error: "interval_invalid" });
    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return res.status(400).json({ ok: false, error: "maxPlayers_invalid" });
    if (!["AVAILABLE", "BLOCKED"].includes(status))
      return res.status(400).json({ ok: false, error: "status_invalid" });

    // ✅ NEW: validate layout requirements
    if (holes === 18) {
      if (!frontNineKey || !backNineKey) {
        return res.status(400).json({ ok: false, error: "layout_required_for_18", detail: "frontNineKey and backNineKey are required for 18-hole generation" });
      }
    }
    if (holes === 9) {
      if (!layoutKey) {
        return res.status(400).json({ ok: false, error: "layout_required_for_9", detail: "layoutKey is required for 9-hole generation" });
      }
    }

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
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status,
           layout_key, front_nine_key, back_nine_key, updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7,
           $8, $9, $10, now())
        ON CONFLICT ON CONSTRAINT booking_times_unique_slot
        DO UPDATE SET
          max_players = EXCLUDED.max_players,
          price_per_player_cents = EXCLUDED.price_per_player_cents,
          status = CASE
            WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
            WHEN booking_times.status = 'BLOCKED' THEN 'BLOCKED'
            ELSE EXCLUDED.status
          END,
          updated_at = now()
        `,
        [courseId, date, t, holes, maxPlayers, pricePerPlayerCents, status,
         layoutKey, frontNineKey, backNineKey]
      );
      upserts += r.rowCount || 0;
    }

    res.json({
      ok: true,
      generated: times.length,
      upserts,
      holes,
      layoutKey,
      frontNineKey,
      backNineKey,
    });
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
      ON CONFLICT ON CONSTRAINT booking_times_unique_slot
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
// -----------------------------
// ✅ Course admin: analytics endpoints (SCOPED to own course)
// Manager-only
// -----------------------------

// 1) Bookings counters: today / week / month (or preset range)
router.get(
  "/course-admin/analytics/bookings",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();
      const start = _parseYmd(req.query.start);
      const end = _parseYmd(req.query.end);

      const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) return res.json({ ok: true, bookings: { today: 0, week: 0, month: 0 } });

      const courseId = c.rows[0].id;

      const wantsPreset = !!(start && end);
      const spanDays = wantsPreset ? _diffDaysInclusive(start, end) : null;

      async function countWhere(extraSql, extraParams = []) {
        const q = `
          SELECT COUNT(*)::int AS n
          FROM booking_bookings b
          WHERE b.course_id = $1
            ${extraSql}
        `;
        const r = await db.query(q, [courseId].concat(extraParams));
        return Number(r.rows[0]?.n || 0);
      }

      let today = 0, week = 0, month = 0;

      if (wantsPreset && spanDays != null) {
        if (spanDays <= 1) {
          today = await countWhere(`AND b.created_at::date = $2::date`, [start]);
        } else if (spanDays <= 7) {
          week = await countWhere(
            `AND b.created_at::date BETWEEN $2::date AND $3::date`,
            [start, end]
          );
        } else {
          month = await countWhere(
            `AND b.created_at::date BETWEEN $2::date AND $3::date`,
            [start, end]
          );
        }
      } else {
        today = await countWhere(`AND b.created_at::date = CURRENT_DATE`);
        week = await countWhere(`AND b.created_at >= date_trunc('week', NOW())`);
        month = await countWhere(`AND b.created_at >= date_trunc('month', NOW())`);
      }

      return res.json({ ok: true, bookings: { today, week, month } });
    } catch (e) {
      console.error("course-admin/analytics/bookings", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// 2) Funnel (last N days) from booking_analytics_events (scoped)
router.get(
  "/course-admin/analytics/funnel",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();
      const days = Number(req.query.days || 30);
      const range = Number.isFinite(days) && days > 0 ? `${days} days` : "30 days";

      const viewsQ = await db.query(
        `
        SELECT COUNT(*)::int AS n
        FROM booking_analytics_events
        WHERE course_slug=$1
          AND event_type='course_view'
          AND occurred_at >= NOW() - $2::interval
        `,
        [slug, range]
      );

      const timesQ = await db.query(
        `
        SELECT COUNT(*)::int AS n
        FROM booking_analytics_events
        WHERE course_slug=$1
          AND event_type='times_view'
          AND occurred_at >= NOW() - $2::interval
        `,
        [slug, range]
      );

      const confirmedQ = await db.query(
        `
        SELECT COUNT(*)::int AS n
        FROM booking_analytics_events
        WHERE course_slug=$1
          AND event_type='booking_confirmed'
          AND occurred_at >= NOW() - $2::interval
        `,
        [slug, range]
      );

      const views = Number(viewsQ.rows[0]?.n || 0);
      const times = Number(timesQ.rows[0]?.n || 0);
      const confirmed = Number(confirmedQ.rows[0]?.n || 0);

      const started = confirmed; // proxy (same pattern you used elsewhere)

      const conversion = {
        view_to_confirmed: views > 0 ? confirmed / views : 0,
        times_to_confirmed: times > 0 ? confirmed / times : 0,
        started_to_confirmed: started > 0 ? confirmed / started : 0,
      };

      return res.json({
        ok: true,
        funnel: { views, times, started, confirmed },
        conversion,
      });
    } catch (e) {
      console.error("course-admin/analytics/funnel", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// 3) Daily series (bookings + revenue) from booking_bookings (scoped)
router.get(
  "/course-admin/analytics/daily",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();
      const start = _parseYmd(req.query.start);
      const end = _parseYmd(req.query.end);

      const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) return res.json({ ok: true, rows: [] });
      const courseId = c.rows[0].id;

      const params = [courseId];
      let where = `WHERE b.course_id = $1`;

      if (start && end) {
        params.push(start, end);
        where += ` AND b.created_at::date BETWEEN $2::date AND $3::date`;
      } else if (start && !end) {
        params.push(start);
        where += ` AND b.created_at::date >= $2::date`;
      } else if (!start && end) {
        params.push(end);
        where += ` AND b.created_at::date <= $2::date`;
      } else {
        where += ` AND b.created_at >= NOW() - INTERVAL '30 days'`;
      }

      const r = await db.query(
        `
        SELECT
          b.created_at::date::text AS day,
          COUNT(*)::int AS bookings,
          COALESCE(SUM(
            COALESCE(b.total_cents,0)
            + COALESCE(b.cart_fee_cents,0)
            + COALESCE(b.hire_clubs_fee_cents,0)
          ), 0)::bigint AS revenue_cents
        FROM booking_bookings b
        ${where}
        GROUP BY b.created_at::date
        ORDER BY b.created_at::date ASC;
        `,
        params
      );

      return res.json({ ok: true, rows: r.rows || [] });
    } catch (e) {
      console.error("course-admin/analytics/daily", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// 4) CSV export (scoped)
router.get(
  "/course-admin/analytics/export.csv",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();
      const start = _parseYmd(req.query.start);
      const end = _parseYmd(req.query.end);

      const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="teeradar_${slug}_bookings.csv"`);
        return res.send("course_slug,created_at,play_date,tee_time,holes,players,name,email,phone,reference,paid,gross_cents\n");
      }
      const courseId = c.rows[0].id;

      const params = [courseId];
      let where = `WHERE b.course_id = $1`;

      if (start && end) {
        params.push(start, end);
        where += ` AND b.created_at::date BETWEEN $2::date AND $3::date`;
      } else if (start && !end) {
        params.push(start);
        where += ` AND b.created_at::date >= $2::date`;
      } else if (!start && end) {
        params.push(end);
        where += ` AND b.created_at::date <= $2::date`;
      } else {
        where += ` AND b.created_at >= NOW() - INTERVAL '30 days'`;
      }

      const r = await db.query(
        `
        SELECT
          $2::text AS course_slug,
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
          (COALESCE(b.total_cents,0) + COALESCE(b.cart_fee_cents,0) + COALESCE(b.hire_clubs_fee_cents,0))::bigint AS gross_cents
        FROM booking_bookings b
        ${where}
        ORDER BY b.created_at DESC
        LIMIT 5000;
        `,
        [courseId, slug].concat(params.slice(1)) // keep course_slug constant as $2
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
      res.setHeader("Content-Disposition", `attachment; filename="teeradar_${slug}_bookings.csv"`);
      return res.send(csv);
    } catch (e) {
      console.error("course-admin/analytics/export.csv", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);
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
    WITH all_bookings AS (
      -- online bookings (1 row per booking)
      SELECT
        b.course_id,
        b.play_date::date AS booking_date,
        b.created_at
      FROM booking_bookings b
      WHERE (b.status IS NULL OR b.status <> 'cancelled')

      UNION ALL

      -- manual bookings: many rows per booking, collapse to 1 row per reference
      SELECT
        m.course_id,
        m.play_date::date AS booking_date,
        m.created_at
      FROM (
        SELECT
          course_id,
          play_date,
          MIN(created_at) AS created_at,
          reference
        FROM booking_manual_slots
        WHERE reference IS NOT NULL AND reference <> ''
        GROUP BY course_id, play_date, reference
      ) m
    )
    SELECT COUNT(*)::int AS n
    FROM all_bookings b
    WHERE 1=1
      ${whereCourse}
      ${extraSql}
  `;

  const r = await db.query(q, params);
  return Number(r.rows[0]?.n || 0);
}

    let today = 0, week = 0, month = 0;

if (wantsPreset && spanDays != null) {
  if (spanDays <= 1) {
    // TODAY
    today = await countWhere(
      `AND b.booking_date = $${p.length + 1}::date`,
      [start]
    );

  } else if (spanDays <= 7) {
    // WEEK
    week = await countWhere(
      `AND b.booking_date BETWEEN $${p.length + 1}::date AND $${p.length + 2}::date`,
      [start, end]
    );

  } else {
    // MONTH
    month = await countWhere(
      `AND b.booking_date BETWEEN $${p.length + 1}::date AND $${p.length + 2}::date`,
      [start, end]
    );
  }

} else {
  // normal mode
  today = await countWhere(`AND b.booking_date = CURRENT_DATE`);
  week  = await countWhere(
    `AND b.booking_date >= date_trunc('week', CURRENT_DATE)::date`
  );
  month = await countWhere(
    `AND b.booking_date >= date_trunc('month', CURRENT_DATE)::date`
  );
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
    ON CONFLICT ON CONSTRAINT booking_times_unique_slot
    DO NOTHING;
    `,
    [courseId, play_date, tee_time, holes]
  );

 // 1) Count manual slots (1 row = 1 player slot) ✅ count ALL rows
const ms = await db.query(
  `
  SELECT COUNT(*)::int AS n
  FROM booking_manual_slots
  WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
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
  has_cart,          // ✅ FIX
  has_hire_clubs,    // ✅ FIX
  cart_qty,          // ✅ FIX
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
          pricePerPlayerCents: await getTeePricePerPlayerCents({
  courseId,
  playDate: play_date,
  teeTime: tee_time,
  holes,
}),
totalCents:
  (await getTeePricePerPlayerCents({
    courseId,
    playDate: play_date,
    teeTime: tee_time,
    holes,
  })) * (players || 1),
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

    const playDate = String(_pickAny(req.body, ["play_date", "playDate", "date"], "") || "").trim();
    const tee_time = String(_pickAny(req.body, ["tee_time", "teeTime", "time"], "") || "").trim();
    const holes = Number(_pickAny(req.body, ["holes"], 18));

    // ✅ NEW: layout identity (THIS IS THE IMPORTANT PART)
    const layout_key =
      String(_pickAny(req.body, ["layout_key", "layoutKey"], "") || "").trim() || null;

    const front_nine_key =
      String(_pickAny(req.body, ["front_nine_key", "front9_key", "front9Key"], "") || "").trim() || null;

    const back_nine_key =
      String(_pickAny(req.body, ["back_nine_key", "back9_key", "back9Key"], "") || "").trim() || null;

    const playersRaw = Number(_pickAny(req.body, ["players", "numPlayers"], 1));
    const players = Math.max(1, Math.min(4, Number.isFinite(playersRaw) ? playersRaw : 1));

    const name = String(_pickAny(req.body, ["name"], "") || "").trim();
    const email = String(_pickAny(req.body, ["email"], "") || "").trim().toLowerCase();
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;

    const paid = parseBool(_pickAny(req.body, ["paid"], false), false);
    const checked_in = parseBool(_pickAny(req.body, ["checked_in", "checkedIn"], false), false);

    const has_cart = parseBool(_pickAny(req.body, ["has_cart", "hasCart"], false), false);
    const has_hire_clubs = parseBool(_pickAny(req.body, ["has_hire_clubs", "hasHireClubs"], false), false);

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

    if (!playDate) return res.status(400).json({ ok: false, error: "date_required" });
    if (!tee_time || !/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    client = await db.connect();
    await client.query("BEGIN");
    didBegin = true;

    const courseRowQ = await client.query(
      `SELECT duration_9_mins, duration_18_mins FROM booking_courses WHERE id=$1 LIMIT 1;`,
      [courseId]
    );
    const courseRow = courseRowQ.rows[0] || {};

    const startAtIso = toIsoDateTimeLocal(playDate, tee_time);
    const dur = durationMinsForHoles(courseRow, holes);
    const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();

    const inv = await enforceAddonInventory(client, {
      courseId,
      startAtIso,
      endAtIso,
      cartQtyWanted: cart_qty,
      hireClubsQtyWanted: hire_clubs_qty,
    });
    if (!inv.ok) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({ ok: false, ...inv });
    }

    // ✅ FIX: advisory lock MUST include layout identity
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`,
      [
        `manualslots:${courseId}:${playDate}:${tee_time}:${holes}:${layout_key || ""}:${front_nine_key || ""}:${back_nine_key || ""}`,
      ]
    );

    const taken = await client.query(
      `
      SELECT slot_index
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        AND COALESCE(layout_key,'') = COALESCE($5,'')
        AND COALESCE(front_nine_key,'') = COALESCE($6,'')
        AND COALESCE(back_nine_key,'') = COALESCE($7,'')
        AND COALESCE(name,'') <> ''
      `,
      [courseId, playDate, tee_time, holes, layout_key, front_nine_key, back_nine_key]
    );

    const takenSet = new Set((taken.rows || []).map((r) => Number(r.slot_index)));
    const freeSlots = [1, 2, 3, 4].filter((i) => !takenSet.has(i));

    if (freeSlots.length < players) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({
        ok: false,
        error: "not_enough_empty_slots",
        remainingSlots: freeSlots.length,
      });
    }

    const reference =
      String(_pickAny(req.body, ["reference"], "") || "").trim() || makeRef("MS");

    const insertedRows = [];

    for (let i = 0; i < players; i++) {
      const slot_index = freeSlots[i];

      const price_per_player_cents = await getTeePricePerPlayerCents({
        courseId,
        playDate,
        teeTime: tee_time,
        holes,
      });

      const ins = await client.query(
        `
        INSERT INTO booking_manual_slots
          (course_id, play_date, tee_time, holes, slot_index,
           layout_key, front_nine_key, back_nine_key,
           reference, name, email, phone,
           paid, checked_in,
           has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
           price_per_player_cents,
           start_at, end_at,
           updated_at)
        VALUES
          ($1,$2::date,$3,$4,$5,
           $6,$7,$8,
           $9,$10,$11,$12,
           $13,$14,
           $15,$16,$17,$18,$19,
           $20,
           $21::timestamptz,$22::timestamptz,
           now())
        RETURNING *;
        `,
        [
          courseId,
          playDate,
          tee_time,
          holes,
          slot_index,

          layout_key,
          front_nine_key,
          back_nine_key,

          reference,
          name || null,
          email || null,
          phone || null,

          paid,
          checked_in,

          i === 0 ? has_cart : false,
          i === 0 ? has_hire_clubs : false,
          i === 0 ? cart_qty : 0,
          i === 0 ? hire_clubs_qty : 0,
          notes,

          price_per_player_cents || 0,
          startAtIso,
          endAtIso,
        ]
      );

      insertedRows.push(ins.rows[0]);
    }

    await client.query("COMMIT");
    didBegin = false;

    return res.json({
      ok: true,
      course_slug: slug,
      play_date: playDate,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      players,
      reference,
      manualSlotsInserted: insertedRows,
    });
  } catch (e) {
    console.error("course-admin/manual-slot POST", e);

    try {
      if (client && didBegin) await client.query("ROLLBACK");
    } catch {}

    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    try {
      if (client) client.release();
    } catch {}
  }
});

    // ✅ Course admin — add booking (alias for frontend)
// POST /api/book/course-admin/booking
// ✅ Course admin — add booking (alias for frontend)
// POST /api/book/course-admin/booking
// This now uses the SAME multi-player-safe logic as /course-admin/manual-slot
router.post("/course-admin/booking", requireCourseAdmin, async (req, res) => {
  let client = null;
  let didBegin = false;

  try {
    const slug = req.courseAdmin.slug;

    const playDate = String(
      req.body?.play_date || req.body?.playDate || req.body?.date || ""
    ).trim();

    const tee_time = String(
      req.body?.tee_time || req.body?.teeTime || req.body?.time || ""
    ).trim();

    const holes = Number(req.body?.holes || 18);

    // ✅ players count (default 1, clamp 1..4)
    const playersRaw = Number(req.body?.players || req.body?.numPlayers || 1);
    const players = Math.max(1, Math.min(4, Number.isFinite(playersRaw) ? playersRaw : 1));

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;

    const paid = parseBool(req.body?.paid, false);
    const checked_in = parseBool(req.body?.checked_in, false);

    // --- add-ons ---
    const addonIdsRaw = req.body?.addonIds ?? req.body?.addon_ids;
    const addonIds = Array.isArray(addonIdsRaw)
      ? addonIdsRaw
      : typeof addonIdsRaw === "string"
      ? addonIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const picked = new Set(addonIds);

    const has_cart =
      picked.size > 0 ? picked.has("cart") : parseBool(req.body?.has_cart, false);

    const has_hire_clubs =
      picked.size > 0 ? picked.has("hire_clubs") : parseBool(req.body?.has_hire_clubs, false);

    const cart_qty = Math.max(
      0,
      Math.min(4, Number(req.body?.cart_qty ?? req.body?.cartQty ?? (has_cart ? 1 : 0)))
    );

    const hire_clubs_qty = Math.max(
      0,
      Math.min(4, Number(req.body?.hire_clubs_qty ?? req.body?.hireClubsQty ?? (has_hire_clubs ? 1 : 0)))
    );

    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    // validation
    if (!playDate) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(playDate)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    if (email && !isLikelyEmail(email)) return res.status(400).json({ ok: false, error: "email_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ CONNECT + BEGIN (prevents slot collisions)
    client = await db.connect();
    await client.query("BEGIN");
    didBegin = true;

    // ✅ compute usage window for overlap enforcement
    const courseRowQ = await client.query(
      `SELECT duration_9_mins, duration_18_mins, cart_qty, hire_clubs_qty FROM booking_courses WHERE id=$1 LIMIT 1;`,
      [courseId]
    );
    const courseRow = courseRowQ.rows[0] || {};

    const startAtIso = toIsoDateTimeLocal(playDate, tee_time);
    const dur = durationMinsForHoles(courseRow, holes);
    const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();

    // ✅ enforce inventory
    const inv = await enforceAddonInventory(client, {
      courseId,
      startAtIso,
      endAtIso,
      cartQtyWanted: cart_qty,
      hireClubsQtyWanted: hire_clubs_qty,
    });
    if (!inv.ok) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({ ok: false, ...inv });
    }

    // ✅ lock this tee time to avoid two staff grabbing the same slot_index
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [
      `manualslots:${courseId}:${playDate}:${tee_time}:${holes}`,
    ]);

    // ensure tee time exists (optional but keeps sheet consistent)
    await client.query(
      `
      INSERT INTO booking_times
        (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status, created_at, updated_at)
      VALUES
        ($1, $2::date, $3, $4, 4, 0, 0, 'AVAILABLE', now(), now())
      ON CONFLICT DO NOTHING;
      `,
      [courseId, playDate, tee_time, holes]
    );

    // find taken slots
    const taken = await client.query(
      `
      SELECT slot_index
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        AND COALESCE(name,'') <> ''
      `,
      [courseId, playDate, tee_time, holes]
    );

    const takenSet = new Set((taken.rows || []).map((r) => Number(r.slot_index)));
    const freeSlots = [1, 2, 3, 4].filter((i) => !takenSet.has(i));

    if (freeSlots.length < players) {
      await client.query("ROLLBACK");
      didBegin = false;
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

      // ✅ add-ons only stored ONCE (slot 1 of this booking)
      const isFirst = i === 0;
      const slot_cart_qty = isFirst ? cart_qty : 0;
      const slot_hire_clubs_qty = isFirst ? hire_clubs_qty : 0;

      const r = await client.query(
        `
        INSERT INTO booking_manual_slots
          (course_id, play_date, tee_time, holes, slot_index, reference, name, email, phone,
           paid, checked_in, has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
           start_at, end_at, created_at, updated_at)
        VALUES
          ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14,$15,$16,
           $17::timestamptz,$18::timestamptz, now(), now())
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
          playDate,
          tee_time,
          holes,
          slot_index,
          reference,
          name,
          email || null,
          phone || null,
          paid,
          checked_in,
          slot_cart_qty > 0,
          slot_hire_clubs_qty > 0,
          slot_cart_qty,
          slot_hire_clubs_qty,
          notes || null,
          startAtIso,
          endAtIso,
        ]
      );

      filled.push(r.rows[0]);
    }

    await client.query("COMMIT");
    didBegin = false;

    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date: playDate,
      tee_time,
      holes,
    });

    // optional email (send once)
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
          date: playDate,
          time: tee_time,
          holes,
          players,
          reference,
          pricePerPlayerCents: await getTeePricePerPlayerCents({
  courseId,
  playDate,
  teeTime: tee_time,
  holes,
}),
totalCents:
  (await getTeePricePerPlayerCents({
    courseId,
    playDate,
    teeTime: tee_time,
    holes,
  })) * players,
          cartCents,
          hireClubsCents,
          source: "manual",
        });
      }
    } catch (e) {
      console.warn("manual booking email failed (non-fatal):", e?.message || e);
    }
// ✅ ADD THIS: record manual booking in analytics
try {
  // 1) booking_confirmed event (used by funnel + counts)
  recordBookingEvent(req, {
    courseSlug: slug,
    eventType: "booking_confirmed",
    payload: {
      slug,
      date: playDate,
      time: tee_time,
      holes,
      players,
      reference,
      manual: true,
    },
  });

  // 2) also record generic analytics event (used by admin charts)
  recordEvent({
    type: "booking_confirmed",
    payload: {
      slug,
      date: playDate,
      time: tee_time,
      holes,
      players,
      reference,
      source: "manual",
    },
  });
} catch (e) {
  console.warn("manual booking analytics failed (non-fatal):", e?.message || e);
}
    return res.json({ ok: true, reference, rows: filled, sync });
  } catch (e) {
    console.error("course-admin/booking POST", e);

    try {
      if (client && didBegin) {
        await client.query("ROLLBACK");
        didBegin = false;
      }
    } catch (rbErr) {
      console.error("manual booking rollback failed", rbErr);
    }

    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    try {
      if (client) client.release();
    } catch {}
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
router.put("/course-template", requireCourseAdmin, requireCourseAdminManager, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    const timezone = String(req.body?.timezone || "Australia/Perth").trim() || "Australia/Perth";
    let template = null;

if (req.body?.template && typeof req.body.template === "object") {
  template = req.body.template;
} else if (typeof req.body?.template === "string" && req.body.template.trim()) {
  try {
    template = JSON.parse(req.body.template);
  } catch {
    template = null;
  }
}

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
// Body: { startDate, daysAhead, mode, debug }
// mode: "skip" (default) OR "overwrite-range"
router.post("/generate-from-template", requireCourseAdmin, requireCourseAdminManager, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    const debug = String(req.body?.debug || "") === "1" || req.body?.debug === 1 || req.body?.debug === true;

    let startDate = String(req.body?.startDate || req.body?.start_date || "").trim(); // YYYY-MM-DD
    const daysAhead = Math.max(1, Math.min(120, Number(req.body?.daysAhead || 30)));
    const mode = String(req.body?.mode || "skip").trim().toLowerCase();

    // ✅ NEW: run id + always log a DB snapshot (so you can see truth in Render logs)
    const runId = Math.random().toString(16).slice(2, 10);
    const dlog = (...args) => { if (debug) console.log(...args); };
    const alog = (...args) => console.log(...args);

    if (!slug) return res.status(401).json({ ok: false, error: "not_course_admin" });

    if (!startDate) {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      startDate = `${yyyy}-${mm}-${dd}`;
    }

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
    const daysCfg = template.days || {};

    // Parse startDate safely
    const m = startDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return res.status(400).json({ ok: false, error: "startDate_invalid" });

    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(start.getTime())) return res.status(400).json({ ok: false, error: "startDate_invalid" });

    const end = new Date(start);
    end.setDate(end.getDate() + daysAhead);

    // durations (used for back-9 blocking)
    const s = await db.query(
      `SELECT duration_9_mins, duration_18_mins
       FROM booking_course_settings
       WHERE course_id = $1
       LIMIT 1;`,
      [courseId]
    );
    const dur9 = Number(s.rows[0]?.duration_9_mins || 135) || 135;
    const dur18 = Number(s.rows[0]?.duration_18_mins || 360) || 360;

    const back9CenterOffset = Math.max(0, dur9 - 15);
    const back9HalfWindow = 15;

    // normalize keys (treat "Select" as empty) + keep stable
    const cleanKey = (v) => {
      const s = String(v || "").trim();
      if (!s) return "";
      if (s.toLowerCase() === "select") return "";
      return s.toLowerCase();
    };

    // ✅ NEW: normalize/validate window layout keys against saved course layouts
    // This prevents stale template keys generating old layouts.
    const layoutsRow = await db.query(
      `SELECT layouts, routes18
       FROM booking_course_layouts
       WHERE course_id = $1
       LIMIT 1;`,
      [courseId]
    );

    const layouts = Array.isArray(layoutsRow.rows?.[0]?.layouts) ? layoutsRow.rows[0].layouts : [];
    const routes18 = Array.isArray(layoutsRow.rows?.[0]?.routes18) ? layoutsRow.rows[0].routes18 : [];

    const layoutKeySet9 = new Set(layouts.map(x => cleanKey(x?.key)).filter(Boolean));
    const routeKeySet18 = new Set(
      routes18
        .map(r => {
          const f = cleanKey(r?.front9_key ?? r?.front9Key ?? r?.front_nine_key ?? r?.frontNineKey);
          const b = cleanKey(r?.back9_key ?? r?.back9Key ?? r?.back_nine_key ?? r?.backNineKey);
          return (f && b) ? `18:${f}|${b}` : "";
        })
        .filter(Boolean)
    );

    const firstDayCfg = daysCfg[String(_weekdayISO(start))] || null;

    alog(`🧪 [${runId}] generate-from-template START`, {
      slug,
      courseId,
      startDate,
      daysAhead,
      mode,
      debug,
      dur9,
      dur18,
      layoutKeySet9: Array.from(layoutKeySet9),
      routeKeySet18: Array.from(routeKeySet18),
      firstDayCfgWindows: Array.isArray(firstDayCfg?.windows) ? firstDayCfg.windows.length : null,
    });

    // Optional overwrite range
    if (mode === "overwrite-range") {
      const del = await db.query(
        `DELETE FROM booking_times
         WHERE course_id = $1
           AND play_date >= $2::date
           AND play_date < $3::date
           AND status <> 'BOOKED'
         RETURNING id;`,
        [courseId, startDate, _isoDate(end)]
      );
      alog(`🧪 [${runId}] overwrite-range deleted rows`, { rowCount: del.rowCount || 0 });
    }

    let inserted = 0;
    let skipped = 0;

    // Collect debug summary per-day (only first ~3 days to avoid huge payload)
    const debugDays = [];

    await db.query("BEGIN");
    try {
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const playDate = _isoDate(d);
        const wd = String(_weekdayISO(d)); // "1".."7"
        const cfg = daysCfg[wd];

        if (!cfg || cfg.enabled === false) continue;

        const windows = Array.isArray(cfg.windows) ? cfg.windows : [];
        const windows18 = windows.filter(w => Number(w?.holes) === 18);
        const windows9 = windows.filter(w => Number(w?.holes) === 9);

        const blocked9 = [];
        const rows = [];

        // -----------------------
        // 18-hole times
        // -----------------------
        for (const w of windows18) {
          const interval = Number(w.intervalMins || w.interval || 10);
          const maxPlayers = Number(w.maxPlayers || 4);
          const pricePerPlayerCents = Number(w.pricePerPlayerCents || w.price_per_player_cents || 0);
          const startMin = _timeToMinutes(w.start);
          const endMin = _timeToMinutes(w.end);

          const frontNineKey = cleanKey(w.front_nine_key || w.front9_key || w.front9Key || w.frontNineKey);
          const backNineKey  = cleanKey(w.back_nine_key  || w.back9_key  || w.back9Key  || w.backNineKey);

          if (!Number.isFinite(interval) || interval < 5 || interval > 60) continue;
          if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4) continue;
          if (!Number.isFinite(pricePerPlayerCents) || pricePerPlayerCents < 0) continue;
          if (startMin === null || endMin === null || endMin <= startMin) continue;

          if (!frontNineKey || !backNineKey) {
            dlog("🧪 SKIP 18 window (missing routing keys)", { playDate, w });
            continue;
          }

          const layoutKey18 = `18:${frontNineKey}|${backNineKey}`;

          // ✅ reject routes not in course layouts (prevents stale "pines|lakes")
          if (routeKeySet18.size > 0 && !routeKeySet18.has(layoutKey18)) {
            dlog("🧪 SKIP 18 window (route not in course layouts)", { playDate, layoutKey18, w });
            continue;
          }

          dlog("🧪 18 window parsed", {
            playDate, interval, maxPlayers, pricePerPlayerCents,
            start: w.start, end: w.end,
            frontNineKey, backNineKey, layoutKey18
          });

          for (let mins = startMin; mins < endMin; mins += interval) {
            const teeTime = _minutesToTime(mins);

            const center = mins + back9CenterOffset;
            const bStart = Math.max(0, center - back9HalfWindow);
            const bEnd = Math.min(24 * 60, center + back9HalfWindow);
            blocked9.push([bStart, bEnd]);

            rows.push({
              course_id: courseId,
              play_date: playDate,
              tee_time: teeTime,
              holes: 18,
              max_players: maxPlayers,
              price_per_player_cents: pricePerPlayerCents,
              layout_key: layoutKey18,
              front_nine_key: frontNineKey,
              back_nine_key: backNineKey,
            });
          }
        }

        // -----------------------
        // 9-hole times
        // -----------------------
        function isBlocked9(mins) {
          return blocked9.some(([a, b]) => mins >= a && mins < b);
        }

        for (const w of windows9) {
          const interval = Number(w.intervalMins || w.interval || 10);
          const maxPlayers = Number(w.maxPlayers || 4);
          const pricePerPlayerCents = Number(w.pricePerPlayerCents || w.price_per_player_cents || 0);
          const startMin = _timeToMinutes(w.start);
          const endMin = _timeToMinutes(w.end);

          const layoutKey9 = cleanKey(w.layout_key || w.layoutKey);

          if (!Number.isFinite(interval) || interval < 5 || interval > 60) continue;
          if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 4) continue;
          if (!Number.isFinite(pricePerPlayerCents) || pricePerPlayerCents < 0) continue;
          if (startMin === null || endMin === null || endMin <= startMin) continue;

          if (!layoutKey9) {
            dlog("🧪 SKIP 9 window (missing layout key)", { playDate, w });
            continue;
          }

          // ✅ reject 9 keys not in course layouts (prevents stale 'pines')
          if (layoutKeySet9.size > 0 && !layoutKeySet9.has(layoutKey9)) {
            dlog("🧪 SKIP 9 window (layout key not in course layouts)", { playDate, layoutKey9, w });
            continue;
          }

          dlog("🧪 9 window parsed", {
            playDate, interval, maxPlayers, pricePerPlayerCents,
            start: w.start, end: w.end,
            layoutKey9
          });

          for (let mins = startMin; mins < endMin; mins += interval) {
            if (isBlocked9(mins)) continue;
            const teeTime = _minutesToTime(mins);

            rows.push({
              course_id: courseId,
              play_date: playDate,
              tee_time: teeTime,
              holes: 9,
              max_players: maxPlayers,
              price_per_player_cents: pricePerPlayerCents,
              layout_key: layoutKey9,
              front_nine_key: "",
              back_nine_key: "",
            });
          }
        }

        if (!rows.length) continue;

        // optional: check what already exists for that day (debug)
        let beforeSummary = null;
        if (debug) {
          const before = await db.query(
            `
            SELECT
              holes,
              layout_key,
              front_nine_key,
              back_nine_key,
              COUNT(*)::int AS c
            FROM booking_times
            WHERE course_id = $1 AND play_date = $2::date
            GROUP BY holes, layout_key, front_nine_key, back_nine_key
            ORDER BY holes, layout_key;
            `,
            [courseId, playDate]
          );
          beforeSummary = before.rows;
        }

        const cols = [
          "course_id",
          "play_date",
          "tee_time",
          "holes",
          "max_players",
          "price_per_player_cents",
          "layout_key",
          "front_nine_key",
          "back_nine_key",
        ];

        const values = [];
        const params = [];
        let p = 1;

        for (const r of rows) {
          values.push(
            `($${p++}, $${p++}::date, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
          );
          params.push(
            r.course_id,
            r.play_date,
            r.tee_time,
            r.holes,
            r.max_players,
            r.price_per_player_cents,
            r.layout_key,
            r.front_nine_key,
            r.back_nine_key
          );
        }

        const onConflict =
          mode === "overwrite-range"
            ? `DO UPDATE SET
                 max_players = EXCLUDED.max_players,
                 price_per_player_cents = EXCLUDED.price_per_player_cents,
                 layout_key = EXCLUDED.layout_key,
                 front_nine_key = EXCLUDED.front_nine_key,
                 back_nine_key = EXCLUDED.back_nine_key,
                 status = CASE
                   WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
                   WHEN booking_times.status = 'BLOCKED' THEN 'BLOCKED'
                   ELSE 'AVAILABLE'
                 END,
                 updated_at = now()`
            : `DO NOTHING`;

        const q = await db.query(
          `INSERT INTO booking_times (${cols.join(", ")})
           VALUES ${values.join(",")}
           ON CONFLICT ON CONSTRAINT booking_times_unique_slot
           ${onConflict}
           RETURNING 1;`,
          params
        );

        const ins = Number(q.rowCount || 0);
        inserted += ins;
        skipped += Math.max(0, rows.length - ins);

        if (debug && debugDays.length < 3) {
          // after insert snapshot for this day
          const after = await db.query(
            `
            SELECT
              holes,
              layout_key,
              front_nine_key,
              back_nine_key,
              COUNT(*)::int AS c
            FROM booking_times
            WHERE course_id = $1 AND play_date = $2::date
            GROUP BY holes, layout_key, front_nine_key, back_nine_key
            ORDER BY holes, layout_key;
            `,
            [courseId, playDate]
          );

          const samp = await db.query(
            `
            SELECT tee_time, holes, layout_key, front_nine_key, back_nine_key
            FROM booking_times
            WHERE course_id = $1 AND play_date = $2::date
            ORDER BY tee_time ASC, holes DESC, layout_key ASC
            LIMIT 10;
            `,
            [courseId, playDate]
          );

          debugDays.push({
            playDate,
            windows18: windows18.length,
            windows9: windows9.length,
            rowsPrepared: rows.length,
            inserted: ins,
            skipped: Math.max(0, rows.length - ins),
            beforeSummary,
            afterSummary: after.rows,
            sample: samp.rows,
          });
        }

        dlog("🧪 day result", {
          playDate,
          rowsPrepared: rows.length,
          inserted: ins,
          skipped: Math.max(0, rows.length - ins),
        });
      }

      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }

    // ✅ ALWAYS log + (optionally) return what the DB actually has for startDate
    const snapSummary = await db.query(
      `
      SELECT
        holes,
        layout_key,
        front_nine_key,
        back_nine_key,
        COUNT(*)::int AS c
      FROM booking_times
      WHERE course_id = $1 AND play_date = $2::date
      GROUP BY holes, layout_key, front_nine_key, back_nine_key
      ORDER BY holes, layout_key;
      `,
      [courseId, startDate]
    );

    const snapSample = await db.query(
      `
      SELECT tee_time, holes, layout_key, front_nine_key, back_nine_key
      FROM booking_times
      WHERE course_id = $1 AND play_date = $2::date
      ORDER BY tee_time ASC, holes DESC, layout_key ASC
      LIMIT 12;
      `,
      [courseId, startDate]
    );

    alog(`🧪 [${runId}] DB SNAPSHOT startDate=${startDate}`, {
      summary: snapSummary.rows || [],
      sample: snapSample.rows || [],
    });

    return res.json({
      ok: true,
      course: c.rows[0],
      startDate,
      daysAhead,
      mode,
      inserted,
      skipped,
      ...(debug
        ? {
            debug: {
              runId,
              startDayDb: snapSummary.rows || [],
              sample: snapSample.rows || [],
              days: debugDays,
              courseLayouts: {
                layouts: layouts.map(x => ({ key: cleanKey(x?.key), label: x?.label })),
                routes18: routes18.map(r => {
                  const f = cleanKey(r?.front9_key ?? r?.front9Key ?? r?.front_nine_key ?? r?.frontNineKey);
                  const b = cleanKey(r?.back9_key ?? r?.back9Key ?? r?.back_nine_key ?? r?.backNineKey);
                  return {
                    label: r?.label,
                    front9_key: f,
                    back9_key: b,
                    routeKey: (f && b) ? `18:${f}|${b}` : "",
                  };
                }),
              },
            },
          }
        : {}),
    });
  } catch (err) {
    console.error("POST /generate-from-template error:", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
});
// ✅ NEW: Course admin — booking analytics summary (scoped)
// Uses booking_bookings + booking_analytics_events (source of truth)
router.get("/course-admin/analytics/summary", requireCourseAdmin, requireCourseAdminManager, async (req, res) => {
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
// ✅ NEW: Course admin (MANAGER ONLY) — analytics daily series
router.get(
  "/course-admin/analytics/daily",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = req.courseAdmin.slug;
      const start = _parseYmd(req.query.start);
      const end = _parseYmd(req.query.end);

      const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });
      const courseId = c.rows[0].id;

      const params = [courseId];
      let where = `WHERE b.course_id = $1`;

      if (start && end) {
        params.push(start, end);
        where += ` AND b.created_at::date BETWEEN $2::date AND $3::date`;
      } else if (start && !end) {
        params.push(start);
        where += ` AND b.created_at::date >= $2::date`;
      } else if (!start && end) {
        params.push(end);
        where += ` AND b.created_at::date <= $2::date`;
      } else {
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

      return res.json({ ok: true, rows: r.rows || [] });
    } catch (e) {
      console.error("course-admin/analytics/daily", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// ✅ NEW: Course admin (MANAGER ONLY) — export bookings CSV
router.get(
  "/course-admin/analytics/export.csv",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = req.courseAdmin.slug;
      const start = _parseYmd(req.query.start);
      const end = _parseYmd(req.query.end);

      const c = await db.query(`SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`, [slug]);
      if (!c.rows.length) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="teeradar_bookings.csv"`);
        return res.send("created_at,play_date,tee_time,holes,players,name,email,phone,reference,paid,gross_cents\n");
      }
      const courseId = c.rows[0].id;

      const params = [courseId];
      let where = `WHERE b.course_id = $1`;

      if (start && end) {
        params.push(start, end);
        where += ` AND b.created_at::date BETWEEN $2::date AND $3::date`;
      } else if (start && !end) {
        params.push(start);
        where += ` AND b.created_at::date >= $2::date`;
      } else if (!start && end) {
        params.push(end);
        where += ` AND b.created_at::date <= $2::date`;
      } else {
        where += ` AND b.created_at >= NOW() - INTERVAL '30 days'`;
      }

      const r = await db.query(
        `
        SELECT
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
        ${where}
        ORDER BY b.created_at DESC
        LIMIT 5000;
        `,
        params
      );

      const header = [
        "created_at","play_date","tee_time","holes","players",
        "name","email","phone","reference","paid","gross_cents"
      ].join(",");

      const lines = (r.rows || []).map((row) => {
        return [
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
      res.setHeader("Content-Disposition", `attachment; filename="teeradar_bookings_${slug}.csv"`);
      return res.send(csv);
    } catch (e) {
      console.error("course-admin/analytics/export.csv", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);
// =======================
// Course Admin Analytics (insights)
// =======================
router.get(
  "/course-admin/analytics/insights",
  requireCourseAdmin,
  async (req, res) => {
  try {
    const courseId = req.courseAdmin?.course_id;
    if (!courseId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const startDate = String(req.query.start || "").trim() || null;
    const endDate = String(req.query.end || "").trim() || null;
    const mode = String(req.query.mode || "total").trim().toLowerCase(); // total | online | manual

    // default range: last 30 days
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const fallbackEnd = iso(today);
    const d2 = new Date(today);
    d2.setDate(d2.getDate() - 30);
    const fallbackStart = iso(d2);

    const start = startDate || fallbackStart;
    const end = endDate || fallbackEnd;

    const c = await db.query(`SELECT name FROM booking_courses WHERE id = $1`, [courseId]);
    const courseName = c.rows[0]?.name || "";

    // ---------------------------------------------------------
    // ✅ ADD: fees + max players (used for add-on + fill rate)
    // ---------------------------------------------------------
    const feeRes = await db.query(
  `SELECT
     COALESCE(cart_fee_cents,0)::int AS cart_fee_cents,
     COALESCE(hire_clubs_fee_cents,0)::int AS clubs_fee_cents
   FROM booking_courses
   WHERE id = $1
   LIMIT 1`,
  [courseId]
);

// no max_players coming from this query anymore
const fees = feeRes.rows?.[0] || { cart_fee_cents: 0, clubs_fee_cents: 0 };

    const buildTotals = (t) => {
      const bookings = Number(t?.bookings || 0);
      const players = Number(t?.players || 0);
      const carts = Number(t?.carts || 0);
      const clubs = Number(t?.clubs || 0);

      const cartRevenueCents = carts * Number(fees.cart_fee_cents || 0);
      const clubsRevenueCents = clubs * Number(fees.clubs_fee_cents || 0);
      const addOnRevenueCents = cartRevenueCents + clubsRevenueCents;

      const capacityPlayers =
  Number(t?.capacity_players || 0) || (bookings * 4); // fallback only
const fillRate = capacityPlayers ? players / capacityPlayers : 0;

      return {
        bookings,
        players,
        capacityPlayers,
        fillRate,

        grossCents: Number(t?.gross_cents || 0),
        cartRevenueCents,
        clubsRevenueCents,
        addOnRevenueCents,

        leadDaysAvg: Number(t?.lead_days_avg || 0),
        checkinRate: Number(t?.checkin_rate || 0),
        paidRate: Number(t?.paid_rate || 0),
      };
    };

    // -------------------------
    // ONLINE (booking_bookings)
    // -------------------------
    const perDayOnlineRes = await db.query(
      `
      SELECT
        play_date::date AS day,
        COUNT(*)::int AS bookings,
        COALESCE(SUM(players),0)::int AS players,
        COALESCE(SUM(COALESCE(cart_qty,0)),0)::int AS carts,
        COALESCE(SUM(COALESCE(hire_clubs_qty,0)),0)::int AS clubs,
        COALESCE(SUM(COALESCE(total_cents,0)),0)::bigint AS gross_cents
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [courseId, start, end]
    );
    const perDayOnline = perDayOnlineRes.rows || [];

    const totalsOnlineRes = await db.query(
      `
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM(players),0)::int AS players,
        COALESCE(SUM(COALESCE(cart_qty,0)),0)::int AS carts,
        COALESCE(SUM(COALESCE(hire_clubs_qty,0)),0)::int AS clubs,
        COALESCE(SUM(COALESCE(total_cents,0)),0)::bigint AS gross_cents,
        COALESCE(AVG(GREATEST(0, (play_date::date - created_at::date))),0) AS lead_days_avg,
        COALESCE(AVG(CASE WHEN checked_in THEN 1 ELSE 0 END),0) AS checkin_rate,
        COALESCE(AVG(CASE WHEN paid THEN 1 ELSE 0 END),0) AS paid_rate,
        COALESCE(AVG(CASE WHEN COALESCE(cart_qty,0) > 0 THEN 1 ELSE 0 END),0) AS attach_rate_cart,
        COALESCE(AVG(CASE WHEN COALESCE(hire_clubs_qty,0) > 0 THEN 1 ELSE 0 END),0) AS attach_rate_clubs
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      `,
      [courseId, start, end]
    );
    const tOn = totalsOnlineRes.rows[0] || {};

    const popDowOnlineRes = await db.query(
      `
      SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      GROUP BY 1
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const popTimeOnlineRes = await db.query(
      `
      SELECT tee_time, COUNT(*)::int AS bookings
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const topDowOnlineRes = await db.query(
      `
      SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      GROUP BY 1
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    const topTimesOnlineRes = await db.query(
      `
      SELECT tee_time, COUNT(*)::int AS bookings
      FROM booking_bookings
      WHERE course_id = $1
        AND play_date::date >= $2::date AND play_date::date <= $3::date
        AND (status IS NULL OR status <> 'cancelled')
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    // -------------------------
    // MANUAL (booking_manual_slots)
    // group by (play_date, reference) = one manual booking
    // -------------------------
    const perDayManualRes = await db.query(
      `
      WITH mb AS (
        SELECT
          play_date::date AS play_date,
          reference,
          MIN(created_at) AS created_at,
          MIN(tee_time) AS tee_time,
          MIN(holes)::int AS holes,
          COUNT(*) FILTER (WHERE COALESCE(NULLIF(name,''),'') <> '')::int AS players,
          MAX(COALESCE(cart_qty,0))::int AS carts,
          MAX(COALESCE(hire_clubs_qty,0))::int AS clubs,
          BOOL_OR(COALESCE(paid,false)) AS paid_any,
          BOOL_OR(COALESCE(checked_in,false)) AS checked_in_any
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      ),
      fees AS (
        SELECT
          id AS course_id,
          COALESCE(cart_fee_cents,0)::int AS cart_fee_cents,
          COALESCE(hire_clubs_fee_cents,0)::int AS clubs_fee_cents
        FROM booking_courses
        WHERE id = $1
      ),
      priced AS (
        SELECT
          mb.play_date,
          mb.reference,
          mb.players,
          mb.carts,
          mb.clubs,
          mb.paid_any,
          mb.checked_in_any,
          mb.created_at,
          mb.tee_time,
          mb.holes,
          COALESCE(t.price_per_player_cents,0)::int AS ppp,
          (mb.players * COALESCE(t.price_per_player_cents,0)
            + mb.carts * f.cart_fee_cents
            + mb.clubs * f.clubs_fee_cents
          )::bigint AS gross_cents
        FROM mb
        CROSS JOIN fees f
        LEFT JOIN booking_times t
          ON t.course_id = $1
         AND t.play_date::date = mb.play_date
         AND t.tee_time = mb.tee_time
         AND t.holes = mb.holes
      )
      SELECT
        play_date AS day,
        COUNT(*)::int AS bookings,
        COALESCE(SUM(players),0)::int AS players,
        COALESCE(SUM(carts),0)::int AS carts,
        COALESCE(SUM(clubs),0)::int AS clubs,
        COALESCE(SUM(gross_cents),0)::bigint AS gross_cents
      FROM priced
      GROUP BY play_date
      ORDER BY play_date ASC
      `,
      [courseId, start, end]
    );
    const perDayManual = perDayManualRes.rows || [];

    const totalsManualRes = await db.query(
      `
      WITH mb AS (
        SELECT
          play_date::date AS play_date,
          reference,
          MIN(created_at) AS created_at,
          MIN(tee_time) AS tee_time,
          MIN(holes)::int AS holes,
          COUNT(*) FILTER (WHERE COALESCE(NULLIF(name,''),'') <> '')::int AS players,
          MAX(COALESCE(cart_qty,0))::int AS carts,
          MAX(COALESCE(hire_clubs_qty,0))::int AS clubs,
          BOOL_OR(COALESCE(paid,false)) AS paid_any,
          BOOL_OR(COALESCE(checked_in,false)) AS checked_in_any
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      ),
      fees AS (
        SELECT
          id AS course_id,
          COALESCE(cart_fee_cents,0)::int AS cart_fee_cents,
          COALESCE(hire_clubs_fee_cents,0)::int AS clubs_fee_cents
        FROM booking_courses
        WHERE id = $1
      ),
      priced AS (
        SELECT
          mb.*,
          COALESCE(t.price_per_player_cents,0)::int AS ppp,
          (mb.players * COALESCE(t.price_per_player_cents,0)
            + mb.carts * f.cart_fee_cents
            + mb.clubs * f.clubs_fee_cents
          )::bigint AS gross_cents
        FROM mb
        CROSS JOIN fees f
        LEFT JOIN booking_times t
          ON t.course_id = $1
         AND t.play_date::date = mb.play_date
         AND t.tee_time = mb.tee_time
         AND t.holes = mb.holes
      )
      SELECT
        COUNT(*)::int AS bookings,
        COALESCE(SUM(players),0)::int AS players,
        COALESCE(SUM(carts),0)::int AS carts,
        COALESCE(SUM(clubs),0)::int AS clubs,
        COALESCE(SUM(gross_cents),0)::bigint AS gross_cents,
        COALESCE(AVG(GREATEST(0, (play_date::date - created_at::date))),0) AS lead_days_avg,
        COALESCE(AVG(CASE WHEN checked_in_any THEN 1 ELSE 0 END),0) AS checkin_rate,
        COALESCE(AVG(CASE WHEN paid_any THEN 1 ELSE 0 END),0) AS paid_rate,
        COALESCE(AVG(CASE WHEN carts > 0 THEN 1 ELSE 0 END),0) AS attach_rate_cart,
        COALESCE(AVG(CASE WHEN clubs > 0 THEN 1 ELSE 0 END),0) AS attach_rate_clubs
      FROM priced
      `,
      [courseId, start, end]
    );
    const tMan = totalsManualRes.rows[0] || {};

    const popDowManualRes = await db.query(
      `
      WITH mb AS (
        SELECT play_date::date AS play_date, reference
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      )
      SELECT EXTRACT(DOW FROM play_date)::int AS dow, COUNT(*)::int AS bookings
      FROM mb
      GROUP BY 1
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const popTimeManualRes = await db.query(
      `
      WITH mb AS (
        SELECT MIN(tee_time) AS tee_time, play_date::date AS play_date, reference
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      )
      SELECT tee_time, COUNT(*)::int AS bookings
      FROM mb
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const topDowManualRes = await db.query(
      `
      WITH mb AS (
        SELECT play_date::date AS play_date, reference
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      )
      SELECT EXTRACT(DOW FROM play_date)::int AS dow, COUNT(*)::int AS bookings
      FROM mb
      GROUP BY 1
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    const topTimesManualRes = await db.query(
      `
      WITH mb AS (
        SELECT MIN(tee_time) AS tee_time, play_date::date AS play_date, reference
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND reference IS NOT NULL AND reference <> ''
        GROUP BY play_date::date, reference
      )
      SELECT tee_time, COUNT(*)::int AS bookings
      FROM mb
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    // -------------------------
    // TOTAL (combine per-day)
    // -------------------------
    const mapByDay = new Map();
    const addRow = (r) => {
      const day = String(r.day || r.play_date || r.playDate || "");
      if (!day) return;
      const cur =
        mapByDay.get(day) || { day, bookings: 0, players: 0, carts: 0, clubs: 0, gross_cents: 0 };
      cur.bookings += Number(r.bookings || 0);
      cur.players += Number(r.players || 0);
      cur.carts += Number(r.carts || 0);
      cur.clubs += Number(r.clubs || 0);
      cur.gross_cents += Number(r.gross_cents || 0);
      mapByDay.set(day, cur);
    };

    perDayOnline.forEach(addRow);
    perDayManual.forEach(addRow);

    const perDayTotal = Array.from(mapByDay.values()).sort((a, b) =>
      String(a.day).localeCompare(String(b.day))
    );

    const totalsTotal = {
      bookings: Number(tOn.bookings || 0) + Number(tMan.bookings || 0),
      players: Number(tOn.players || 0) + Number(tMan.players || 0),
      carts: Number(tOn.carts || 0) + Number(tMan.carts || 0),
      clubs: Number(tOn.clubs || 0) + Number(tMan.clubs || 0),
      gross_cents: Number(tOn.gross_cents || 0) + Number(tMan.gross_cents || 0),
      lead_days_avg:
        Number(tOn.bookings || 0) > 0 ? Number(tOn.lead_days_avg || 0) : Number(tMan.lead_days_avg || 0),
      checkin_rate: 0,
      paid_rate: 0,
      attach_rate_cart: 0,
      attach_rate_clubs: 0,
    };

    // weighted rates
    const bOn = Number(tOn.bookings || 0);
    const bMan = Number(tMan.bookings || 0);
    const wAvg = (a, wa, b, wb) => {
      const den = wa + wb;
      if (!den) return 0;
      return (Number(a || 0) * wa + Number(b || 0) * wb) / den;
    };

    totalsTotal.checkin_rate = wAvg(tOn.checkin_rate, bOn, tMan.checkin_rate, bMan);
    totalsTotal.paid_rate = wAvg(tOn.paid_rate, bOn, tMan.paid_rate, bMan);
    totalsTotal.attach_rate_cart = wAvg(tOn.attach_rate_cart, bOn, tMan.attach_rate_cart, bMan);
    totalsTotal.attach_rate_clubs = wAvg(tOn.attach_rate_clubs, bOn, tMan.attach_rate_clubs, bMan);

    // -------------------------
    // POPULAR (online/manual/total)
    // -------------------------
    const dowMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const popDowTotalRes = await db.query(
      `
      WITH x AS (
        SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
        FROM booking_bookings
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND (status IS NULL OR status <> 'cancelled')
        GROUP BY 1
        UNION ALL
        SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
        FROM (
          SELECT play_date::date AS play_date, reference
          FROM booking_manual_slots
          WHERE course_id = $1
            AND play_date::date >= $2::date AND play_date::date <= $3::date
            AND reference IS NOT NULL AND reference <> ''
          GROUP BY play_date::date, reference
        ) mb
        GROUP BY 1
      )
      SELECT dow, SUM(bookings)::int AS bookings
      FROM x
      GROUP BY dow
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const popTimeTotalRes = await db.query(
      `
      WITH x AS (
        SELECT tee_time, COUNT(*)::int AS bookings
        FROM booking_bookings
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND (status IS NULL OR status <> 'cancelled')
        GROUP BY tee_time
        UNION ALL
        SELECT tee_time, COUNT(*)::int AS bookings
        FROM (
          SELECT MIN(tee_time) AS tee_time, play_date::date AS play_date, reference
          FROM booking_manual_slots
          WHERE course_id = $1
            AND play_date::date >= $2::date AND play_date::date <= $3::date
            AND reference IS NOT NULL AND reference <> ''
          GROUP BY play_date::date, reference
        ) mb
        GROUP BY tee_time
      )
      SELECT tee_time, SUM(bookings)::int AS bookings
      FROM x
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 1
      `,
      [courseId, start, end]
    );

    const topDowTotalRes = await db.query(
      `
      WITH x AS (
        SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
        FROM booking_bookings
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND (status IS NULL OR status <> 'cancelled')
        GROUP BY 1
        UNION ALL
        SELECT EXTRACT(DOW FROM play_date::date)::int AS dow, COUNT(*)::int AS bookings
        FROM (
          SELECT play_date::date AS play_date, reference
          FROM booking_manual_slots
          WHERE course_id = $1
            AND play_date::date >= $2::date AND play_date::date <= $3::date
            AND reference IS NOT NULL AND reference <> ''
          GROUP BY play_date::date, reference
        ) mb
        GROUP BY 1
      )
      SELECT dow, SUM(bookings)::int AS bookings
      FROM x
      GROUP BY dow
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    const topTimesTotalRes = await db.query(
      `
      WITH x AS (
        SELECT tee_time, COUNT(*)::int AS bookings
        FROM booking_bookings
        WHERE course_id = $1
          AND play_date::date >= $2::date AND play_date::date <= $3::date
          AND (status IS NULL OR status <> 'cancelled')
        GROUP BY tee_time
        UNION ALL
        SELECT tee_time, COUNT(*)::int AS bookings
        FROM (
          SELECT MIN(tee_time) AS tee_time, play_date::date AS play_date, reference
          FROM booking_manual_slots
          WHERE course_id = $1
            AND play_date::date >= $2::date AND play_date::date <= $3::date
            AND reference IS NOT NULL AND reference <> ''
          GROUP BY play_date::date, reference
        ) mb
        GROUP BY tee_time
      )
      SELECT tee_time, SUM(bookings)::int AS bookings
      FROM x
      GROUP BY tee_time
      ORDER BY bookings DESC
      LIMIT 3
      `,
      [courseId, start, end]
    );

    // Build popular objects
    const dowRowOnline = popDowOnlineRes.rows?.[0];
    const timeRowOnline = popTimeOnlineRes.rows?.[0];
    const topDowOnline = (topDowOnlineRes.rows || []).map((r) => ({
      day: dowMap[Number(r.dow)] || "",
      bookings: Number(r.bookings || 0),
    }));
    const topTimesOnline = (topTimesOnlineRes.rows || []).map((r) => ({
      teeTime: String(r.tee_time || ""),
      bookings: Number(r.bookings || 0),
    }));

    const dowRowManual = popDowManualRes.rows?.[0];
    const timeRowManual = popTimeManualRes.rows?.[0];
    const topDowManual = (topDowManualRes.rows || []).map((r) => ({
      day: dowMap[Number(r.dow)] || "",
      bookings: Number(r.bookings || 0),
    }));
    const topTimesManual = (topTimesManualRes.rows || []).map((r) => ({
      teeTime: String(r.tee_time || ""),
      bookings: Number(r.bookings || 0),
    }));

    const dowRowTotal = popDowTotalRes.rows?.[0];
    const timeRowTotal = popTimeTotalRes.rows?.[0];
    const topDowTotal = (topDowTotalRes.rows || []).map((r) => ({
      day: dowMap[Number(r.dow)] || "",
      bookings: Number(r.bookings || 0),
    }));
    const topTimesTotal = (topTimesTotalRes.rows || []).map((r) => ({
      teeTime: String(r.tee_time || ""),
      bookings: Number(r.bookings || 0),
    }));

    const popularOnline = {
      dayOfWeek: dowRowOnline ? dowMap[Number(dowRowOnline.dow)] : "",
      dayOfWeekBookings: dowRowOnline ? Number(dowRowOnline.bookings || 0) : 0,
      teeTime: timeRowOnline ? String(timeRowOnline.tee_time || "") : "",
      teeTimeBookings: timeRowOnline ? Number(timeRowOnline.bookings || 0) : 0,
      attachRateCart: Number(tOn.attach_rate_cart || 0),
      attachRateClubs: Number(tOn.attach_rate_clubs || 0),
      topDays: topDowOnline,
      topTimes: topTimesOnline,
    };

    const popularManual = {
      dayOfWeek: dowRowManual ? dowMap[Number(dowRowManual.dow)] : "",
      dayOfWeekBookings: dowRowManual ? Number(dowRowManual.bookings || 0) : 0,
      teeTime: timeRowManual ? String(timeRowManual.tee_time || "") : "",
      teeTimeBookings: timeRowManual ? Number(timeRowManual.bookings || 0) : 0,
      attachRateCart: Number(tMan.attach_rate_cart || 0),
      attachRateClubs: Number(tMan.attach_rate_clubs || 0),
      topDays: topDowManual,
      topTimes: topTimesManual,
    };

    const popularTotal = {
      dayOfWeek: dowRowTotal ? dowMap[Number(dowRowTotal.dow)] : "",
      dayOfWeekBookings: dowRowTotal ? Number(dowRowTotal.bookings || 0) : 0,
      teeTime: timeRowTotal ? String(timeRowTotal.tee_time || "") : "",
      teeTimeBookings: timeRowTotal ? Number(timeRowTotal.bookings || 0) : 0,
      attachRateCart: Number(totalsTotal.attach_rate_cart || 0),
      attachRateClubs: Number(totalsTotal.attach_rate_clubs || 0),
      topDays: topDowTotal,
      topTimes: topTimesTotal,
    };

    // ---------------------------------------------------------
    // ✅ NEW: build totals in UI-friendly shape (fillRate, addOns)
    // ---------------------------------------------------------
    const totalsOnline = buildTotals(tOn);
    const totalsManual = buildTotals(tMan);
    const totalsTotalBuilt = buildTotals(totalsTotal);

    // choose what the UI should treat as the “main” view
    const pick =
      mode === "online"
        ? { perDay: perDayOnline, totals: totalsOnline, popular: popularOnline }
        : mode === "manual"
        ? { perDay: perDayManual, totals: totalsManual, popular: popularManual }
        : { perDay: perDayTotal, totals: totalsTotalBuilt, popular: popularTotal };

    return res.json({
      ok: true,
      courseId,
      courseName,
      start,
      end,
      mode,

      // main view (what your UI tiles should use)
      perDay: pick.perDay,
      totals: pick.totals,
      popular: pick.popular,

      // also return the split views so your toggles can render instantly
      perDayOnline,
      perDayManual,
      perDayTotal,

      totalsOnline,
      totalsManual,
      totalsTotal: totalsTotalBuilt,

      popularOnline,
      popularManual,
      popularTotal,
    });
  } catch (e) {
    console.error("course-admin/analytics/insights", e?.message || e);
    console.error("course-admin/analytics/insights stack", e?.stack || "");
    return res.status(500).json({ ok: false, error: "internal_error", detail: String(e?.message || e) });
  }
});
// -----------------------------
// ✅ Course admin (MANAGER ONLY): inventory settings (carts + hire clubs)
// GET  /api/book/course-admin/inventory-settings
// POST /api/book/course-admin/inventory-settings
// -----------------------------
router.get(
  "/course-admin/inventory-settings",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();

      const c = await db.query(
        `
        SELECT
          slug, name,
          cart_qty, hire_clubs_qty,
          cart_fee_cents, hire_clubs_fee_cents
        FROM booking_courses
        WHERE slug=$1
        LIMIT 1;
        `,
        [slug]
      );

      if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

      return res.json({ ok: true, course: c.rows[0] });
    } catch (e) {
      console.error("course-admin/inventory-settings GET", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

router.post(
  "/course-admin/inventory-settings",
  requireCourseAdmin,
  requireCourseAdminManager,
  async (req, res) => {
    try {
      const slug = String(req.courseAdmin.slug || "").trim().toLowerCase();

      // allow qty 0..100 (0 means "not offered")
      const cartQty = Number(req.body?.cartQty ?? req.body?.cart_qty ?? 0);
      const hireClubsQty = Number(req.body?.hireClubsQty ?? req.body?.hire_clubs_qty ?? 0);

      // optional fee updates (in cents)
      const cartFeeCents = req.body?.cartFeeCents ?? req.body?.cart_fee_cents;
      const hireClubsFeeCents = req.body?.hireClubsFeeCents ?? req.body?.hire_clubs_fee_cents;

      if (!Number.isFinite(cartQty) || cartQty < 0 || cartQty > 100) {
        return res.status(400).json({ ok: false, error: "cart_qty_invalid" });
      }
      if (!Number.isFinite(hireClubsQty) || hireClubsQty < 0 || hireClubsQty > 100) {
        return res.status(400).json({ ok: false, error: "hire_clubs_qty_invalid" });
      }

      // fees are optional; if provided validate 0..10,000,000 cents
      let cartFeeVal = null;
      let clubsFeeVal = null;

      if (cartFeeCents !== undefined && cartFeeCents !== null && cartFeeCents !== "") {
        cartFeeVal = Number(cartFeeCents);
        if (!Number.isFinite(cartFeeVal) || cartFeeVal < 0 || cartFeeVal > 10000000) {
          return res.status(400).json({ ok: false, error: "cart_fee_invalid" });
        }
      }

      if (hireClubsFeeCents !== undefined && hireClubsFeeCents !== null && hireClubsFeeCents !== "") {
        clubsFeeVal = Number(hireClubsFeeCents);
        if (!Number.isFinite(clubsFeeVal) || clubsFeeVal < 0 || clubsFeeVal > 10000000) {
          return res.status(400).json({ ok: false, error: "hire_clubs_fee_invalid" });
        }
      }

      // Build dynamic update: only overwrite fees if provided
      const fields = ["cart_qty = $2", "hire_clubs_qty = $3"];
      const params = [slug, cartQty, hireClubsQty];
      let idx = 4;

      if (cartFeeVal !== null) {
        fields.push(`cart_fee_cents = $${idx++}`);
        params.push(cartFeeVal);
      }
      if (clubsFeeVal !== null) {
        fields.push(`hire_clubs_fee_cents = $${idx++}`);
        params.push(clubsFeeVal);
      }

      const u = await db.query(
        `
        UPDATE booking_courses
        SET ${fields.join(", ")}, updated_at = now()
        WHERE slug = $1
        RETURNING
          slug, name,
          cart_qty, hire_clubs_qty,
          cart_fee_cents, hire_clubs_fee_cents;
        `,
        params
      );

      if (!u.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

      return res.json({ ok: true, course: u.rows[0] });
    } catch (e) {
      console.error("course-admin/inventory-settings POST", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);
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

    // ✅ NEW: accept layout identity from the UI
    const layoutKeyRaw = String(_pickAny(req.body, ["layout_key", "layoutKey"], "") || "").trim();

    const frontNineKeyRaw = String(
      _pickAny(req.body, ["front_nine_key", "frontNineKey", "front9_key", "front9Key"], "") || ""
    ).trim();

    const backNineKeyRaw = String(
      _pickAny(req.body, ["back_nine_key", "backNineKey", "back9_key", "back9Key"], "") || ""
    ).trim();

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

    // ✅ normalize keys (treat "Select" as empty)
    const cleanKey = (v) => {
      const s = String(v || "").trim();
      if (!s) return "";
      if (s.toLowerCase() === "select") return "";
      return s;
    };

    const layoutKeyClean = cleanKey(layoutKeyRaw);
    const front9Clean = cleanKey(frontNineKeyRaw);
    const back9Clean = cleanKey(backNineKeyRaw);

    // ✅ stable identity so multiple layout options do NOT collide
    let layout_key = "";
    let front_nine_key = "";
    let back_nine_key = "";

    if (holes === 9) {
      // ✅ require a real layout key for 9-hole options
      if (!layoutKeyClean) {
        return res.status(400).json({ ok: false, error: "layout_key_required_for_9" });
      }
      layout_key = layoutKeyClean;
      front_nine_key = "";
      back_nine_key = "";
    } else {
      // ✅ require real front/back keys for 18-hole routings
      if (!front9Clean || !back9Clean) {
        return res.status(400).json({ ok: false, error: "front9_and_back9_required_for_18" });
      }

      front_nine_key = front9Clean;
      back_nine_key = back9Clean;

      // keep this (helps debug + makes layouts readable)
      layout_key = `18:${front_nine_key}|${back_nine_key}`;
    }

    const times = [];
    for (let m = sM; m <= eM; m += intervalMins) times.push(fromMinutes(m));

    let inserted = 0;
    let skipped = 0;

    for (const t of times) {
      const exists = await db.query(
        `
        SELECT 1
        FROM booking_times
        WHERE course_id=$1
          AND play_date=$2::date
          AND tee_time=$3
          AND holes=$4
          AND COALESCE(layout_key,'')=$5
          AND COALESCE(front_nine_key,'')=$6
          AND COALESCE(back_nine_key,'')=$7
        LIMIT 1;
        `,
        [courseId, playDate, t, holes, layout_key, front_nine_key, back_nine_key]
      );

      const isExisting = !!exists.rows.length;

      await db.query(
        `
        INSERT INTO booking_times
          (course_id, play_date, tee_time, holes, max_players, booked_players, price_per_player_cents, status,
           layout_key, front_nine_key, back_nine_key,
           updated_at)
        VALUES
          ($1, $2::date, $3, $4, $5, 0, $6, $7,
           $8, $9, $10,
           now())
        ON CONFLICT (course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key)
        DO UPDATE SET
          max_players = EXCLUDED.max_players,
          price_per_player_cents = EXCLUDED.price_per_player_cents,
          status = CASE
            WHEN booking_times.status = 'BOOKED' THEN 'BOOKED'
            ELSE EXCLUDED.status
          END,
          updated_at = now()
        `,
        [courseId, playDate, t, holes, maxPlayers, pricePerPlayerCents, status, layout_key, front_nine_key, back_nine_key]
      );

      if (isExisting) skipped++;
      else inserted++;
    }

    res.json({
      ok: true,
      slug,
      date: playDate,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      received: {
        layoutKeyRaw,
        frontNineKeyRaw,
        backNineKeyRaw,
      },
      generated: times.length,
      inserted,
      skipped,
    });
  } catch (e) {
    console.error("course-admin/generate-times", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ NEW: delete tee times (course admin)
// DELETE /api/book/course-admin/times?date=YYYY-MM-DD&holes=18(optional)&time=HH:MM(optional)
// - If time is provided: deletes that single tee time row
// - If time is NOT provided: deletes all tee times for that date (optionally filtered by holes)
// - NEVER deletes BOOKED times
// delete tee times for a date (course admin) — FIXED
router.delete("/course-admin/times", requireCourseAdmin, async (req, res) => {
  try {
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    const date = String(req.query.date || "").trim();
    const holes = req.query.holes ? Number(req.query.holes) : null;

    if (!slug) return res.status(401).json({ ok: false, error: "not_course_admin" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (holes !== null && ![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ delete everything for the day EXCEPT BOOKED
    const params = [courseId, date];
    let q = `
      DELETE FROM booking_times
      WHERE course_id = $1
        AND play_date = $2::date
        AND status <> 'BOOKED'
    `;
    if (holes !== null) {
      params.push(holes);
      q += ` AND holes = $3`;
    }

    const del = await db.query(q, params);

    // ✅ optional: immediate sanity check (how many rows remain for that date)
    const remain = await db.query(
      `SELECT COUNT(*)::int AS c FROM booking_times WHERE course_id=$1 AND play_date=$2::date;`,
      [courseId, date]
    );

    return res.json({
      ok: true,
      slug,
      date,
      holes,
      deleted: Number(del.rowCount || 0),
      remaining: Number(remain.rows?.[0]?.c || 0),
    });
  } catch (e) {
    console.error("course-admin/times DELETE", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// view times (course admin)
router.get("/course-admin/times", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const date = String(req.query.date || "").trim();
    const holes = req.query.holes ? Number(req.query.holes) : null;
    const debug = String(req.query.debug || "") === "1";

    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (holes !== null && ![9, 18].includes(holes)) {
      return res.status(400).json({ ok: false, error: "holes_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ Load course layout labels so the API can always return the correct display label,
    // even if some legacy rows are missing front/back keys.
    const layoutCfgQ = await db.query(
      `
      SELECT layouts, routes18
      FROM booking_course_layouts
      WHERE course_id = $1
      LIMIT 1;
      `,
      [courseId]
    );

    const layoutCfg = layoutCfgQ.rows[0] || { layouts: [], routes18: [] };
    const layouts9 = Array.isArray(layoutCfg.layouts) ? layoutCfg.layouts : [];
    const routes18 = Array.isArray(layoutCfg.routes18) ? layoutCfg.routes18 : [];

    const normKey = (v) => String(v || "").trim().toLowerCase();

    // Map 9 key -> label
    const label9ByKey = new Map();
    for (const l of layouts9) {
      const k = normKey(l?.key);
      const lab = String(l?.label || l?.name || "").trim();
      if (k) label9ByKey.set(k, lab || k);
    }

    // Map 18 routeKey -> label (routeKey = "18:front|back" unless an explicit key is provided)
    const label18ByRouteKey = new Map();
    for (const r of routes18) {
      const front = normKey(r?.front9_key || r?.front_nine_key || r?.front9Key || r?.frontNineKey);
      const back = normKey(r?.back9_key || r?.back_nine_key || r?.back9Key || r?.backNineKey);

      const explicitKey = normKey(r?.key);
      const routeKey = explicitKey || (front && back ? `18:${front}|${back}` : "");

      const frontLab = label9ByKey.get(front) || front || "";
      const backLab = label9ByKey.get(back) || back || "";
      const fallbackLabel = frontLab && backLab ? `${frontLab} + ${backLab}` : "";

      const lab = String(r?.label || r?.name || fallbackLabel || routeKey || "").trim();
      if (routeKey) label18ByRouteKey.set(routeKey, lab || routeKey);
    }

    const params = [courseId, date];
    let q = `
      SELECT
        id,
        play_date,

        -- ✅ IMPORTANT: tee_time may be stored as "HH:MM|suffix" - always return clean time for UI
        split_part(tee_time, '|', 1) AS tee_time_clean,

        tee_time,
        holes,
        max_players,
        booked_players,
        price_per_player_cents,
        status,

        layout_key,
        front_nine_key,
        back_nine_key

      FROM booking_times
      WHERE course_id = $1 AND play_date = $2::date
    `;

    if (holes) {
      params.push(holes);
      q += ` AND holes = $3`;
    }

    // ✅ order by clean time so rows don't get weird when suffixes exist
    q += ` ORDER BY tee_time_clean ASC, holes DESC`;

    const { rows } = await db.query(q, params);

    // ✅ Normalize + attach display label so the frontend can show the correct layout always
    const times = (rows || []).map((r) => {
      const holesN = Number(r.holes || 0);

      // Normalize keys
      let layoutKey = normKey(r.layout_key);
      let frontKey = normKey(r.front_nine_key);
      let backKey = normKey(r.back_nine_key);

      // ✅ If legacy rows are missing front/back keys but layout_key is like "18:classic|lakes", parse it
      if (holesN === 18 && layoutKey && (!frontKey || !backKey)) {
        const m = layoutKey.match(/^18:([^|]+)\|([^|]+)$/);
        if (m) {
          frontKey = frontKey || normKey(m[1]);
          backKey = backKey || normKey(m[2]);
        }
      }

      // ✅ If layout_key is missing but front/back exist, rebuild it (keeps UI + availability consistent)
      if (holesN === 18 && (!layoutKey) && frontKey && backKey) {
        layoutKey = `18:${frontKey}|${backKey}`;
      }

      // Layout display label
      let layoutLabel = "";
      if (holesN === 18) {
        layoutLabel =
          label18ByRouteKey.get(layoutKey) ||
          (() => {
            const frontLab = label9ByKey.get(frontKey) || frontKey || "";
            const backLab = label9ByKey.get(backKey) || backKey || "";
            return frontLab && backLab ? `${frontLab} + ${backLab}` : "";
          })();
      } else if (holesN === 9) {
        // for 9s, layout_key is the 9 key
        layoutLabel = label9ByKey.get(layoutKey) || layoutKey || "";
      }

      return {
        ...r,

        // ✅ what UI should use for sorting + display time
        tee_time: String(r.tee_time_clean || r.tee_time || ""),

        // ✅ normalized keys (so UI never falls back to the wrong route)
        layout_key: layoutKey || "",
        front_nine_key: frontKey || "",
        back_nine_key: backKey || "",

        // ✅ NEW: explicit label for UI (this fixes "always shows Pines+Lakes" when keys are missing)
        layout_label: layoutLabel || null,
      };
    });

    if (debug) {
      console.log("🧪 /course-admin/times layout debug", {
        slug,
        date,
        holes,
        sample: times.slice(0, 10).map((t) => ({
          time: t.tee_time,
          holes: t.holes,
          layout_key: t.layout_key,
          front_nine_key: t.front_nine_key,
          back_nine_key: t.back_nine_key,
          layout_label: t.layout_label,
        })),
      });
    }

    return res.json({ ok: true, times });
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
        b.cart_qty,
        b.hire_clubs_qty,
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
// ✅ NEW: cancel ONLINE booking (course admin)
router.post("/course-admin/booking-cancel", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;
    const reference = String(req.body?.reference || "").trim();
    const reason = String(req.body?.reason || "").trim();

    if (!reference) {
      return res.status(400).json({ ok: false, error: "reference_required" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) {
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }

    // Load booking
    const b = await db.query(
      `
      SELECT id, course_id, play_date::text AS play_date, tee_time, holes, status
      FROM booking_bookings
      WHERE reference=$1 AND course_id=$2
      LIMIT 1;
      `,
      [reference, courseId]
    );

    if (!b.rows.length) {
      return res.status(404).json({ ok: false, error: "booking_not_found" });
    }

    const row = b.rows[0];

    // Idempotent
    if (String(row.status).toUpperCase() === "CANCELLED") {
      const sync = await syncBookedPlayersForTime({
        courseId,
        play_date: row.play_date,
        tee_time: row.tee_time,
        holes: row.holes,
      });
      return res.json({ ok: true, already: true, sync });
    }

    await db.query(
      `
      UPDATE booking_bookings
      SET status='CANCELLED',
          cancelled_at=now(),
          cancelled_reason=$3
      WHERE reference=$1 AND course_id=$2;
      `,
      [reference, courseId, reason || null]
    );

    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date: row.play_date,
      tee_time: row.tee_time,
      holes: row.holes,
    });

    return res.json({ ok: true, reference, status: "CANCELLED", sync });
  } catch (e) {
    console.error("course-admin/booking-cancel", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ✅ ADD: toggle checked-in flag (course admin)
// ✅ Course admin: mark a booking checked-in (supports TR- + MAN- refs)
router.post("/course-admin/booking-checkin", requireCourseAdmin, async (req, res) => {
  try {
    const reference = String(req.body?.reference || "").trim();
    const slot = Number(req.body?.slot || 0) || 0; // 1–4 for MAN- slots
    const checkedIn = !!(req.body?.checked_in ?? req.body?.checkedIn ?? false);

    if (!reference) {
      return res.status(400).json({ ok: false, error: "reference_required" });
    }

    // Resolve courseId from slug (works even if req.courseAdmin has no courseId)
    const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
    const courseQ = await db.query(
      `SELECT id FROM booking_courses WHERE slug = $1 LIMIT 1;`,
      [slug]
    );
    const courseId = Number(courseQ.rows?.[0]?.id || 0);
    if (!courseId) {
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }

    if (/^MAN-/.test(reference)) {
      // Manual slots are per-slot rows
      if (!slot || slot < 1 || slot > 4) {
        return res.status(400).json({ ok: false, error: "slot_required_for_manual" });
      }

      await db.query(
        `
        UPDATE booking_manual_slots
        SET checked_in = $1, updated_at = now()
        WHERE course_id = $2
          AND reference = $3
          AND slot_index = $4
        `,
        [checkedIn, courseId, reference, slot]
      );

      return res.json({ ok: true, kind: "manual", reference, slot, checked_in: checkedIn });
    }

    // Normal bookings (TR- etc)
    await db.query(
      `
      UPDATE booking_bookings
      SET checked_in = $1, updated_at = now()
      WHERE course_id = $2
        AND reference = $3
      `,
      [checkedIn, courseId, reference]
    );

    return res.json({ ok: true, kind: "booking", reference, checked_in: checkedIn });
  } catch (e) {
    console.error("course-admin/booking-checkin", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
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

    const playersQuery = (req.query.players ?? req.query.partySize);
    const playersRaw = Array.isArray(playersQuery) ? playersQuery[0] : playersQuery;
    const playersParsed = parseInt(String(playersRaw ?? "2"), 10);
    const players = Math.min(4, Math.max(1, Number.isFinite(playersParsed) ? playersParsed : 2));

    const layoutKeyRaw = String(req.query.layoutKey || req.query.layout || "").trim().toLowerCase();
    const layoutKey = layoutKeyRaw ? layoutKeyRaw : null;

    const earliest = String(req.query.earliest || "06:00").trim();
    const latest = String(req.query.latest || "17:00").trim();
    const debug = String(req.query.debug || "") === "1";

    if (debug) {
      console.log("🧪 GET /availability DEBUG incoming", {
        slug: req.query.slug,
        date: req.query.date,
        holes: req.query.holes,
        players: req.query.players,
        partySize: req.query.partySize,
        playersRaw,
        playersResolved: players,
        earliest: req.query.earliest,
        latest: req.query.latest,
        layoutKey,
      });
    }

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(players) || players < 1 || players > 4)
      return res.status(400).json({ ok: false, error: "players_invalid" });

    const sM = toMinutes(earliest);
    const eM = toMinutes(latest);
    if (sM === null || eM === null || eM <= sM) return res.status(400).json({ ok: false, error: "time_range_invalid" });

    const c = await db.query(
      `
      SELECT id, slug, name, cart_qty, hire_clubs_qty, duration_9_mins, duration_18_mins
      FROM booking_courses
      WHERE slug=$1
      LIMIT 1;
      `,
      [slug]
    );

    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseRow = c.rows[0];
    const dur9 = Number(courseRow.duration_9_mins || 210);
    const dur18 = Number(courseRow.duration_18_mins || 390);
    const courseId = courseRow.id;

    // ✅ ADD (minimal): safe dlog fallback so this route can't crash if dlog isn't defined
    const dlog = (...args) => { if (debug) console.log(...args); };

    dlog("🧪 GET /availability course matched", {
      courseId,
      slug,
      date,
      holes,
      players,
      earliest,
      latest,
      layoutKey,
    });

    const courseName = String(courseRow.name || "");
    const courseCartQty = Number(courseRow.cart_qty || 0);
    const courseHireClubsQty = Number(courseRow.hire_clubs_qty || 0);

    // ✅ analytics: availability search
    recordEvent({
      type: "booking_availability_search",
      userId: getClientIp(req) || null,
      courseName: c.rows[0].name,
      meta: { slug, date, holes, players, earliest, latest, layoutKey },
    }).catch(() => {});
    recordBookingEvent(req, {
      courseSlug: slug,
      eventType: "times_view",
      payload: { slug, date, holes, players, earliest, latest, layoutKey },
    }).catch(() => {});

    // ✅ IMPORTANT: availability must be based on *effective remaining* (manual slots + confirmed bookings)
    const { rows } = await db.query(
      `
      WITH t AS (
        SELECT
          -- ✅ FIX: tee_time may be stored like "06:00|18" so keep a clean time for comparisons + output
          split_part(t.tee_time, '|', 1) AS tee_time_clean,

          t.tee_time,
          t.holes,
          COALESCE(t.max_players, 4)::int AS max_players,
          t.price_per_player_cents,
          t.status,
          t.layout_key,
          t.front_nine_key,
          t.back_nine_key,
          COALESCE(ms.manual_count, 0)::int AS manual_booked,
          COALESCE(bk.booked, 0)::int       AS booked
        FROM booking_times t

        -- ✅ Manual slots (COUNT rows, layout-safe)
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS manual_count
          FROM booking_manual_slots
          WHERE course_id = t.course_id
            AND play_date = t.play_date
            AND tee_time  = t.tee_time
            AND holes     = t.holes
            AND layout_key IS NOT DISTINCT FROM t.layout_key
        ) ms ON true

        -- ✅ Confirmed bookings (layout-safe)
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(players),0)::int AS booked
          FROM booking_bookings b
          WHERE b.course_id = t.course_id
            AND b.play_date = t.play_date
            AND b.tee_time  = t.tee_time
            AND b.holes     = t.holes
            AND b.status    = 'CONFIRMED'
            AND b.layout_key IS NOT DISTINCT FROM t.layout_key
        ) bk ON true

        WHERE t.course_id = $1
          AND t.play_date = $2::date
          AND t.holes     = $3
          AND t.status    = 'AVAILABLE'
          AND ($4::text IS NULL OR t.layout_key = $4)

          -- ✅ apply time window (use cleaned time)
          AND (
            (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 + split_part(split_part(t.tee_time, '|', 1), ':', 2)::int) >= $6
            AND
            (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 + split_part(split_part(t.tee_time, '|', 1), ':', 2)::int) <  $7
          )

          -- ✅ 18→9 overlap protection (unchanged logic, but use cleaned time)
          AND (
            $3 <> 9
            OR $4::text IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM booking_bookings bb18
              WHERE bb18.course_id = t.course_id
                AND bb18.play_date = t.play_date
                AND bb18.holes     = 18
                AND bb18.status    = 'CONFIRMED'
                AND bb18.back_nine_key = $4
                AND (
                  (
                    (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 +
                     split_part(split_part(t.tee_time, '|', 1), ':', 2)::int)
                    >=
                    (split_part(bb18.tee_time, ':', 1)::int * 60 +
                     split_part(bb18.tee_time, ':', 2)::int) + $8
                  )
                  AND (
                    (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 +
                     split_part(split_part(t.tee_time, '|', 1), ':', 2)::int)
                    <
                    (split_part(bb18.tee_time, ':', 1)::int * 60 +
                     split_part(bb18.tee_time, ':', 2)::int) + $9
                  )
                )
            )
          )
      )
      SELECT
        -- ✅ FIX: return clean time to frontend
        tee_time_clean AS tee_time,

        holes,
        max_players,
        price_per_player_cents,
        status,
        layout_key,
        front_nine_key,
        back_nine_key,
        (booked + manual_booked)::int AS booked_players,
        (booked + manual_booked)::int AS booked_effective,
        GREATEST(0, (max_players - (booked + manual_booked)))::int AS available_players,
        GREATEST(0, (max_players - (booked + manual_booked)))::int AS remaining_effective
      FROM t
      -- ✅ must fit the requested party size
      WHERE (max_players - (booked + manual_booked)) >= $5
      ORDER BY tee_time_clean ASC;
      `,
      [courseId, date, holes, layoutKey, players, sM, eM, dur9, dur18]
    );

    console.log("🧪 availability rows.length =", Array.isArray(rows) ? rows.length : null);

    // ✅ DEBUG: inspect exact slot to verify maths
    if (debug) {
      const slotDiag = await db.query(
        `
        SELECT
          split_part(t.tee_time, '|', 1) AS tee_time_clean,
          t.tee_time,
          t.holes,
          COALESCE(t.max_players,4)::int AS max_players,
          COALESCE(ms.manual_count,0)::int    AS manual_count,
          COALESCE(bb.booking_players,0)::int AS booking_players,
          (COALESCE(ms.manual_count,0) + COALESCE(bb.booking_players,0))::int AS booked_effective,
          GREATEST(
            0,
            COALESCE(t.max_players,4) - (COALESCE(ms.manual_count,0) + COALESCE(bb.booking_players,0))
          )::int AS remaining_effective,
          t.status,
          t.layout_key
        FROM booking_times t

        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS manual_count
          FROM booking_manual_slots
          WHERE course_id = t.course_id
            AND play_date = t.play_date
            AND tee_time  = t.tee_time
            AND holes     = t.holes
            AND layout_key IS NOT DISTINCT FROM t.layout_key
        ) ms ON true

        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(players),0)::int AS booking_players
          FROM booking_bookings
          WHERE course_id = t.course_id
            AND play_date = t.play_date
            AND tee_time  = t.tee_time
            AND holes     = t.holes
            AND status    = 'CONFIRMED'
            AND layout_key IS NOT DISTINCT FROM t.layout_key
        ) bb ON true

        WHERE t.course_id = $1
          AND t.play_date = $2::date
          AND t.holes     = $3
          AND split_part(t.tee_time, '|', 1) = '06:00'
        LIMIT 1;
        `,
        [courseId, date, holes]
      );

      console.log("🧪 SLOT DIAG 06:00", slotDiag.rows[0] || null);
      console.log("🧪 computed players =", { playersRaw, playersParsed, players });
    }

    // ✅ DEBUG: show what the availability query returned
    if (debug) {
      console.log("🧪 availability query returned", {
        rowCount: Array.isArray(rows) ? rows.length : null,
        firstRow: Array.isArray(rows) && rows.length ? rows[0] : null,
        lastRow: Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null,
      });
    }

    // ✅ DEBUG: if none returned, inspect what's in booking_times for that day regardless of filters
    if (debug && (!rows || rows.length === 0)) {
      const diag = await db.query(
        `
        SELECT status, holes, COUNT(*)::int AS c,
               MIN(tee_time) AS first_time,
               MAX(tee_time) AS last_time
        FROM booking_times
        WHERE course_id = $1
          AND play_date = $2::date
        GROUP BY status, holes
        ORDER BY holes, status;
        `,
        [courseId, date]
      );

      console.log("🧪 availability DIAG booking_times summary", diag.rows);
    }

    const times = await Promise.all(
      (rows || []).map(async (r) => {
        const startAtIso = toIsoDateTimeLocal(date, r.tee_time);
        const dur = durationMinsForHoles(courseRow, r.holes);
        const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();

        // ✅ CHANGE (minimal): make this non-fatal so availability never 500s if this throws
        let cartsUsed = 0;
        let clubsUsed = 0;
        try {
          const usage = await countOverlappingAddonUsage(db, { courseId, startAtIso, endAtIso });
          cartsUsed = Number(usage?.cartsUsed || 0);
          clubsUsed = Number(usage?.clubsUsed || 0);
        } catch (err) {
          if (debug) console.log("🧪 countOverlappingAddonUsage failed (non-fatal)", err?.message || err);
        }

        const cartRemaining = Math.max(0, courseCartQty - cartsUsed);
        const clubsRemaining = Math.max(0, courseHireClubsQty - clubsUsed);

        // ✅ ONLY trust SQL-calculated effective fields
        const bookedEffective = Number(r.booked_effective ?? 0);
        const remainingEffective = Number(r.remaining_effective ?? 0);

        return {
          time: r.tee_time,
          holes: Number(r.holes),

          // ✅ ADD: include layout info so frontend can display it
          layout_key: r.layout_key ?? null,
          front_nine_key: r.front_nine_key ?? null,
          back_nine_key: r.back_nine_key ?? null,

          // ✅ ADD: camelCase aliases (frontend convenience)
          layoutKey: r.layout_key ?? null,
          frontNineKey: r.front_nine_key ?? null,
          backNineKey: r.back_nine_key ?? null,

          maxPlayers: Number(r.max_players ?? 0),

          // raw (debug)
          bookedPlayers: Number(r.booked_players ?? 0),

          // ✅ the values the frontend should use
          bookedEffective,
          remaining: Math.max(0, remainingEffective),
          remainingEffective: Math.max(0, remainingEffective),

          // ✅ aliases so slotRemaining() reads reliably
          remainingPlayers: Math.max(0, remainingEffective),
          playersRemaining: Math.max(0, remainingEffective),
          booked_effective: bookedEffective,
          remaining_effective: Math.max(0, remainingEffective),
          booked_players: Number(r.booked_players ?? 0),

          pricePerPlayerCents: r.price_per_player_cents,
          pricePerPlayer: Number(r.price_per_player_cents || 0) / 100,

          cartQty: courseCartQty,
          clubsQty: courseHireClubsQty,

          cart_qty: courseCartQty,
          hire_clubs_qty: courseHireClubsQty,
          hireClubsQty: courseHireClubsQty,

          cart_remaining: cartRemaining,
          clubs_remaining: clubsRemaining,
          cartsRemaining: cartRemaining,
          hireClubsRemaining: clubsRemaining,

          cartRemaining,
          clubsRemaining,
          cartSoldOut: courseCartQty > 0 && cartRemaining <= 0,
          clubsSoldOut: courseHireClubsQty > 0 && clubsRemaining <= 0,

          durationMins: dur,
        };
      })
    );

    return res.json({
      ok: true,
      times,
      rows: times,
      slots: times,
      teeTimes: times,
      ...(debug
        ? {
            debug: {
              slug,
              date,
              holes,
              players,
              earliest,
              latest,
              layoutKey,
              courseId,
              courseName,
              rowsFound: Array.isArray(rows) ? rows.length : null,
              returnedTimes: Array.isArray(times) ? times.length : null,
              sample: Array.isArray(times) && times.length ? times[0] : null,
            },
          }
        : {}),
    });
  } catch (e) {
    const debug = String(req.query.debug || "") === "1";

    console.error("GET /availability error", e);
    console.error(e?.stack || e);

    // ✅ ADD: when debug=1, return real details to the browser
    if (debug) {
      return res.status(500).json({
        ok: false,
        error: "internal_error",
        message: String(e?.message || e || "unknown_error"),
        stack: String(e?.stack || ""),
      });
    }

    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

function advisoryKeyForSlot({
  courseId,
  dateYmd,
  timeHhMm,
  holes,
  layout_key,
  front_nine_key,
  back_nine_key,
}) {
  const c = Number(courseId) || 0;
  const d = String(dateYmd || "").trim();
  const t = String(timeHhMm || "").trim();
  const h = Number(holes) || 0;

  const lk = String(layout_key || "").trim().toLowerCase();
  const fk = String(front_nine_key || "").trim().toLowerCase();
  const bk = String(back_nine_key || "").trim().toLowerCase();

  // Include routing keys to avoid collisions when multiple routings share the same time
  return `slot:${c}:${d}:${t}:${h}:${lk}:${fk}:${bk}`;
}

async function advisoryLockForSlot(
  client,
  { courseId, dateYmd, timeHhMm, holes, layout_key, front_nine_key, back_nine_key }
) {
  const key = advisoryKeyForSlot({
    courseId,
    dateYmd,
    timeHhMm,
    holes,
    layout_key,
    front_nine_key,
    back_nine_key,
  });

  // Transaction-scoped advisory lock (auto released on COMMIT / ROLLBACK)
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [key]);

  return key;
}

async function handleBook(req, res) {
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

    // ✅ routing keys from UI (needed for multiple 9s / multiple 18 routings)
    const layout_key = req.body?.layout_key ? String(req.body.layout_key).trim().toLowerCase() : null;
    const front_nine_key = req.body?.front_nine_key ? String(req.body.front_nine_key).trim().toLowerCase() : null;
    const back_nine_key = req.body?.back_nine_key ? String(req.body.back_nine_key).trim().toLowerCase() : null;

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

    // ✅ lock per-slot INCLUDING routing keys so overlapping routings don't collide
    await advisoryLockForSlot(client, {
      courseId,
      dateYmd: date,
      timeHhMm: time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
    });

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

    // ✅ Lock the booking_times row for this slot (routing-aware)
    const t = await client.query(
      `
      SELECT status, booked_players, max_players, price_per_player_cents,
             layout_key, front_nine_key, back_nine_key
      FROM booking_times
      WHERE course_id=$1
        AND play_date=$2::date
        AND tee_time=$3
        AND holes=$4
        AND (
          ($4 = 18 AND front_nine_key = $5 AND back_nine_key = $6)
          OR
          ($4 = 9 AND (layout_key IS NOT DISTINCT FROM $7))
        )
      LIMIT 1
      FOR UPDATE;
      `,
      [
        courseId,
        date,
        time,
        holes,
        holes === 18 ? front_nine_key : null,
        holes === 18 ? back_nine_key : null,
        holes === 9 ? layout_key : null,
      ]
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
      (final_has_cart ? cart_fee_cents : 0) +
      (final_has_hire_clubs ? hire_clubs_fee_cents : 0);

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
     layout_key, front_nine_key, back_nine_key,
     created_at)
  VALUES
    ($1,$2::date,$3,$4,$5,
     $6,$7,$8,
     $9,$10,$11,'CONFIRMED',
     $12::timestamptz,$13::timestamptz,
     false,false,
     $14,$15,$16,
     $17,$18,$19,
     $20,$21,$22,
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
        final_has_cart,
        cart_qty,
        cart_fee_cents,
        final_has_hire_clubs,
        hire_clubs_qty,
        hire_clubs_fee_cents,
        timeRow.layout_key || null,
        timeRow.front_nine_key || null,
        timeRow.back_nine_key || null,
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
}

router.post("/book", handleBook);

// keep /availability POST blocked so the frontend can’t accidentally use it
router.post("/availability", (req, res) => {
  return res.status(405).json({
    ok: false,
    error: "method_not_allowed",
    message: "Use GET /availability to list times and POST /book to confirm a booking.",
  });
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