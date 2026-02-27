// backend/bookingRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";
import { Resend } from "resend";
import cookieParser from "cookie-parser"; // ✅ ADD
import { recordEvent } from "./analytics.js";
import jwt from "jsonwebtoken";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();

// ✅ Stripe API version pin (recommended)
const STRIPE_API_VERSION = "2024-06-20";

// ✅ Platform fee in basis points (e.g. 300 = 3%)
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 0);

// ✅ Subscriber discount (defaults to 5%)
const SUBSCRIBER_DISCOUNT_PCT = Number(process.env.SUBSCRIBER_DISCOUNT_PCT || 5);

// Optional: emergency override list (comma-separated emails) if DB lookup isn't ready
const SUBSCRIBER_EMAILS = String(process.env.SUBSCRIBER_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ✅ Determine if an email is an active subscriber (subscriber_status table)
async function isSubscriberEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;

  try {
    const r = await db.query(
      `
      SELECT 1
      FROM subscriber_status
      WHERE lower(email) = lower($1)
        AND status IN ('active','trialing')
      LIMIT 1;
      `,
      [e]
    );

    return r.rows.length > 0;
  } catch (err) {
    console.error("subscriber lookup error", err);
    return false;
  }
}
// ✅ Create Stripe client once (or null if not configured)
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

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
// ✅ Base URL used for redirects / links (Stripe success/cancel, confirmation page, etc.)
const BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.SITE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://teeradar.com.au"
).trim().replace(/\/+$/, "");
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
// ✅ DEBUG flag for sync routing investigations (Render env var DEBUG_SYNC=1)
const DEBUG_SYNC = String(process.env.DEBUG_SYNC || "").trim() === "1";
console.log("🧪 DEBUG_SYNC enabled?", DEBUG_SYNC, "raw=", process.env.DEBUG_SYNC);
router.use((req, res, next) => {
  console.log("📌 bookingRoutes hit:", req.method, req.originalUrl);
  next();
});
// ✅ Stripe webhook MUST use raw body (so it must be registered BEFORE express.json())
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

router.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(500).send("stripe_not_configured");

    let event;
    try {
      const sig = req.headers["stripe-signature"];
      if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send("missing_webhook_secret");
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("stripe webhook signature verify failed", err?.message || err);
      return res.status(400).send("bad_signature");
    }

    try {
      // We only care about Checkout completing
      if (event.type === "checkout.session.completed") {
        const session = event.data?.object || {};
        const meta = session.metadata || {};

        // The metadata is what we’ll rely on to finalize booking
        const slug = String(meta.slug || "").trim();
        const date = String(meta.date || "").trim();
        const time = String(meta.time || "").trim();
        const holes = Number(meta.holes || 0);
        const players = Number(meta.players || 0);

        const golfer_name = String(meta.golfer_name || "").trim();
        const golfer_email = String(meta.golfer_email || "").trim();
        const golfer_phone = String(meta.golfer_phone || "").trim();

        const cart_qty = Number(meta.cart_qty || 0);
        const hire_clubs_qty = Number(meta.hire_clubs_qty || 0);

        const layout_key = String(meta.layout_key || "").trim();
        const front_nine_key = String(meta.front_nine_key || "").trim();
        const back_nine_key = String(meta.back_nine_key || "").trim();

        const reference = String(meta.reference || "").trim();

        // ✅ Call your existing booking logic, but as "paid"
        // We’ll add a tiny helper below that reuses your current code path.
        await finalizePaidBooking({
          slug,
          date,
          time,
          holes,
          players,
          golfer_name,
          golfer_email,
          golfer_phone,
          cart_qty,
          hire_clubs_qty,
          layout_key,
          front_nine_key,
          back_nine_key,
          reference,
          stripe_session_id: String(session.id || ""),
          stripe_payment_intent: String(session.payment_intent || ""),
        });
      }

      res.json({ received: true });
    } catch (e) {
      console.error("stripe webhook handler error", e);
      res.status(500).send("webhook_handler_failed");
    }
  }
);
// ✅ JSON for everything EXCEPT Stripe webhooks (webhooks need RAW body)
router.use((req, res, next) => {
  if (req.originalUrl.includes("/stripe/webhook") || req.originalUrl.includes("/stripe-webhook")) {
    return next();
  }
  return express.json()(req, res, next);
});

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
// ✅ helper: slug -> booking_courses.id
async function courseIdFromSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;

  const r = await db.query(
    `SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`,
    [s]
  );

  return r.rows?.[0]?.id || null;
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
// ✅ CODE-ONLY FIX: avoid manual-slot collisions across layouts without DB migrations
function _layoutSig({ holes, layout_key, front_nine_key, back_nine_key }) {
  const h = Number(holes || 0);
  const lk = String(layout_key || "").trim().toLowerCase();
  const fk = String(front_nine_key || "").trim().toLowerCase();
  const bk = String(back_nine_key || "").trim().toLowerCase();
  return `${h}|${lk}|${fk}|${bk}`;
}

// returns 0..19990 (step 10) so each layout gets 10-slot “bucket”
function _layoutOffset({ holes, layout_key, front_nine_key, back_nine_key }) {
  const sig = _layoutSig({ holes, layout_key, front_nine_key, back_nine_key });
  const hex = crypto.createHash("md5").update(sig).digest("hex").slice(0, 6);
  const n = parseInt(hex, 16) || 0;
  return (n % 2000) * 10;
}

// UI slot 1..4 -> DB slot like 12341..12344
function _toDbSlotIndex(slot_index_ui, layoutCtx) {
  const base = _layoutOffset(layoutCtx);
  const ui = Number(slot_index_ui || 0);
  return base + ui;
}

// DB slot like 12341..12344 -> UI slot 1..4
function _toUiSlotIndex(slot_index_db, layoutCtx) {
  const base = _layoutOffset(layoutCtx);
  return Number(slot_index_db || 0) - base;
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
// ✅ Backwards-compatible alias (some routes still reference requireBookingAdmin)
const requireBookingAdmin = requirePlatformAdmin;

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
  // =============================
  // booking_courses
  // =============================
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_courses (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      payment_mode TEXT NOT NULL DEFAULT 'PAY_AT_COURSE',
      layouts JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Ensure payment_mode exists (safe on older DBs)
  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'PAY_AT_COURSE';
  `);

  // ✅ FIX: repair legacy CHECK constraint + normalize old values (robust + idempotent)
  // 1) hard-normalize values so the CHECK constraint won't fail
  await db.query(`
    UPDATE booking_courses
    SET payment_mode = CASE
      WHEN payment_mode IS NULL THEN 'PAY_AT_COURSE'
      WHEN BTRIM(payment_mode) = '' THEN 'PAY_AT_COURSE'
      WHEN UPPER(BTRIM(payment_mode)) IN ('PAY_AT_TIME_OF_BOOKING', 'PAY_AT_BOOKING', 'PAYMENT_ON_BOOKING', 'PAY_ON_BOOKING') THEN 'PAY_ON_BOOKING'
      WHEN UPPER(BTRIM(payment_mode)) IN ('PAY_AT_COURSE') THEN 'PAY_AT_COURSE'
      ELSE 'PAY_AT_COURSE'
    END;
  `);

  // 2) drop old constraint if it exists on this table
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'booking_courses'::regclass
          AND contype = 'c'
          AND conname = 'booking_courses_payment_mode_check'
      ) THEN
        ALTER TABLE booking_courses
        DROP CONSTRAINT booking_courses_payment_mode_check;
      END IF;
    END
    $$;
  `);

  // 3) add correct constraint only if missing
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'booking_courses'::regclass
          AND contype = 'c'
          AND conname = 'booking_courses_payment_mode_check'
      ) THEN
        ALTER TABLE booking_courses
        ADD CONSTRAINT booking_courses_payment_mode_check
        CHECK (payment_mode IN ('PAY_AT_COURSE', 'PAY_ON_BOOKING'));
      END IF;
    END
    $$;
  `);

  // Ensure layouts exists (safe on older DBs)
  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS layouts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ✅ NEW: Stripe Connect + platform fee config per course
  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
  `);

  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER;
  `);

  await db.query(`
    ALTER TABLE booking_courses
    ADD COLUMN IF NOT EXISTS subscriber_discount_enabled BOOLEAN NOT NULL DEFAULT false;
  `);

  // =============================
  // booking_course_layouts
  // =============================
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_layouts (
      course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,
      layouts JSONB NOT NULL DEFAULT '[]'::jsonb,
      routes18 JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // =============================
  // booking_course_users
  // =============================
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_users (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      salt_hex TEXT NOT NULL,
      hash_hex TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'proshop',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(course_id, email)
    );
  `);

  // Ensure role exists (safe on older DBs)
  await db.query(`
    ALTER TABLE booking_course_users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'proshop';
  `);

  // =============================
  // booking_time_templates
  // =============================
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_time_templates (
      course_id INTEGER PRIMARY KEY REFERENCES booking_courses(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Australia/Perth',
      template JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // =============================
  // booking_times (base table)
  // =============================
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

  // ✅ NEW: optional layout keys for named 9s + 18 routings
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

  // ✅ IMPORTANT: these MUST be inside ensureBookingTables()
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

  // =============================
  // booking_bookings
  // =============================
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

  // ✅ ADD: normalize booking layout keys too
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

  // ✅ ADD: paid flag + cart tracking + subscriber discount tracking
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0;`);

  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS subscriber_discount_applied BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE booking_bookings ADD COLUMN IF NOT EXISTS subscriber_discount_cents INTEGER NOT NULL DEFAULT 0;`);

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

  // ✅✅✅ ADD (needed): Stripe IDs for webhook idempotency + audit
  await db.query(`
    ALTER TABLE booking_bookings
    ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
  `);

  await db.query(`
    ALTER TABLE booking_bookings
    ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
  `);

  // (optional but recommended) indexes
  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_bookings_stripe_session_idx
    ON booking_bookings (stripe_session_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_bookings_stripe_pi_idx
    ON booking_bookings (stripe_payment_intent);
  `);
  // ✅✅✅ END ADD ✅✅✅

  // =============================
  // booking_analytics_events
  // =============================
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

  // =============================
  // booking_course_settings
  // =============================
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

  // =============================
  // booking_manual_slots
  // =============================
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

  // ✅ Normalize manual slot layout keys
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

  // ✅ Drop the legacy unique constraint that ignores layout keys for manual slots
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

  // ✅ Drop any legacy UNIQUE constraints / indexes that still ignore layout keys
  await db.query(`
    DO $$
    DECLARE
      r record;
      c record;
    BEGIN
      FOR r IN
        SELECT
          i.oid AS index_oid,
          i.relname AS index_name
        FROM pg_index x
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE t.relname = 'booking_manual_slots'
          AND x.indisunique = true
          AND pg_get_indexdef(x.indexrelid) LIKE '%(course_id, play_date, tee_time, holes, slot_index)%'
          AND pg_get_indexdef(x.indexrelid) NOT LIKE '%layout_key%'
      LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = r.index_oid) THEN
          FOR c IN
            SELECT conname
            FROM pg_constraint
            WHERE conindid = r.index_oid
          LOOP
            EXECUTE format('ALTER TABLE booking_manual_slots DROP CONSTRAINT IF EXISTS %I', c.conname);
          END LOOP;
        ELSE
          EXECUTE format('DROP INDEX IF EXISTS %I', r.index_name);
        END IF;
      END LOOP;
    END
    $$;
  `);

  // ✅ Create layout-aware unique index for manual slots
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
// -----------------------------
// ✅ Course admin forgot/reset password
// -----------------------------

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

let _resetTableEnsured = false;
async function ensureCourseAdminResetTable() {
  if (_resetTableEnsured) return;
  // Create a simple reset-token table (no schema migration needed)
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_course_password_resets (
      id BIGSERIAL PRIMARY KEY,
      course_user_id BIGINT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_course_password_resets_token_hash
    ON booking_course_password_resets(token_hash);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_booking_course_password_resets_course_user_id
    ON booking_course_password_resets(course_user_id);
  `);

  _resetTableEnsured = true;
}

// POST /course-admin/forgot-password
// Body: { email }
// Response: { ok: true } (always, to avoid account enumeration)
router.post("/course-admin/forgot-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      return res.status(400).json({ ok: false, error: "invalid_email" });
    }

    await ensureCourseAdminResetTable();

    // Find latest matching course admin user
    const u = await db.query(
      `
      SELECT cu.id, cu.email, cu.course_id, c.slug
      FROM booking_course_users cu
      JOIN booking_courses c ON c.id = cu.course_id
      WHERE lower(cu.email) = $1
      ORDER BY cu.id DESC
      LIMIT 1;
      `,
      [email]
    );

    // Always return ok:true (even if not found)
    if (!u.rows.length) {
      return res.json({ ok: true });
    }

    const user = u.rows[0];

    // Create token + store hash
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 mins

    await db.query(
      `
      INSERT INTO booking_course_password_resets (course_user_id, token_hash, expires_at)
      VALUES ($1, $2, $3);
      `,
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    // Build reset URL (prefer explicit public base URL if you set one)
    const baseUrl =
      String(process.env.PUBLIC_BASE_URL || "").trim() ||
      `${isHttps(req) ? "https" : "http"}://${req.headers.host}`;

    // ✅ IMPORTANT: points to backend GET page that serves the reset form
    const resetUrl = `${baseUrl}/api/book/course-admin/reset?token=${encodeURIComponent(token)}`;

    // Send email (Resend must be configured)
    if (!resend?.emails?.send) {
      console.warn("⚠️ Resend not configured; cannot send reset email.");
      return res.json({ ok: true });
    }

    const fromEmail =
      String(process.env.BOOKING_EMAIL_FROM || "").trim() ||
      "TeeRadar <no-reply@teeradar.com.au>";

    await resend.emails.send({
      from: fromEmail,
      to: [user.email],
      subject: "Reset your TeeRadar Course Admin password",
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5">
          <h2 style="margin:0 0 8px">Reset your password</h2>
          <p style="margin:0 0 14px">
            We received a request to reset the Course Admin password for <b>${user.slug}</b>.
          </p>
          <p style="margin:0 0 14px">
            <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#00796b;color:#fff;text-decoration:none;font-weight:700">
              Reset password
            </a>
          </p>
          <p style="margin:0;color:#64748b;font-size:13px">
            This link expires in 60 minutes. If you didn’t request this, you can ignore this email.
          </p>
        </div>
      `,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("course-admin/forgot-password", e);
    // Still return ok:true so UI doesn't leak anything
    return res.json({ ok: true });
  }
});

/**
 * ✅ ADD THIS:
 * GET /course-admin/reset?token=...
 * Serves a simple reset-password page so the email link doesn't fall back to "/"
 */
router.get("/course-admin/reset", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) return res.status(400).send("Missing reset token.");

    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TeeRadar — Reset Course Admin Password</title>
  <link rel="icon" type="image/png" href="/assets/icon-192.png" />
  <style>
    body{
      margin:0;
      font-family:system-ui,-apple-system,Segoe UI,sans-serif;
      background:#f4f7fb;
      color:#0f172a;
      display:flex;
      align-items:center;
      justify-content:center;
      height:100vh;
    }
    .card{
      background:#fff;
      border:1px solid #e2e8f0;
      border-radius:14px;
      padding:28px;
      width:100%;
      max-width:420px;
    }
    h2{margin:0 0 8px;text-align:center}
    p{color:#64748b;font-size:14px;text-align:center;margin:0 0 14px}
    label{display:block;margin-top:14px;font-size:13px;color:#475569}
    input{
      width:100%;
      padding:12px;
      border:1px solid #cbd5e1;
      border-radius:10px;
      margin-top:6px;
      font-size:14px;
    }
    button{
      margin-top:18px;
      width:100%;
      padding:12px;
      border:0;
      border-radius:12px;
      background:#00796b;
      color:#fff;
      font-weight:700;
      cursor:pointer;
    }
    .msg{
      margin-top:12px;
      font-size:13px;
      text-align:center;
      color:#b91c1c;
      min-height:18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>Reset password</h2>
    <p>Enter a new password for your Course Admin account</p>

    <label>New password</label>
    <input id="pw1" type="password" placeholder="Minimum 8 characters" />

    <label>Confirm password</label>
    <input id="pw2" type="password" placeholder="Re-enter password" />

    <button id="saveBtn">Set new password</button>
    <div id="msg" class="msg"></div>
  </div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  const msg = document.getElementById("msg");

  document.getElementById("saveBtn").onclick = async () => {
    msg.textContent = "Saving…";
    const pw1 = document.getElementById("pw1").value || "";
    const pw2 = document.getElementById("pw2").value || "";

    if (pw1.length < 8) {
      msg.textContent = "Password must be at least 8 characters.";
      return;
    }
    if (pw1 !== pw2) {
      msg.textContent = "Passwords do not match.";
      return;
    }

    try {
      // IMPORTANT: relative URL because we are at /api/book/course-admin/reset
      const res = await fetch("./reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, password: pw1 })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        msg.textContent = data?.error || "Reset failed.";
        return;
      }

      msg.style.color = "#16a34a";
      msg.textContent = "Password updated. Redirecting to login…";
      setTimeout(() => {
        window.location.href = "/course-admin-login.html";
      }, 900);
    } catch (e) {
      msg.textContent = "Network error.";
    }
  };
</script>
</body>
</html>`);
  } catch (e) {
    console.error("course-admin/reset page", e);
    return res.status(500).send("Internal error.");
  }
});

// POST /course-admin/reset-password
// Body: { token, password }
router.post("/course-admin/reset-password", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || password.length < 8) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }

    await ensureCourseAdminResetTable();

    const tokenHash = sha256Hex(token);

    // Find a valid, unused reset token
    const r = await db.query(
      `
      SELECT pr.id AS reset_id, pr.course_user_id
      FROM booking_course_password_resets pr
      WHERE pr.token_hash = $1
        AND pr.used_at IS NULL
        AND pr.expires_at > NOW()
      ORDER BY pr.id DESC
      LIMIT 1;
      `,
      [tokenHash]
    );

    if (!r.rows.length) {
      return res.status(400).json({ ok: false, error: "invalid_or_expired_token" });
    }

    const resetRow = r.rows[0];

    // Update password on booking_course_users
    const { saltHex, hashHex } = hashPassword(password);

    await db.query(
      `
      UPDATE booking_course_users
      SET salt_hex = $1, hash_hex = $2
      WHERE id = $3;
      `,
      [saltHex, hashHex, resetRow.course_user_id]
    );

    // Mark token used
    await db.query(
      `
      UPDATE booking_course_password_resets
      SET used_at = NOW()
      WHERE id = $1;
      `,
      [resetRow.reset_id]
    );

    // Optional: clear admin cookies so they re-login cleanly
    res.clearCookie("tr_course_admin_slug", { path: "/" });
    res.clearCookie("tr_course_admin_email", { path: "/" });
    res.clearCookie("tr_course_admin_token", { path: "/" });
    res.clearCookie("tr_course_admin_role", { path: "/" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("course-admin/reset-password", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
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
        payment_mode,
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

    if (!r.rows.length) {
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }

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
      `
      SELECT
        id,
        slug,
        name,
        notes,
        payment_mode,
        created_at
      FROM booking_courses
      ORDER BY id DESC
      LIMIT 500;
      `
    );

    res.json({ ok: true, courses: rows || [] });
  } catch (e) {
    console.error("admin/courses GET", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
router.post("/admin/courses", requireBookingAdmin, async (req, res) => {
  try {
    // ✅ ensure tables/columns exist (prevents cold start race issues)
    await ensureBookingTables();

    const { slug, name, notes } = req.body || {};

    const slugClean = String(slug || "").trim().toLowerCase();
    const nameClean = String(name || "").trim();
    const notesClean = String(notes || "").trim();

    if (!slugClean || !nameClean) {
      return res.status(400).json({ ok: false, error: "slug_and_name_required" });
    }

    // ============================
    // Payment Mode Normalisation
    // ============================
    const pmRaw =
      req.body?.payment_mode ??
      req.body?.paymentMode ??
      req.body?.payment_option ??
      req.body?.paymentOption ??
      "";

    const pmNorm = String(pmRaw || "").trim().toUpperCase();

    const payment_mode =
      pmNorm === "PAY_ON_BOOKING" ||
      pmNorm === "PAY_AT_TIME_OF_BOOKING" ||
      pmNorm.includes("TIME") ||
      pmNorm.includes("BOOKING")
        ? "PAY_ON_BOOKING"
        : "PAY_AT_COURSE";

    // ============================
    // Stripe Connect + Fee Tier
    // ============================

    const stripe_account_id = String(
      req.body?.stripe_account_id ??
      req.body?.stripeAccountId ??
      ""
    ).trim() || null;

    const subscriber_discount_enabled = !!(
      req.body?.subscriber_discount_enabled ??
      req.body?.subscriberDiscountEnabled ??
      false
    );

    // ENV controlled fee tiers (safe defaults)
    const STANDARD_BPS = Number(process.env.STANDARD_PLATFORM_FEE_BPS || 300);   // 3%
    const DISCOUNT_BPS = Number(process.env.DISCOUNT_PLATFORM_FEE_BPS || 100);   // 1%

    // Auto choose tier
    let platform_fee_bps = subscriber_discount_enabled
      ? DISCOUNT_BPS
      : STANDARD_BPS;

    // Optional manual override (advanced usage)
    const manualBps = Number(
      req.body?.platform_fee_bps ??
      req.body?.platformFeeBps
    );

    if (Number.isFinite(manualBps)) {
      platform_fee_bps = Math.max(0, Math.min(10000, Math.trunc(manualBps)));
    }

    // ============================
    // Insert / Update Course
    // ============================

    await db.query(
      `
      INSERT INTO booking_courses (
        slug,
        name,
        notes,
        payment_mode,
        stripe_account_id,
        platform_fee_bps,
        subscriber_discount_enabled
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (slug) DO UPDATE
      SET name = EXCLUDED.name,
          notes = EXCLUDED.notes,
          payment_mode = EXCLUDED.payment_mode,
          stripe_account_id = EXCLUDED.stripe_account_id,
          platform_fee_bps = EXCLUDED.platform_fee_bps,
          subscriber_discount_enabled = EXCLUDED.subscriber_discount_enabled
      `,
      [
        slugClean,
        nameClean,
        notesClean || null,
        payment_mode,
        stripe_account_id,
        platform_fee_bps,
        subscriber_discount_enabled
      ]
    );

    return res.json({
      ok: true,
      slug: slugClean,
      payment_mode,
      stripe_account_id,
      platform_fee_bps,
      subscriber_discount_enabled
    });

  } catch (e) {
    console.error("admin/courses POST", e);

    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: String(e?.message || e),
    });
  }
});
// ✅ Stripe Connect onboarding (create Express account if missing, return onboarding URL)
router.post("/admin/stripe/onboard", requireBookingAdmin, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ ok: false, error: "stripe_not_configured" });
    }

    const slug = normSlug(req.body?.slug || req.query?.slug || "");
    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: "slug_invalid" });
    }

    const c = await db.query(
      `SELECT id, slug, stripe_account_id
       FROM booking_courses
       WHERE slug=$1
       LIMIT 1;`,
      [slug]
    );
    if (!c.rows.length) return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseId = Number(c.rows[0].id);
    let acct = String(c.rows[0].stripe_account_id || "").trim();

    // ✅ Create a Connect Express account if the course doesn't have one yet
    if (!acct) {
      const created = await stripe.accounts.create({
        type: "express",
        country: "AU",
        capabilities: {
          transfers: { requested: true },
        },
      });

      acct = created.id;

      await db.query(
        `UPDATE booking_courses SET stripe_account_id=$1 WHERE id=$2`,
        [acct, courseId]
      );
    }

    const publicBaseUrl =
      String(process.env.PUBLIC_BASE_URL || "").trim() ||
      (req.get("origin") || "");

    if (!publicBaseUrl) {
      return res.status(500).json({ ok: false, error: "missing_PUBLIC_BASE_URL" });
    }

    // ✅ Stripe-hosted onboarding flow URL
    const link = await stripe.accountLinks.create({
      account: acct,
      type: "account_onboarding",
      refresh_url: `${publicBaseUrl}/book-admin.html`,
      return_url: `${publicBaseUrl}/book-admin.html`,
    });

    return res.json({ ok: true, slug, stripe_account_id: acct, url: link.url });
  } catch (e) {
    console.error("admin/stripe/onboard", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
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

// 4) Daily series for charts (bookings + revenue) — ONLINE + MANUAL (manual deduped by reference)
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

    // ✅ We keep your existing pattern: build a single params array and re-use it
    const params = [];
    let whereOnline = `WHERE 1=1`;
    let whereManual = `WHERE 1=1`;

    // scope to course if provided
    if (courseId) {
      params.push(courseId);
      whereOnline += ` AND b.course_id = $${params.length}`;
      whereManual += ` AND m.course_id = $${params.length}`;
    }

    // ✅ IMPORTANT: use PLAY DATE for reporting (your code is using play_date)
    if (start && end) {
      params.push(start, end);
      whereOnline += ` AND b.play_date::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
      whereManual += ` AND m.play_date::date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    } else if (start && !end) {
      params.push(start);
      whereOnline += ` AND b.play_date::date >= $${params.length}::date`;
      whereManual += ` AND m.play_date::date >= $${params.length}::date`;
    } else if (!start && end) {
      params.push(end);
      whereOnline += ` AND b.play_date::date <= $${params.length}::date`;
      whereManual += ` AND m.play_date::date <= $${params.length}::date`;
    } else {
      // default last 30 days (by play date)
      whereOnline += ` AND b.play_date::date >= (CURRENT_DATE - INTERVAL '30 days')::date`;
      whereManual += ` AND m.play_date::date >= (CURRENT_DATE - INTERVAL '30 days')::date`;
    }

    const q = `
      WITH
      fees AS (
        SELECT
          id AS course_id,
          COALESCE(cart_fee_cents,0)::int AS cart_fee_cents,
          COALESCE(hire_clubs_fee_cents,0)::int AS clubs_fee_cents
        FROM booking_courses
        ${courseId ? `WHERE id = $1` : ``}
      ),

      online AS (
        SELECT
          b.play_date::date::text AS day,
          COUNT(*)::int AS bookings,
          COALESCE(SUM(
            COALESCE(b.total_cents,0)
            + COALESCE(b.cart_fee_cents,0)
            + COALESCE(b.hire_clubs_fee_cents,0)
          ), 0)::bigint AS revenue_cents
        FROM booking_bookings b
        ${whereOnline}
        GROUP BY b.play_date::date
      ),

      mb AS (
        -- ✅ group manual slots by reference so add-ons aren't double-counted
        -- ✅ also keep tee_time + holes so we can price via booking_times
        SELECT
          m.play_date::date AS day_date,
          m.course_id,
          m.reference,
          MIN(m.tee_time) AS tee_time,
          MIN(m.holes)::int AS holes,
          COUNT(*) FILTER (WHERE COALESCE(NULLIF(m.name,''),'') <> '')::int AS players,
          MAX(COALESCE(m.cart_qty,0))::int AS carts,
          MAX(COALESCE(m.hire_clubs_qty,0))::int AS clubs
        FROM booking_manual_slots m
        ${whereManual}
          AND m.reference IS NOT NULL AND m.reference <> ''
        GROUP BY m.play_date::date, m.course_id, m.reference
      ),

      manual AS (
        SELECT
          mb.day_date::text AS day,
          COUNT(*)::int AS bookings,
          COALESCE(SUM(
            (mb.players * COALESCE(t.price_per_player_cents,0))
            + (mb.carts * COALESCE(f.cart_fee_cents,0))
            + (mb.clubs * COALESCE(f.clubs_fee_cents,0))
          ), 0)::bigint AS revenue_cents
        FROM mb
        -- ✅ price manual bookings from booking_times (this is why revenue was not changing)
        LEFT JOIN booking_times t
          ON t.course_id = mb.course_id
         AND t.play_date::date = mb.day_date
         AND t.tee_time = mb.tee_time
         AND t.holes = mb.holes
        -- ✅ don't drop rows if fees row missing
        LEFT JOIN fees f
          ON f.course_id = mb.course_id
        GROUP BY mb.day_date
      ),

      combined AS (
        SELECT * FROM online
        UNION ALL
        SELECT * FROM manual
      )

      SELECT
        day,
        COALESCE(SUM(bookings),0)::int AS bookings,
        COALESCE(SUM(revenue_cents),0)::bigint AS revenue_cents
      FROM combined
      GROUP BY day
      ORDER BY day ASC;
    `;

    const r = await db.query(q, params);
    return res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    console.error("admin/analytics/daily", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
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
async function syncBookedPlayersForTime({
  courseId,
  play_date,
  tee_time,
  holes,
  layout_key = null,
  front_nine_key = null,
  back_nine_key = null,
}) {
  const cleanTime = String(tee_time || "").trim();
  const holesN = Number(holes || 0);

  const norm = (v) => {
    const s = String(v || "").trim();
    if (!s) return null;
    return s.toLowerCase();
  };

  layout_key = norm(layout_key);
  front_nine_key = norm(front_nine_key);
  back_nine_key = norm(back_nine_key);

  if (DEBUG_SYNC) {
    console.log("🟨 syncBookedPlayersForTime IN", {
      courseId,
      play_date,
      cleanTime,
      holesN,
      layout_key,
      front_nine_key,
      back_nine_key,
    });
  }

  // 🚫 HARD RULE: never sync without routing (prevents accidental generic 18 updates)
  if (holesN === 18 && (!front_nine_key || !back_nine_key) && !layout_key) {
    if (DEBUG_SYNC) console.log("🟥 sync abort: missing routing for 18", { cleanTime, holesN });
    return { ok: true, skipped: true, reason: "routing_required_for_18" };
  }

  if (holesN === 9 && !layout_key) {
    if (DEBUG_SYNC) console.log("🟥 sync abort: missing routing for 9", { cleanTime, holesN });
    return { ok: true, skipped: true, reason: "routing_required_for_9" };
  }

  // ✅ STRICT TARGET: match ONLY clean tee_time row that should exist for routed rows
  // (If your booking_times stores suffixes, we will see it in the diagnostics below)
  const targetQ = await db.query(
    `
    SELECT id, tee_time, holes, max_players, layout_key, front_nine_key, back_nine_key, booked_players, status
    FROM booking_times
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND layout_key IS NOT DISTINCT FROM $5
      AND front_nine_key IS NOT DISTINCT FROM $6
      AND back_nine_key IS NOT DISTINCT FROM $7
    LIMIT 1;
    `,
    [courseId, play_date, cleanTime, holesN, layout_key, front_nine_key, back_nine_key]
  );

  const target = targetQ.rows?.[0] || null;

  // ✅ DIAGNOSTICS when target not found
  if (!target) {
    if (DEBUG_SYNC) {
      console.log("🟥 sync NO EXACT TARGET FOUND", {
        courseId,
        play_date,
        cleanTime,
        holesN,
        layout_key,
        front_nine_key,
        back_nine_key,
      });

      // What booking_times rows exist for this time (including suffixed ones)?
      const bt = await db.query(
        `
        SELECT id, tee_time, holes, max_players, booked_players, status, layout_key, front_nine_key, back_nine_key
        FROM booking_times
        WHERE course_id = $1
          AND play_date = $2::date
          AND holes = $4
          AND split_part(tee_time,'|',1) = $3
        ORDER BY id ASC;
        `,
        [courseId, play_date, cleanTime, holesN]
      );

      console.log("🧩 booking_times rows at this time (split_part match):", bt.rows || []);

      // What manual slots exist for this time?
      const ms = await db.query(
        `
        SELECT id, tee_time, holes, slot_index, name, layout_key, front_nine_key, back_nine_key, reference
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date = $2::date
          AND holes = $4
          AND tee_time = $3
        ORDER BY slot_index ASC, id ASC;
        `,
        [courseId, play_date, cleanTime, holesN]
      );

      console.log("🧩 booking_manual_slots rows at this time:", ms.rows || []);
    }

    return { ok: true, skipped: true, reason: "no_exact_target" };
  }

  if (DEBUG_SYNC) {
    console.log("🟩 sync TARGET FOUND", {
      id: target.id,
      tee_time: target.tee_time,
      holes: target.holes,
      max_players: target.max_players,
      layout_key: target.layout_key,
      front_nine_key: target.front_nine_key,
      back_nine_key: target.back_nine_key,
      booked_players: target.booked_players,
      status: target.status,
    });
  }

  // ✅ Count ONLINE bookings (layout-scoped)
  const onlineBookedQ = await db.query(
    `
    SELECT COALESCE(SUM(players),0)::int AS c
    FROM booking_bookings
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND status = 'CONFIRMED'
      AND layout_key IS NOT DISTINCT FROM $5
      AND front_nine_key IS NOT DISTINCT FROM $6
      AND back_nine_key IS NOT DISTINCT FROM $7
    `,
    [courseId, play_date, cleanTime, holesN, layout_key, front_nine_key, back_nine_key]
  );
  const onlineBooked = Number(onlineBookedQ.rows?.[0]?.c || 0);

  // ✅ Count MANUAL bookings (layout-scoped)
  const manualBookedQ = await db.query(
    `
    SELECT COUNT(*)::int AS c
    FROM booking_manual_slots
    WHERE course_id = $1
      AND play_date = $2::date
      AND tee_time = $3
      AND holes = $4
      AND layout_key IS NOT DISTINCT FROM $5
      AND front_nine_key IS NOT DISTINCT FROM $6
      AND back_nine_key IS NOT DISTINCT FROM $7
      AND COALESCE(NULLIF(TRIM(name),''), NULLIF(TRIM(email),''), NULLIF(TRIM(phone),'')) IS NOT NULL
    `,
    [courseId, play_date, cleanTime, holesN, layout_key, front_nine_key, back_nine_key]
  );
  const manualBooked = Number(manualBookedQ.rows?.[0]?.c || 0);

  const totalBooked = onlineBooked + manualBooked;

  let maxPlayers = Number(target.max_players || 4);
  if (!maxPlayers || maxPlayers < 1) maxPlayers = 4;

  const status = totalBooked >= maxPlayers ? "BOOKED" : "AVAILABLE";

  if (DEBUG_SYNC) {
    console.log("🟦 sync COUNTS", {
      onlineBooked,
      manualBooked,
      totalBooked,
      maxPlayers,
      status,
    });
  }

  await db.query(
    `
    UPDATE booking_times
    SET booked_players = $2,
        status = $3,
        updated_at = now()
    WHERE id = $1;
    `,
    [target.id, totalBooked, status]
  );

  if (DEBUG_SYNC) {
    console.log("✅ sync UPDATED booking_times", {
      id: target.id,
      booked_players: totalBooked,
      status,
    });
  }

  return {
    ok: true,
    updated: true,
    id: target.id,
    booked_players: totalBooked,
    status,
    matched_tee_time: target.tee_time || null,
  };
}
// ✅ PUBLIC: fetch booking confirmation details (by reference)
// NOTE: bookingRoutes is mounted at /api/book, so this becomes:
// GET /api/book/confirmation?reference=TR-XXXXXX
router.get("/confirmation", async (req, res) => {
  try {
    const reference = String(req.query?.reference || "").trim().toUpperCase();
    if (!reference) {
      return res.status(400).json({ ok: false, error: "reference_required" });
    }

    const q = await db.query(
      `
      SELECT
        b.reference,
        c.slug,
        c.name AS course_name,

        b.play_date::text AS play_date,
        b.tee_time,
        b.holes,
        b.players,

        COALESCE(b.cart_qty,0)::int AS cart_qty,
        COALESCE(b.hire_clubs_qty,0)::int AS hire_clubs_qty,

        COALESCE(b.total_cents,0)::bigint AS total_cents,
        COALESCE(b.cart_fee_cents,0)::bigint AS cart_fee_cents,
        COALESCE(b.hire_clubs_fee_cents,0)::bigint AS hire_clubs_fee_cents,

        COALESCE(b.paid,false) AS paid,
        COALESCE(b.status,'CONFIRMED') AS status,

        COALESCE(b.golfer_name,'') AS golfer_name,
        COALESCE(b.golfer_email,'') AS golfer_email,
        COALESCE(b.golfer_phone,'') AS golfer_phone
      FROM booking_bookings b
      JOIN booking_courses c ON c.id = b.course_id
      WHERE UPPER(b.reference) = $1
      LIMIT 1;
      `,
      [reference]
    );

    const row = q.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const grossCents =
      Number(row.total_cents || 0) +
      Number(row.cart_fee_cents || 0) +
      Number(row.hire_clubs_fee_cents || 0);

    res.json({
      ok: true,
      booking: {
        reference: row.reference,
        slug: row.slug,
        courseName: row.course_name,

        date: row.play_date,
        teeTime: row.tee_time,
        holes: Number(row.holes || 0),
        players: Number(row.players || 0),

        cartsQty: Number(row.cart_qty || 0),
        hireClubsQty: Number(row.hire_clubs_qty || 0),

        paid: !!row.paid,
        paymentMode: row.paid ? "PAY_ON_BOOKING" : "PAY_AT_COURSE", // simple + correct for display
        status: String(row.status || "CONFIRMED").toUpperCase(),

        totalCents: Number(row.total_cents || 0),
        cartFeeCents: Number(row.cart_fee_cents || 0),
        hireClubsFeeCents: Number(row.hire_clubs_fee_cents || 0),
        grossCents,

        customer: {
          name: row.golfer_name || "",
          email: row.golfer_email || "",
          phone: row.golfer_phone || "",
        },
      },
    });
  } catch (e) {
    console.error("GET /api/book/confirmation error", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
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
// Body: { slug, date, time, holes, slotIndex, name, email, phone?, paid?, checked_in?, cartQty?, hireClubsQty?, notes?,
//         layout_key? (9s) OR front_nine_key+back_nine_key (18s) }
router.post("/admin/fill-slot", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.body?.slug);
    const play_date = String(req.body?.date || "").trim(); // MUST be YYYY-MM-DD
    const tee_time = String(req.body?.time || "").trim();
    const holes = Number(req.body?.holes || 18);

    // ✅ UI slot index (1..4)
    const slot_index_ui = Number(req.body?.slotIndex || 0);

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

    // ✅ routing keys (needed for multi-9 / routed 18 identity)
    const normKey = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return s ? s : null;
    };

    let layout_key = normKey(req.body?.layout_key ?? req.body?.layoutKey ?? null);
    let front_nine_key = normKey(req.body?.front_nine_key ?? req.body?.front9_key ?? req.body?.front9Key ?? null);
    let back_nine_key = normKey(req.body?.back_nine_key ?? req.body?.back9_key ?? req.body?.back9Key ?? null);

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index_ui) || slot_index_ui < 1 || slot_index_ui > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    // ✅ name required
    if (!String(name || "").trim()) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    // ✅ email optional — only validate if provided
    if (email && !isLikelyEmail(email)) {
      return res.status(400).json({ ok: false, error: "email_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ NEW: if routing keys not provided, infer them from the tee time row (so it shows on Daily Sheet)
    // (Fixes: manual booking created but doesn't appear because routing keys don't match the time row)
    try {
      const need9 = (holes === 9 && !layout_key);
      const need18 = (holes === 18 && (!front_nine_key || !back_nine_key));

      if (need9 || need18) {
        const t = await db.query(
          `
          SELECT layout_key, front_nine_key, back_nine_key
          FROM booking_times
          WHERE course_id=$1
            AND play_date=$2::date
            AND tee_time=$3
            AND holes=$4
          LIMIT 1;
          `,
          [courseId, play_date, tee_time, holes]
        );

        const row = t.rows?.[0];
        if (row) {
          if (holes === 9 && !layout_key) layout_key = row.layout_key || null;
          if (holes === 18) {
            if (!front_nine_key) front_nine_key = row.front_nine_key || null;
            if (!back_nine_key) back_nine_key = row.back_nine_key || null;
          }
        }
      }
    } catch {
      // non-fatal
    }

    // ✅ ENFORCE identity rules (match course-admin/manual-slot + /course-admin/booking)
    if (holes === 18) {
      layout_key = null;
      if (!front_nine_key || !back_nine_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }
    if (holes === 9) {
      front_nine_key = null;
      back_nine_key = null;
      if (!layout_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }

    // ----------------------------
    // ✅ CODE-ONLY COLLISION FIX:
    // slot_index must be unique per layout even without DB migration.
    // We store db_slot_index = base + ui_slot (1..4).
    // ----------------------------
    const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
    const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
    const n = parseInt(hex, 16) || 0;
    const base = (n % 2000) * 10; // each layout gets its own 10-slot bucket
    const slot_index = base + slot_index_ui;

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
    if (!reference) reference = makeRef("MS");

    // ✅ Upsert into booking_manual_slots (include routing keys + bucketed slot_index)
    const r = await db.query(
      `
      INSERT INTO booking_manual_slots
        (course_id, play_date, tee_time, holes, slot_index,
         layout_key, front_nine_key, back_nine_key,
         reference, name, email, phone,
         paid, checked_in, has_cart, has_hire_clubs, cart_qty, hire_clubs_qty, notes,
         start_at, end_at,
         updated_at)
      VALUES
        ($1,$2::date,$3,$4,$5,
         $6,$7,$8,
         $9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,
         $20::timestamptz, $21::timestamptz,
         now())
      ON CONFLICT (course_id, play_date, tee_time, holes, slot_index)
      DO UPDATE SET
        layout_key = EXCLUDED.layout_key,
        front_nine_key = EXCLUDED.front_nine_key,
        back_nine_key = EXCLUDED.back_nine_key,
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

        layout_key,
        front_nine_key,
        back_nine_key,

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

    // ✅ IMPORTANT: sync must be routing-scoped
    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      allowInsert: false,
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

        const pricePerPlayerCents = await getTeePricePerPlayerCents({
          courseId,
          playDate: play_date,
          teeTime: tee_time,
          holes,
          layout_key,
          front_nine_key,
          back_nine_key,
        });

        await sendBookingEmail({
          to: email,
          courseName,
          date: play_date,
          time: tee_time,
          holes,
          players: 1,
          reference,
          pricePerPlayerCents: pricePerPlayerCents || 0,
          totalCents: (pricePerPlayerCents || 0) * 1,
          cartCents,
          hireClubsCents,
          source: "manual",
        });
      }
    } catch (e) {
      console.warn("admin fill-slot email failed (non-fatal):", e?.message || e);
    }

    return res.json({
      ok: true,
      row: r.rows[0] || null,
      cart_qty,
      hire_clubs_qty,
      sync,
    });
  } catch (e) {
    console.error("admin/fill-slot POST", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// DELETE manual slot (platform admin)
// /api/book/admin/manual-slot?slug=xxx&date=YYYY-MM-DD&time=HH:MM&holes=18&slotIndex=1&front_nine_key=...&back_nine_key=...
// OR /api/book/admin/manual-slot?slug=xxx&date=YYYY-MM-DD&time=HH:MM&holes=9&slotIndex=1&layout_key=...
router.delete("/admin/manual-slot", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normSlug(req.query.slug);
    const play_date = String(req.query?.date || "").trim();
    const tee_time = String(req.query?.time || "").trim();
    const holes = Number(req.query?.holes || 18);

    const slot_index_ui = Number(req.query?.slotIndex || 0);

    const normKey = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return s ? s : null;
    };

    let layout_key = normKey(req.query?.layout_key ?? req.query?.layoutKey ?? null);
    let front_nine_key = normKey(req.query?.front_nine_key ?? req.query?.front9_key ?? req.query?.front9Key ?? null);
    let back_nine_key = normKey(req.query?.back_nine_key ?? req.query?.back9_key ?? req.query?.back9Key ?? null);

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index_ui) || slot_index_ui < 1 || slot_index_ui > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ NEW: if routing keys not provided, infer them from the tee time row
    // (So delete works even if UI didn't pass routing keys)
    try {
      const need9 = (holes === 9 && !layout_key);
      const need18 = (holes === 18 && (!front_nine_key || !back_nine_key));

      if (need9 || need18) {
        const t = await db.query(
          `
          SELECT layout_key, front_nine_key, back_nine_key
          FROM booking_times
          WHERE course_id=$1
            AND play_date=$2::date
            AND tee_time=$3
            AND holes=$4
          LIMIT 1;
          `,
          [courseId, play_date, tee_time, holes]
        );

        const row = t.rows?.[0];
        if (row) {
          if (holes === 9 && !layout_key) layout_key = row.layout_key || null;
          if (holes === 18) {
            if (!front_nine_key) front_nine_key = row.front_nine_key || null;
            if (!back_nine_key)  back_nine_key = row.back_nine_key || null;
          }
        }
      }
    } catch {
      // non-fatal
    }

    // ✅ ENFORCE identity rules
    if (holes === 18) {
      layout_key = null;
      if (!front_nine_key || !back_nine_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }
    if (holes === 9) {
      front_nine_key = null;
      back_nine_key = null;
      if (!layout_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }

    // ✅ bucketed slot index
    const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
    const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
    const n = parseInt(hex, 16) || 0;
    const base = (n % 2000) * 10;
    const slot_index = base + slot_index_ui;

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
      layout_key,
      front_nine_key,
      back_nine_key,
      allowInsert: false,
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

        -- ✅ return UI slot 1..4 (daily sheet expects this)
        (slot_index % 10) AS slot_index,

        -- keep db slot too (useful for debugging)
        slot_index AS slot_index_db,

        -- ✅ include routing identity so UI can match correct row
        layout_key,
        front_nine_key,
        back_nine_key,

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
      ORDER BY tee_time ASC, holes DESC, (slot_index % 10) ASC;
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
    const _normKey = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return s ? s : null;
    };

    // ✅ read raw
    let layout_key = _normKey(_pickAny(req.body, ["layout_key", "layoutKey"], ""));
    let front_nine_key = _normKey(_pickAny(req.body, ["front_nine_key", "front9_key", "front9Key"], ""));
    let back_nine_key  = _normKey(_pickAny(req.body, ["back_nine_key", "back9_key", "back9Key"], ""));

    // ✅ ENFORCE identity rules
    if (holes === 18) {
      // 18s are front+back ONLY
      layout_key = null;
      if (!front_nine_key || !back_nine_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }
    if (holes === 9) {
      // 9s are layout_key ONLY
      front_nine_key = null;
      back_nine_key = null;
      if (!layout_key) {
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }

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

    // ----------------------------
    // ✅ CODE-ONLY COLLISION FIX (same as Step 2):
    // slot_index must be unique per layout even without DB migration.
    // We store db_slot_index = base + ui_slot (1..4).
    // ----------------------------
    const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
    const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
    const n = parseInt(hex, 16) || 0;
    const base = (n % 2000) * 10; // each layout gets its own 10-slot bucket
    const toDbSlotIndex = (uiSlot) => base + Number(uiSlot || 0);

    // ✅ DEBUG: prove what this route is actually inserting
    console.log("🧾 course-admin/manual-slot incoming", {
      slug,
      courseId,
      playDate,
      tee_time,
      holes,
      players,
      keys: { layout_key, front_nine_key, back_nine_key },
      bucket: { base, range: [base + 1, base + 4] },
      cart_qty,
      hire_clubs_qty,
      name_present: !!name,
      email_present: !!email,
    });

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

    // ✅ IMPORTANT: find taken slots INSIDE this layout bucket (same approach as Step 2)
    const taken = await client.query(
      `
      SELECT slot_index
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        AND COALESCE(name,'') <> ''
        AND slot_index BETWEEN $5 AND $6
      `,
      [courseId, playDate, tee_time, holes, base + 1, base + 4]
    );

    const takenSetDb = new Set((taken.rows || []).map((r) => Number(r.slot_index)));
    const freeSlots = [1, 2, 3, 4].filter((i) => !takenSetDb.has(toDbSlotIndex(i)));

    console.log("🟩 course-admin/manual-slot slot scan", {
      courseId,
      playDate,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      takenDb: Array.from(takenSetDb),
      freeSlotsUi: freeSlots,
      playersRequested: players,
    });

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
      const slot_index_ui = freeSlots[i];
      const slot_index = toDbSlotIndex(slot_index_ui);

      // ✅ IMPORTANT: price lookup must match the same routed tee-time identity
      const price_per_player_cents = await getTeePricePerPlayerCents({
        courseId,
        playDate,
        teeTime: tee_time,
        holes,
        layout_key,
        front_nine_key,
        back_nine_key,
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

      console.log("🧾 inserted manual slot", {
        slot_index_ui,
        slot_index_db: slot_index,
        tee_time,
        holes,
        keys: { layout_key, front_nine_key, back_nine_key },
      });

      insertedRows.push(ins.rows[0]);
    }

    await client.query("COMMIT");
    didBegin = false;

    // ✅ ALSO sync booking_times booked_players/status for THIS exact routed slot
    // (and never insert new booking_times rows)
    let sync = null;
    try {
      console.log("🔄 course-admin/manual-slot calling syncBookedPlayersForTime", {
        courseId,
        play_date: playDate,
        tee_time,
        holes,
        layout_key,
        front_nine_key,
        back_nine_key,
        allowInsert: false,
      });

      sync = await syncBookedPlayersForTime({
        courseId,
        play_date: playDate,
        tee_time,
        holes,
        layout_key,
        front_nine_key,
        back_nine_key,
        allowInsert: false,
      });

      console.log("✅ course-admin/manual-slot sync result", sync);
    } catch (e) {
      console.error("⚠️ course-admin/manual-slot sync failed", e);
    }

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
      sync,
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
// Uses SAME logic as /course-admin/manual-slot but NEVER creates generic tee times
router.post("/course-admin/booking", requireCourseAdmin, async (req, res) => {
  let client = null;
  let didBegin = false;

  try {
    const slug = req.courseAdmin.slug;

    const playDate = String(
      req.body?.play_date || req.body?.playDate || req.body?.date || ""
    ).trim();

    const tee_time_raw = String(
      req.body?.tee_time || req.body?.teeTime || req.body?.time || ""
    ).trim();

    const holes = Number(req.body?.holes || 18);

    // ✅ NEW: accept time row id from UI (BEST FIX)
    const timeId = Number(req.body?.time_id ?? req.body?.timeId ?? 0) || null;

    // ✅ normalize helper (CRITICAL FIX)
    const normKey = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return s ? s : null;
    };

    // routing keys (may be missing from frontend — we’ll derive from timeId if present)
    let layout_key =
      normKey(req.body?.layout_key || req.body?.layoutKey || null);

    let front_nine_key =
      normKey(req.body?.front_nine_key || req.body?.front9_key || req.body?.front9Key || null);

    let back_nine_key =
      normKey(req.body?.back_nine_key || req.body?.back9_key || req.body?.back9Key || null);

    // players count
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
      ? addonIdsRaw.split(",").map(s => s.trim()).filter(Boolean)
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

    // ✅ DEBUG LOG (shows what UI sent BEFORE we derive)
    console.log("🧾 course-admin/booking incoming", {
      slug,
      playDate,
      tee_time_raw,
      holes,
      timeId,
      keys_from_body: { layout_key, front_nine_key, back_nine_key },
      players,
      name_present: !!name,
      email_present: !!email,
      cart_qty,
      hire_clubs_qty,
    });

    // validation
    if (!playDate) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(playDate)) return res.status(400).json({ ok: false, error: "date_invalid" });
    if (!/^\d{2}:\d{2}$/.test(tee_time_raw)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    if (email && !isLikelyEmail(email)) return res.status(400).json({ ok: false, error: "email_invalid" });

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    // ✅ NEW: if UI did NOT pass timeId, try to derive from booking_times by (date+time+holes)
    // This fixes cases where the UI sends tee_time but not routing keys (or sends inconsistent ones),
    // and avoids later "it becomes available" / mismatch behaviour.
    let tee_time = tee_time_raw;
    if (!timeId) {
      const tr2 = await db.query(
        `
        SELECT
          id,
          holes,
          split_part(tee_time,'|',1) AS tee_time_clean,
          layout_key,
          front_nine_key,
          back_nine_key
        FROM booking_times
        WHERE course_id = $1
          AND play_date = $2::date
          AND holes = $3::int
          AND split_part(tee_time,'|',1) = $4
        ORDER BY id DESC
        LIMIT 1;
        `,
        [courseId, playDate, holes, tee_time_raw]
      );

      const row2 = tr2.rows?.[0] || null;
      if (row2?.id) {
        tee_time = String(row2.tee_time_clean || tee_time_raw).trim();

        // Prefer DB truth if UI keys missing / partial
        layout_key = layout_key ?? normKey(row2.layout_key);
        front_nine_key = front_nine_key ?? normKey(row2.front_nine_key);
        back_nine_key = back_nine_key ?? normKey(row2.back_nine_key);

        console.log("🧩 course-admin/booking derived from booking_times (no timeId)", {
          derivedTimeId: row2.id,
          tee_time_clean: tee_time,
          keys_from_time_row: {
            layout_key: normKey(row2.layout_key),
            front_nine_key: normKey(row2.front_nine_key),
            back_nine_key: normKey(row2.back_nine_key),
          },
          keys_final: { layout_key, front_nine_key, back_nine_key },
        });
      }
    }

    // ✅ If UI passed timeId, derive routing keys from booking_times (this is the key fix)
    if (timeId) {
      const tr = await db.query(
        `
        SELECT
          id,
          holes,
          split_part(tee_time,'|',1) AS tee_time_clean,
          layout_key,
          front_nine_key,
          back_nine_key
        FROM booking_times
        WHERE id = $1 AND course_id = $2
        LIMIT 1;
        `,
        [timeId, courseId]
      );

      const row = tr.rows?.[0] || null;
      if (!row?.id) return res.status(400).json({ ok: false, error: "time_not_found" });
      if (Number(row.holes) !== Number(holes)) return res.status(400).json({ ok: false, error: "holes_mismatch" });

      tee_time = String(row.tee_time_clean || tee_time_raw).trim();

      // ✅ override keys from the actual time row (AND normalize)
      layout_key = normKey(row.layout_key);
      front_nine_key = normKey(row.front_nine_key);
      back_nine_key = normKey(row.back_nine_key);

      console.log("🧩 course-admin/booking derived from timeId", {
        timeId,
        tee_time_clean: tee_time,
        keys_from_time_row: { layout_key, front_nine_key, back_nine_key },
      });
    }

    // ✅ Extra safety: if 18-hole and layout_key is in "18:front|back" form, derive front/back
    if (holes === 18 && layout_key && (!front_nine_key || !back_nine_key)) {
      const m = String(layout_key).match(/^18:([^|]+)\|([^|]+)$/);
      if (m) {
        front_nine_key = front_nine_key || normKey(m[1]);
        back_nine_key = back_nine_key || normKey(m[2]);
        console.log("🧩 course-admin/booking parsed 18:front|back", {
          layout_key,
          front_nine_key,
          back_nine_key,
        });
      }
    }

    // ✅ CANONICALIZE identity (prevents "generic 18" vs "routed 18" mismatch)
    if (holes === 18) {
      // 18s must be front+back ONLY (layout_key must be NULL)
      layout_key = null;

      front_nine_key = normKey(front_nine_key);
      back_nine_key = normKey(back_nine_key);

      if (!front_nine_key || !back_nine_key) {
        console.log("⛔ course-admin/booking routing_required (18 after canonical)", {
          tee_time_raw,
          tee_time,
          holes,
          layout_key,
          front_nine_key,
          back_nine_key,
          timeId,
        });
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    } else if (holes === 9) {
      // 9s must be layout_key ONLY (front/back must be NULL)
      front_nine_key = null;
      back_nine_key = null;
      layout_key = normKey(layout_key);

      if (!layout_key) {
        console.log("⛔ course-admin/booking routing_required (9 after canonical)", {
          tee_time_raw,
          tee_time,
          holes,
          layout_key,
          timeId,
        });
        return res.status(400).json({ ok: false, error: "routing_required" });
      }
    }

    // ----------------------------
    // ✅ CODE-ONLY COLLISION FIX:
    // slot_index must be unique per layout even without DB migration.
    // We store db_slot_index = offset + ui_slot (1..4).
    // ----------------------------
    const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
    const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
    const n = parseInt(hex, 16) || 0;
    const base = (n % 2000) * 10; // each layout gets its own 10-slot bucket
    const toDbSlotIndex = (uiSlot) => base + Number(uiSlot || 0);

    console.log("🧠 course-admin/booking layout bucket", {
      layoutSig,
      base,
      range: [base + 1, base + 4],
      keys: { holes, layout_key, front_nine_key, back_nine_key },
    });

    client = await db.connect();
    await client.query("BEGIN");
    didBegin = true;

    // ⛔ lock includes layout identity (good)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [
      `manualslots:${courseId}:${playDate}:${tee_time}:${holes}:${layout_key || ""}:${front_nine_key || ""}:${back_nine_key || ""}`,
    ]);

    // 🔍 find taken slots INSIDE this layout’s 4-slot bucket
    const taken = await client.query(
      `
      SELECT slot_index
      FROM booking_manual_slots
      WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4
        AND COALESCE(name,'') <> ''
        AND slot_index BETWEEN $5 AND $6
      `,
      [courseId, playDate, tee_time, holes, base + 1, base + 4]
    );

    const takenSetDb = new Set((taken.rows || []).map(r => Number(r.slot_index)));
    const freeSlots = [1,2,3,4].filter(i => !takenSetDb.has(toDbSlotIndex(i)));

    console.log("🟩 course-admin/booking slot scan", {
      courseId,
      playDate,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      takenDb: Array.from(takenSetDb.values()),
      freeSlotsUi: freeSlots,
      playersRequested: players,
    });

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

    const startAtIso = toIsoDateTimeLocal(playDate, tee_time);
    const dur = durationMinsForHoles({}, holes);
    const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60000).toISOString();

    for (let i = 0; i < players; i++) {
      const slot_index_ui = freeSlots[i];
      const slot_index = toDbSlotIndex(slot_index_ui);
      const isFirst = i === 0;

      const r = await client.query(
        `
        INSERT INTO booking_manual_slots
          (course_id, play_date, tee_time, holes, slot_index,
           layout_key, front_nine_key, back_nine_key,
           reference, name, email, phone,
           paid, checked_in, has_cart, has_hire_clubs,
           cart_qty, hire_clubs_qty, notes,
           start_at, end_at, created_at, updated_at)
        VALUES
          ($1,$2::date,$3,$4,$5,
           $6,$7,$8,
           $9,$10,$11,$12,
           $13,$14,$15,$16,
           $17,$18,$19,
           $20::timestamptz,$21::timestamptz, now(), now())
        RETURNING *;
        `,
        [
          courseId, playDate, tee_time, holes, slot_index,
          layout_key, front_nine_key, back_nine_key,
          reference, name, email || null, phone || null,
          paid, checked_in,
          isFirst && cart_qty > 0,
          isFirst && hire_clubs_qty > 0,
          isFirst ? cart_qty : 0,
          isFirst ? hire_clubs_qty : 0,
          notes || null,
          startAtIso, endAtIso,
        ]
      );

      // helpful debug: show UI vs DB slot index used
      console.log("🧾 inserted manual slot", {
        slot_index_ui,
        slot_index_db: slot_index,
        tee_time,
        holes,
        keys: { layout_key, front_nine_key, back_nine_key },
      });

      filled.push(r.rows[0]);
    }

    await client.query("COMMIT");
    didBegin = false;

    // ✅ IMPORTANT: MUST be allowInsert:true so public booking page reflects taken slots
    console.log("🔄 course-admin/booking calling syncBookedPlayersForTime", {
      courseId,
      play_date: playDate,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      allowInsert: true,
    });

    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date: playDate,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      allowInsert: true,
    });

    console.log("✅ course-admin/booking sync result", sync);

    // ✅ NEW: send confirmation email when course admin creates a manual booking (if email provided)
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

        const pricePerPlayerCents = await getTeePricePerPlayerCents({
          courseId,
          playDate: playDate,
          teeTime: tee_time,
          holes,
          layout_key,
          front_nine_key,
          back_nine_key,
        });

        await sendBookingEmail({
          to: email,
          courseName,
          date: playDate,
          time: tee_time,
          holes,
          players,
          reference,
          pricePerPlayerCents: pricePerPlayerCents || 0,
          totalCents: (pricePerPlayerCents || 0) * players,
          cartCents,
          hireClubsCents,
          source: "manual",
        });
      }
    } catch (e) {
      console.warn("course-admin/booking email failed (non-fatal):", e?.message || e);
    }

    return res.json({ ok: true, reference, rows: filled, sync });

  } catch (e) {
    console.error("course-admin/booking POST", e);
    try { if (client && didBegin) await client.query("ROLLBACK"); } catch {}
    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    try { if (client) client.release(); } catch {}
  }
});

// DELETE manual slot
router.delete("/course-admin/manual-slot", requireCourseAdmin, async (req, res) => {
  try {
    const slug = req.courseAdmin.slug;

    const play_date = String(req.query?.date || "").trim();
    const tee_time = String(req.query?.time || "").trim();
    const holes = Number(req.query?.holes || 18);

    const slot_index_ui = Number(req.query?.slotIndex || 0);

    const normKey = (v) => {
      const s = String(v || "").trim().toLowerCase();
      return s ? s : null;
    };

    let layout_key = normKey(req.query?.layout_key ?? req.query?.layoutKey ?? null);
    let front_nine_key = normKey(req.query?.front_nine_key ?? req.query?.front9_key ?? req.query?.front9Key ?? null);
    let back_nine_key = normKey(req.query?.back_nine_key ?? req.query?.back9_key ?? req.query?.back9Key ?? null);

    if (!play_date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(slot_index_ui) || slot_index_ui < 1 || slot_index_ui > 4) {
      return res.status(400).json({ ok: false, error: "slotIndex_invalid" });
    }

    const courseId = await courseIdFromSlug(slug);
    if (!courseId) return res.status(404).json({ ok: false, error: "course_not_found" });

    /**
     * ✅ FIX:
     * Frontend delete URL may NOT send routing keys.
     * So if keys are missing, resolve the exact manual slot row by:
     *  - course_id + date + time + holes
     *  - and slot_index_ui via (slot_index % 10) = slotIndex
     * Then delete by id and sync using the row’s stored routing keys.
     */
    let resolved = null;

    if ((!layout_key && holes === 9) || ((holes === 18) && (!front_nine_key || !back_nine_key))) {
      const rr = await db.query(
        `
        SELECT id, tee_time, holes, layout_key, front_nine_key, back_nine_key
        FROM booking_manual_slots
        WHERE course_id = $1
          AND play_date = $2::date
          AND tee_time  = $3
          AND holes     = $4
          AND (slot_index % 10) = $5
        LIMIT 1;
        `,
        [courseId, play_date, tee_time, holes, slot_index_ui]
      );

      resolved = rr.rows[0] || null;

      if (!resolved) {
        return res.json({ ok: true, deleted: 0, sync: null });
      }

      layout_key = normKey(resolved.layout_key);
      front_nine_key = normKey(resolved.front_nine_key);
      back_nine_key = normKey(resolved.back_nine_key);
    }

    // ✅ If keys WERE provided, we still need to compute the hashed slot_index like before
    // (keeps backwards compatibility with any callers sending routing keys)
    if (!resolved) {
      // Enforce identity rules only when we must compute the hash
      if (holes === 18) {
        layout_key = null;
        if (!front_nine_key || !back_nine_key) {
          return res.status(400).json({ ok: false, error: "routing_required" });
        }
      }
      if (holes === 9) {
        front_nine_key = null;
        back_nine_key = null;
        if (!layout_key) {
          return res.status(400).json({ ok: false, error: "routing_required" });
        }
      }

      const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
      const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
      const n = parseInt(hex, 16) || 0;
      const base = (n % 2000) * 10;
      const slot_index = base + slot_index_ui;

      // Delete by composite (legacy path)
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
        layout_key,
        front_nine_key,
        back_nine_key,
        allowInsert: false,
      });

      return res.json({ ok: true, deleted: r.rowCount || 0, sync });
    }

    // ✅ Resolved path: delete by id (no routing keys needed from frontend)
    const del = await db.query(
      `DELETE FROM booking_manual_slots WHERE id=$1 AND course_id=$2`,
      [resolved.id, courseId]
    );

    const sync = await syncBookedPlayersForTime({
      courseId,
      play_date,
      tee_time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
      allowInsert: false,
    });

    return res.json({ ok: true, deleted: del.rowCount || 0, sync });
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
      const slot_index_ui = Number(req.body?.slotIndex || 0);

      const normKey = (v) => {
        const s = String(v || "").trim().toLowerCase();
        return s ? s : null;
      };

      let layout_key = normKey(req.body?.layout_key ?? req.body?.layoutKey ?? null);
      let front_nine_key = normKey(req.body?.front_nine_key ?? req.body?.front9_key ?? req.body?.front9Key ?? null);
      let back_nine_key = normKey(req.body?.back_nine_key ?? req.body?.back9_key ?? req.body?.back9Key ?? null);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
      if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
      if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
      if (!Number.isFinite(slot_index_ui) || slot_index_ui < 1 || slot_index_ui > 4)
        return res.status(400).json({ ok: false, error: "slotIndex_invalid" });

      // ✅ If routing keys are missing, try resolve uniquely by (slot_index % 10)
      const hasRouting =
        (holes === 9 && !!layout_key) ||
        (holes === 18 && !!front_nine_key && !!back_nine_key);

      if (!hasRouting) {
        const cand = await db.query(
          `
          SELECT id
          FROM booking_manual_slots
          WHERE course_id=$1
            AND play_date=$2::date
            AND tee_time=$3
            AND holes=$4
            AND (slot_index % 10)=$5
          LIMIT 3;
          `,
          [courseId, play_date, tee_time, holes, slot_index_ui]
        );

        if (cand.rows.length === 1) {
          r = await db.query(
            `UPDATE booking_manual_slots
             SET paid=$3, updated_at=now()
             WHERE id=$1 AND course_id=$2
             RETURNING id, paid;`,
            [cand.rows[0].id, courseId, paid]
          );
        } else if (cand.rows.length === 0) {
          r = { rows: [] };
        } else {
          return res.status(400).json({ ok: false, error: "routing_required" });
        }
      } else {
        // ✅ routing required for bucketed index (normal path)
        if (holes === 18) {
          layout_key = null;
        } else {
          front_nine_key = null;
          back_nine_key = null;
        }

        const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
        const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
        const n = parseInt(hex, 16) || 0;
        const base = (n % 2000) * 10;
        const slot_index = base + slot_index_ui;

        r = await db.query(
          `UPDATE booking_manual_slots
           SET paid=$6, updated_at=now()
           WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
           RETURNING id, paid;`,
          [courseId, play_date, tee_time, holes, slot_index, paid]
        );
      }
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
      const slot_index_ui = Number(req.body?.slotIndex || 0);

      const normKey = (v) => {
        const s = String(v || "").trim().toLowerCase();
        return s ? s : null;
      };

      let layout_key = normKey(req.body?.layout_key ?? req.body?.layoutKey ?? null);
      let front_nine_key = normKey(req.body?.front_nine_key ?? req.body?.front9_key ?? req.body?.front9Key ?? null);
      let back_nine_key = normKey(req.body?.back_nine_key ?? req.body?.back9_key ?? req.body?.back9Key ?? null);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(play_date)) return res.status(400).json({ ok: false, error: "date_invalid" });
      if (!/^\d{2}:\d{2}$/.test(tee_time)) return res.status(400).json({ ok: false, error: "time_invalid" });
      if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
      if (!Number.isFinite(slot_index_ui) || slot_index_ui < 1 || slot_index_ui > 4)
        return res.status(400).json({ ok: false, error: "slotIndex_invalid" });

      // ✅ If routing keys are missing, try resolve uniquely by (slot_index % 10)
      const hasRouting =
        (holes === 9 && !!layout_key) ||
        (holes === 18 && !!front_nine_key && !!back_nine_key);

      if (!hasRouting) {
        const cand = await db.query(
          `
          SELECT id
          FROM booking_manual_slots
          WHERE course_id=$1
            AND play_date=$2::date
            AND tee_time=$3
            AND holes=$4
            AND (slot_index % 10)=$5
          LIMIT 3;
          `,
          [courseId, play_date, tee_time, holes, slot_index_ui]
        );

        if (cand.rows.length === 1) {
          r = await db.query(
            `UPDATE booking_manual_slots
             SET checked_in=$3, updated_at=now()
             WHERE id=$1 AND course_id=$2
             RETURNING id, checked_in;`,
            [cand.rows[0].id, courseId, checked_in]
          );
        } else if (cand.rows.length === 0) {
          r = { rows: [] };
        } else {
          return res.status(400).json({ ok: false, error: "routing_required" });
        }
      } else {
        // ✅ routing required for bucketed index (normal path)
        if (holes === 18) {
          layout_key = null;
        } else {
          front_nine_key = null;
          back_nine_key = null;
        }

        const layoutSig = `${holes}|${layout_key || ""}|${front_nine_key || ""}|${back_nine_key || ""}`;
        const hex = crypto.createHash("md5").update(layoutSig).digest("hex").slice(0, 6);
        const n = parseInt(hex, 16) || 0;
        const base = (n % 2000) * 10;
        const slot_index = base + slot_index_ui;

        r = await db.query(
          `UPDATE booking_manual_slots
           SET checked_in=$6, updated_at=now()
           WHERE course_id=$1 AND play_date=$2::date AND tee_time=$3 AND holes=$4 AND slot_index=$5
           RETURNING id, checked_in;`,
          [courseId, play_date, tee_time, holes, slot_index, checked_in]
        );
      }
    }

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "manual_slot_not_found" });
    return res.status(200).json({ ok: true, id: r.rows[0].id, checked_in: r.rows[0].checked_in });
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

    // Map 18 routeKey -> label
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
        t.id,
        t.play_date,
        split_part(t.tee_time, '|', 1) AS tee_time_clean,
        t.tee_time,
        t.holes,
        t.max_players,
        t.booked_players,
        t.price_per_player_cents,
        t.status,
        t.layout_key,
        t.front_nine_key,
        t.back_nine_key,

        -- attach booking details (online)
        b.reference AS booking_reference,
        b.golfer_name AS booking_name,
        b.players AS booking_players,
        b.paid AS booking_paid,
        b.checked_in AS booking_checked_in,
        b.has_cart AS booking_has_cart,
        b.cart_qty AS booking_cart_qty,
        b.has_hire_clubs AS booking_has_hire_clubs,
        b.hire_clubs_qty AS booking_hire_clubs_qty

      FROM booking_times t

      LEFT JOIN LATERAL (
        SELECT
          bb.reference,
          bb.golfer_name,
          bb.players,
          bb.paid,
          bb.checked_in,
          bb.has_cart,
          bb.cart_qty,
          bb.has_hire_clubs,
          bb.hire_clubs_qty
        FROM booking_bookings bb
        WHERE bb.course_id = t.course_id
          AND bb.play_date = t.play_date
          AND bb.status IN ('CONFIRMED','PENDING_PAYMENT')
          AND bb.holes = t.holes
          AND split_part(bb.tee_time, '|', 1) = split_part(t.tee_time, '|', 1)
          AND bb.layout_key IS NOT DISTINCT FROM t.layout_key
          AND bb.front_nine_key IS NOT DISTINCT FROM t.front_nine_key
          AND bb.back_nine_key IS NOT DISTINCT FROM t.back_nine_key
        ORDER BY bb.created_at DESC
        LIMIT 1
      ) b ON true

      WHERE t.course_id = $1 AND t.play_date = $2::date
    `;

    if (holes) {
      params.push(holes);
      q += ` AND t.holes = $3`;
    }

    q += ` ORDER BY tee_time_clean ASC, t.holes DESC, t.id ASC`;

    const { rows } = await db.query(q, params);
    // ✅ HIDE legacy generic 18-hole rows when a routed 18-hole row exists at same clean time
// This prevents the UI showing BOTH:
//   "09:50 (18 holes)" AND "09:50 (18 holes — Classic + Lakes)"
const keyOf = (r) =>
  `${String(r.play_date || "")}|${String(r.tee_time_clean || "")}|${Number(r.holes || 0)}`;

const hasRouted18 = new Set();
for (const r of rows || []) {
  const holesN = Number(r.holes || 0);
  if (holesN !== 18) continue;

  const lk = String(r.layout_key || "").trim();
  const fk = String(r.front_nine_key || "").trim();
  const bk = String(r.back_nine_key || "").trim();

  const isGeneric = !lk && !fk && !bk;
  if (!isGeneric) hasRouted18.add(keyOf(r));
}

const filteredRows = (rows || []).filter((r) => {
  const holesN = Number(r.holes || 0);
  if (holesN !== 18) return true;

  const lk = String(r.layout_key || "").trim();
  const fk = String(r.front_nine_key || "").trim();
  const bk = String(r.back_nine_key || "").trim();
  const isGeneric = !lk && !fk && !bk;

  // if a routed 18-hole exists at this time, drop the generic one
  if (isGeneric && hasRouted18.has(keyOf(r))) return false;

  return true;
});

    // ✅ Normalize + attach display label so the frontend can show the correct layout always
    let times = (rows || []).map((r) => {
      const holesN = Number(r.holes || 0);

      let layoutKey = String(r.layout_key || "").trim().toLowerCase();
      let frontKey = String(r.front_nine_key || "").trim().toLowerCase();
      let backKey = String(r.back_nine_key || "").trim().toLowerCase();

      // legacy parse from layout_key like "18:classic|lakes"
      if (holesN === 18 && layoutKey && (!frontKey || !backKey)) {
        const m = layoutKey.match(/^18:([^|]+)\|([^|]+)$/);
        if (m) {
          frontKey = frontKey || String(m[1] || "").trim().toLowerCase();
          backKey = backKey || String(m[2] || "").trim().toLowerCase();
        }
      }

      // rebuild layout_key if missing but front/back exist
      if (holesN === 18 && !layoutKey && frontKey && backKey) {
        layoutKey = `18:${frontKey}|${backKey}`;
      }

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
        layoutLabel = label9ByKey.get(layoutKey) || layoutKey || "";
      }

      return {
        ...r,
        tee_time: String(r.tee_time_clean || r.tee_time || ""),
        layout_key: layoutKey || "",
        front_nine_key: frontKey || "",
        back_nine_key: backKey || "",
        layout_label: layoutLabel || null,
      };
    });

    // ✅✅ FIX: hide "generic 18 holes" rows when a routed row exists at the same time
    // This removes the duplicate "06:10 (18 holes)" if "06:10 (18 holes — Classic + Lakes)" exists.
    const groupHasRouted = new Map(); // key => true if any routed row exists
    for (const t of times) {
      const key = `${t.tee_time}|${t.holes}`;
      const hasRouting =
        (String(t.layout_key || "").trim() !== "") ||
        (String(t.front_nine_key || "").trim() !== "") ||
        (String(t.back_nine_key || "").trim() !== "");

      if (hasRouting) groupHasRouted.set(key, true);
    }

    times = times.filter((t) => {
      // only suppress for 18-hole rows
      if (Number(t.holes) !== 18) return true;

      const key = `${t.tee_time}|${t.holes}`;
      const routedExists = groupHasRouted.get(key) === true;

      // if routed exists, drop the generic row (no routing)
      if (routedExists) {
        const isGeneric =
          (String(t.layout_key || "").trim() === "") &&
          (String(t.front_nine_key || "").trim() === "") &&
          (String(t.back_nine_key || "").trim() === "");
        if (isGeneric) return false;
      }

      return true;
    });

    if (debug) {
      console.log("🧪 /course-admin/times layout+booking debug", {
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
          booking_name: t.booking_name,
          booking_cart_qty: t.booking_cart_qty,
          booking_hire_clubs_qty: t.booking_hire_clubs_qty,
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
        b.layout_key,
        b.front_nine_key,
        b.back_nine_key,
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
      manualSlots: ms.rows || [],
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
      SELECT
        id,
        course_id,
        play_date::text AS play_date,
        tee_time,
        holes,
        layout_key,
        front_nine_key,
        back_nine_key,
        status
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
        // ✅ pass layout keys for multi-routing courses
        layout_key: row.layout_key || null,
        front_nine_key: row.front_nine_key || null,
        back_nine_key: row.back_nine_key || null,
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
      // ✅ pass layout keys for multi-routing courses
      layout_key: row.layout_key || null,
      front_nine_key: row.front_nine_key || null,
      back_nine_key: row.back_nine_key || null,
    });

    return res.json({ ok: true, reference, status: "CANCELLED", sync });
  } catch (e) {
    console.error("course-admin/booking-cancel", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ ADD: toggle checked-in flag (course admin)
// ✅ Course admin: mark a booking checked-in (supports TR- + MAN- refs)
// ✅ Course admin: mark a booking checked-in (supports TR- + MAN- refs)
router.post("/course-admin/booking-checkin", requireCourseAdmin, async (req, res) => {
  try {
    const reference = String(req.body?.reference || "").trim();
    const slotRaw = req.body?.slot ?? req.body?.slotIndex ?? req.body?.slot_index ?? 0;
    const slot_ui = Number(slotRaw || 0); // 1–4 (UI)
    const checkedIn = !!(req.body?.checked_in ?? req.body?.checkedIn ?? false);

    if (!reference) {
      return res.status(400).json({ ok: false, error: "reference_required" });
    }

    // ✅ Resolve courseId
    let courseId =
      Number(req.courseAdmin?.courseId || req.courseAdmin?.course_id || 0) || 0;

    if (!courseId) {
      const slug = String(req.courseAdmin?.slug || "").trim().toLowerCase();
      if (!slug) {
        return res.status(400).json({ ok: false, error: "course_context_missing" });
      }

      const q = await db.query(
        `SELECT id FROM booking_courses WHERE slug=$1 LIMIT 1;`,
        [slug]
      );
      courseId = Number(q.rows?.[0]?.id || 0);
    }

    if (!courseId) {
      return res.status(404).json({ ok: false, error: "course_not_found" });
    }

    // =========================
    // ✅ MANUAL BOOKINGS
    // =========================
    if (/^MAN-/.test(reference)) {
      if (!slot_ui || slot_ui < 1 || slot_ui > 4) {
        return res.status(400).json({ ok: false, error: "slot_required_for_manual" });
      }

      // ✅ FIX: don't re-derive slot_index (hashing/layout may not match)
      // Manual slot_index is bucketed so the last digit maps to UI slot 1–4
      const r = await db.query(
        `
        UPDATE booking_manual_slots
        SET checked_in=$1, updated_at=now()
        WHERE course_id=$2
          AND reference=$3
          AND (slot_index % 10) = $4
        `,
        [checkedIn, courseId, reference, slot_ui]
      );

      if (!r.rowCount) {
        return res.status(404).json({ ok: false, error: "manual_slot_not_found" });
      }

      return res.json({
        ok: true,
        kind: "manual",
        reference,
        slot: slot_ui,
        checked_in: checkedIn,
      });
    }

    // =========================
    // ✅ NORMAL BOOKINGS (TR-)
    // =========================
    // ✅ FIX: booking_bookings does NOT have checked_in/updated_at columns.
    // Store "checked in" state via status instead.
    const newStatus = checkedIn ? "CHECKED_IN" : "CONFIRMED";

    const r2 = await db.query(
      `
      UPDATE booking_bookings
      SET status=$1
      WHERE course_id=$2 AND reference=$3
      `,
      [newStatus, courseId, reference]
    );

    if (!r2.rowCount) {
      return res.status(404).json({ ok: false, error: "booking_not_found" });
    }

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
      `SELECT 
         id, 
         slug, 
         name, 
         notes, 
         payment_mode,
         stripe_account_id,
         cart_fee_cents, 
         hire_clubs_fee_cents
       FROM booking_courses
       WHERE slug=$1
       LIMIT 1;`,
      [slug]
    );

    if (!rows.length)
      return res.status(404).json({ ok: false, error: "course_not_found" });

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

    // ✅ FIX: map page may send different param names (playerCount/numPlayers/etc)
    const playersQuery =
      (req.query.partySize ??
       req.query.players ??
       req.query.playerCount ??
       req.query.playersCount ??
       req.query.numPlayers ??
       req.query.num_players);

    const playersRaw = Array.isArray(playersQuery) ? playersQuery[0] : playersQuery;

    // ✅ FIX: handle values like "3 players" safely
    const mPlayers = String(playersRaw ?? "2").match(/\d+/);
    const playersParsed = mPlayers ? parseInt(mPlayers[0], 10) : 2;

    const players = Math.min(4, Math.max(1, Number.isFinite(playersParsed) ? playersParsed : 2));

    const layoutKeyRaw = String(req.query.layoutKey || req.query.layout || "").trim().toLowerCase();
    const layoutKey = layoutKeyRaw ? layoutKeyRaw : null;

    const earliest = String(req.query.earliest || "06:00").trim();
    const latest = String(req.query.latest || "17:00").trim();

    // ✅ debug=1 bounces you home, so add trace=1 for safe server logging
    const debug = String(req.query.debug || "") === "1";
    const trace = String(req.query.trace || "") === "1";
    const logOn = debug || trace;

    if (logOn) {
      console.log("🧪 GET /availability incoming", {
        slug: req.query.slug,
        date: req.query.date,
        holes: req.query.holes,
        players: req.query.players,
        partySize: req.query.partySize,
        playerCount: req.query.playerCount,
        playersCount: req.query.playersCount,
        numPlayers: req.query.numPlayers,
        num_players: req.query.num_players,
        playersRaw,
        playersResolved: players,
        earliest: req.query.earliest,
        latest: req.query.latest,
        layoutKey,
        trace,
        debug,
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

    // ✅ dlog should log for trace too
    const dlog = (...args) => { if (logOn) console.log(...args); };

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

        -- ✅ Manual slots
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS manual_count
          FROM booking_manual_slots ms2
          WHERE ms2.course_id = t.course_id
            AND ms2.play_date = t.play_date
            -- ✅ FIX TIME MATCH (handles 06:00 vs 06:00:00)
            AND ms2.tee_time::time = split_part(t.tee_time, '|', 1)::time
            AND ms2.holes     = t.holes
            AND COALESCE(ms2.name,'') <> ''
            AND (
              (
                t.holes = 18 AND (
                  (
                    t.front_nine_key IS NOT NULL
                    AND t.back_nine_key IS NOT NULL
                    AND ms2.front_nine_key IS NOT DISTINCT FROM t.front_nine_key
                    AND ms2.back_nine_key  IS NOT DISTINCT FROM t.back_nine_key
                  )
                  OR
                  (
                    (t.front_nine_key IS NULL OR t.back_nine_key IS NULL)
                    AND t.layout_key IS NOT NULL
                    AND ms2.layout_key IS NOT DISTINCT FROM t.layout_key
                  )
                )
              )
              OR
              (
                t.holes = 9
                AND ms2.layout_key IS NOT DISTINCT FROM t.layout_key
              )
            )
        ) ms ON true

        -- ✅ Confirmed bookings
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(b.players),0)::int AS booked
          FROM booking_bookings b
          WHERE b.course_id = t.course_id
            AND b.play_date = t.play_date
            -- ✅ FIX TIME MATCH (handles 06:00 vs 06:00:00)
            AND b.tee_time::time = split_part(t.tee_time, '|', 1)::time
            AND b.holes     = t.holes
            AND (
              b.status = 'CONFIRMED'
              OR (b.status = 'PENDING_PAYMENT' AND b.created_at > now() - interval '15 minutes')
            )
            AND (
              (
                t.holes = 18 AND (
                  (
                    t.front_nine_key IS NOT NULL
                    AND t.back_nine_key IS NOT NULL
                    AND b.front_nine_key IS NOT DISTINCT FROM t.front_nine_key
                    AND b.back_nine_key  IS NOT DISTINCT FROM t.back_nine_key
                  )
                  OR
                  (
                    (t.front_nine_key IS NULL OR t.back_nine_key IS NULL)
                    AND t.layout_key IS NOT NULL
                    AND b.layout_key IS NOT DISTINCT FROM t.layout_key
                  )
                )
              )
              OR
              (
                t.holes = 9
                AND b.layout_key IS NOT DISTINCT FROM t.layout_key
              )
            )
        ) bk ON true

        WHERE t.course_id = $1
          AND t.play_date = $2::date
          AND t.holes     = $3
          AND t.status    = 'AVAILABLE'
          AND ($4::text IS NULL OR t.layout_key = $4)
          AND (
            (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 + split_part(split_part(t.tee_time, '|', 1), ':', 2)::int) >= $6
            AND
            (split_part(split_part(t.tee_time, '|', 1), ':', 1)::int * 60 + split_part(split_part(t.tee_time, '|', 1), ':', 2)::int) <  $7
          )
          AND (
            $3 <> 9
            OR $4::text IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM booking_bookings bb18
              WHERE bb18.course_id = t.course_id
                AND bb18.play_date = t.play_date
                AND bb18.holes     = 18
                AND (
                  bb18.status = 'CONFIRMED'
                  OR (bb18.status = 'PENDING_PAYMENT' AND bb18.created_at > now() - interval '15 minutes')
                )
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
      WHERE (max_players - (booked + manual_booked)) >= $5
      ORDER BY tee_time_clean ASC;
      `,
      [courseId, date, holes, layoutKey, players, sM, eM, dur9, dur18]
    );

    dlog("🧪 availability rows.length", Array.isArray(rows) ? rows.length : null);

    const times = await Promise.all(
      (rows || []).map(async (r) => {
        const startAtIso = toIsoDateTimeLocal(date, r.tee_time);
        const dur = durationMinsForHoles(courseRow, r.holes);
        const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();

        let cartsUsed = 0;
        let clubsUsed = 0;
        try {
          const usage = await countOverlappingAddonUsage(db, { courseId, startAtIso, endAtIso });
          cartsUsed = Number(usage?.cartsUsed || 0);
          clubsUsed = Number(usage?.clubsUsed || 0);
        } catch (err) {
          if (logOn) console.log("🧪 countOverlappingAddonUsage failed (non-fatal)", err?.message || err);
        }

        const cartRemaining = Math.max(0, courseCartQty - cartsUsed);
        const clubsRemaining = Math.max(0, courseHireClubsQty - clubsUsed);

        const bookedEffective = Number(r.booked_effective ?? 0);
        const remainingEffective = Math.max(0, Number(r.remaining_effective ?? 0));
        const maxPlayers = Number(r.max_players ?? 0);

        const availablePlayers = remainingEffective;

        return {
          time: r.tee_time,
          holes: Number(r.holes),

          layout_key: r.layout_key ?? null,
          front_nine_key: r.front_nine_key ?? null,
          back_nine_key: r.back_nine_key ?? null,

          layoutKey: r.layout_key ?? null,
          frontNineKey: r.front_nine_key ?? null,
          backNineKey: r.back_nine_key ?? null,

          maxPlayers,

          bookedPlayers: bookedEffective,
          booked_players: bookedEffective,
          bookedEffective,
          booked_effective: bookedEffective,

          remaining: availablePlayers,
          remainingPlayers: availablePlayers,
          playersRemaining: availablePlayers,
          remainingEffective: availablePlayers,
          remaining_effective: availablePlayers,

          availablePlayers,
          available_players: availablePlayers,
          available: availablePlayers,
          spotsAvailable: availablePlayers,
          slotsAvailable: availablePlayers,

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

    if (logOn) {
      console.log("🧪 /availability returned", {
        slug,
        date,
        holes,
        players,
        earliest,
        latest,
        layoutKey,
        count: times.length,
        sample: times[0] || null,
      });
    }

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
    const trace = String(req.query.trace || "") === "1";

    console.error("GET /availability error", e);
    console.error(e?.stack || e);

    if (debug) {
      return res.status(500).json({
        ok: false,
        error: "internal_error",
        message: String(e?.message || e || "unknown_error"),
        stack: String(e?.stack || ""),
      });
    }

    if (trace) {
      return res.status(500).json({
        ok: false,
        error: "internal_error",
        message: String(e?.message || e || "unknown_error"),
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

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [key]);
  return key;
}

// ✅ NEW: convert layout label like "Pines + Lakes" -> "pines" / "lakes"
function nineKeyFromLabel(label) {
  const s = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, ""); // keep letters/numbers/spaces only

  // turn "classic pines" into "classic_pines" etc
  return s.replace(/ /g, "_");
}

// ✅ NEW: try to extract routing keys from UI layout text
function deriveRoutingKeysFromLayoutText({ holes, layoutTextRaw }) {
  const layoutText = String(layoutTextRaw || "").trim();
  if (!layoutText) return { layout_key: null, front_nine_key: null, back_nine_key: null };

  // common formats we’ll accept: "Pines + Lakes", "Pines & Lakes", "Pines and Lakes"
  const cleaned = layoutText
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();

  if (Number(holes) === 18) {
    let parts = [];
    if (cleaned.includes("+")) parts = cleaned.split("+");
    else if (cleaned.toLowerCase().includes(" and ")) parts = cleaned.split(/ and /i);
    else parts = cleaned.split("-"); // last-resort

    parts = parts.map((p) => p.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const front = nineKeyFromLabel(parts[0]);
      const back = nineKeyFromLabel(parts[1]);
      return { layout_key: null, front_nine_key: front || null, back_nine_key: back || null };
    }
    return { layout_key: null, front_nine_key: null, back_nine_key: null };
  }

  // holes === 9
  return { layout_key: nineKeyFromLabel(cleaned) || null, front_nine_key: null, back_nine_key: null };
}

async function finalizePaidBooking(payload) {
  // ✅ Webhook-safe finaliser:
  // - DO NOT create a new booking/lock times again (that already happened in /book)
  // - Just mark the EXISTING booking as paid/confirmed
  // - Store Stripe IDs
  // - Send the confirmation email
  // - Must be idempotent (Stripe webhooks retry)

  const {
    reference,
    stripe_session_id,
    stripe_payment_intent,
  } = payload || {};

  const ref = String(reference || "").trim();
  if (!ref) {
    console.warn("⚠️ finalizePaidBooking: missing reference");
    return { ok: false, error: "missing_reference" };
  }

  // ✅ 1) ATOMIC idempotent update (only updates if not already confirmed)
  //    RETURNING gives us everything needed to email without a separate SELECT.
  let booking = null;

  try {
    const upd = await db.query(
      `
      UPDATE booking_bookings b
      SET
        paid = true,
        status = 'CONFIRMED',
        updated_at = now(),
        stripe_session_id = COALESCE($2, b.stripe_session_id),
        stripe_payment_intent = COALESCE($3, b.stripe_payment_intent)
      WHERE b.reference = $1
        AND COALESCE(UPPER(b.status),'') <> 'CONFIRMED'
      RETURNING
        b.id,
        b.course_id,
        b.play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_name,
        b.golfer_email,
        b.golfer_phone,
        b.price_per_player_cents,
        b.total_cents,
        b.cart_fee_cents,
        b.hire_clubs_fee_cents,
        b.reference;
      `,
      [
        ref,
        stripe_session_id ? String(stripe_session_id) : null,
        stripe_payment_intent ? String(stripe_payment_intent) : null,
      ]
    );

    if (!upd.rows.length) {
      // Already confirmed OR not found. Distinguish with a quick check.
      const exists = await db.query(
        `SELECT id, paid, status FROM booking_bookings WHERE reference=$1 LIMIT 1;`,
        [ref]
      );

      if (!exists.rows.length) {
        console.warn("⚠️ finalizePaidBooking: booking not found for reference:", ref);
        return { ok: false, error: "booking_not_found" };
      }

      console.log("🔁 finalizePaidBooking: already paid/confirmed:", ref);
      return { ok: true, alreadyConfirmed: true };
    }

    booking = upd.rows[0];
  } catch (e) {
    // ✅ If your table doesn't have stripe_session_id / stripe_payment_intent yet,
    // fall back to a minimal atomic update (still idempotent).
    const msg = e?.message || String(e || "");
    console.warn("finalizePaidBooking: stripe columns update failed, falling back:", msg);

    const upd2 = await db.query(
      `
      UPDATE booking_bookings b
      SET
        paid = true,
        status = 'CONFIRMED',
        updated_at = now()
      WHERE b.reference = $1
        AND COALESCE(UPPER(b.status),'') <> 'CONFIRMED'
      RETURNING
        b.id,
        b.course_id,
        b.play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_name,
        b.golfer_email,
        b.golfer_phone,
        b.price_per_player_cents,
        b.total_cents,
        b.cart_fee_cents,
        b.hire_clubs_fee_cents,
        b.reference;
      `,
      [ref]
    );

    if (!upd2.rows.length) {
      const exists = await db.query(
        `SELECT id, paid, status FROM booking_bookings WHERE reference=$1 LIMIT 1;`,
        [ref]
      );

      if (!exists.rows.length) {
        console.warn("⚠️ finalizePaidBooking: booking not found for reference:", ref);
        return { ok: false, error: "booking_not_found" };
      }

      console.log("🔁 finalizePaidBooking: already paid/confirmed:", ref);
      return { ok: true, alreadyConfirmed: true };
    }

    booking = upd2.rows[0];
  }

  console.log("✅ Booking marked paid/confirmed:", { id: booking.id, reference: booking.reference });

  // ✅ 2) Fetch course name for email (small query; keeps changes minimal)
  let courseName = "Golf Course";
  try {
    const c = await db.query(
      `SELECT name FROM booking_courses WHERE id = $1 LIMIT 1;`,
      [booking.course_id]
    );
    courseName = c.rows[0]?.name || courseName;
  } catch {}

   // ✅ 3) Send confirmation email ONCE (only when we successfully updated)
  let emailOk = false;
  let emailReason = null;

  try {
    const emailResult = await sendBookingEmail({
      to: booking.golfer_email,
      courseName,
      date: String(booking.play_date).slice(0, 10),
      time: String(booking.tee_time || "").split("|")[0],
      holes: Number(booking.holes || 0),
      players: Number(booking.players || 0),
      reference: booking.reference,
      pricePerPlayerCents: Number(booking.price_per_player_cents || 0),
      totalCents: Number(booking.total_cents || 0),
      cartCents: Number(booking.cart_fee_cents || 0),
      hireClubsCents: Number(booking.hire_clubs_fee_cents || 0),
    });

    emailOk = !!emailResult?.emailOk;
    emailReason = emailResult?.emailReason || null;

    console.log("📧 finalizePaidBooking email:", {
      reference: booking.reference,
      emailOk,
      emailReason,
    });
  } catch (e) {
    emailOk = false;
    emailReason = e?.message || "send_failed";
    console.error("❌ finalizePaidBooking email failed:", e?.message || e);
  }

  return { ok: true, bookingId: booking.id, reference: booking.reference, emailOk, emailReason };
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

    // ✅ routing keys from UI (if provided)
    // ✅ IMPORTANT: DO NOT lowercase here — DB may store mixed case; we match case-insensitively in SQL.
    let layout_key = req.body?.layout_key ? String(req.body.layout_key).trim() : null;
    let front_nine_key = req.body?.front_nine_key ? String(req.body.front_nine_key).trim() : null;
    let back_nine_key = req.body?.back_nine_key ? String(req.body.back_nine_key).trim() : null;

    // ✅ ALSO accept layout label text (what the UI shows: "Pines + Lakes", "Classic + Lakes", etc.)
    const layoutTextRaw =
      req.body?.layout ||
      req.body?.layoutText ||
      req.body?.layout_name ||
      req.body?.layoutLabel ||
      "";

    // ✅ If keys missing, derive from layout label text
    if (holes === 18 && (!front_nine_key || !back_nine_key)) {
      const derived = deriveRoutingKeysFromLayoutText({ holes, layoutTextRaw });
      front_nine_key = front_nine_key || derived.front_nine_key;
      back_nine_key = back_nine_key || derived.back_nine_key;
    }
    if (holes === 9 && !layout_key) {
      const derived = deriveRoutingKeysFromLayoutText({ holes, layoutTextRaw });
      layout_key = layout_key || derived.layout_key;
    }

    // ✅ cart / hire clubs selection (optional)
    const addonIds = Array.isArray(req.body?.addonIds)
      ? req.body.addonIds.map((x) => String(x))
      : [];

    const picked = new Set(
      addonIds.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
    );

    const has_cart =
      picked.size > 0 ? picked.has("cart") : parseBool(req.body?.has_cart, false);

    const has_hire_clubs =
      picked.size > 0 ? picked.has("hire_clubs") : parseBool(req.body?.has_hire_clubs, false);

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

    const final_has_cart = cart_qty > 0;
    const final_has_hire_clubs = hire_clubs_qty > 0;

    if (!slug || !isValidSlug(slug)) return res.status(400).json({ ok: false, error: "slug_invalid" });
    if (!date) return res.status(400).json({ ok: false, error: "date_required" });
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ ok: false, error: "time_invalid" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "holes_invalid" });
    if (!Number.isFinite(players) || players < 1 || players > 4)
      return res.status(400).json({ ok: false, error: "players_invalid" });

    // ✅ Now enforce routing keys exist (either from UI OR derived)
    if (holes === 18 && (!front_nine_key || !back_nine_key)) {
      return res.status(400).json({ ok: false, error: "routing_required" });
    }
    if (holes === 9 && !layout_key) {
      return res.status(400).json({ ok: false, error: "layout_required" });
    }

    if (!hasFirstAndLastName(golfer_name)) {
      return res.status(400).json({ ok: false, error: "name_required_first_last" });
    }
    if (!isLikelyEmail(golfer_email)) {
      return res.status(400).json({ ok: false, error: "email_required_valid" });
    }

    const c = await client.query(
      `
      SELECT 
        id, 
        slug, 
        name, 
        notes,
        payment_mode,
        stripe_account_id,
        platform_fee_bps,
        cart_fee_cents, 
        hire_clubs_fee_cents,
        cart_qty, 
        hire_clubs_qty,
        duration_9_mins, 
        duration_18_mins
      FROM booking_courses
      WHERE slug=$1
      LIMIT 1;
      `,
      [slug]
    );

    if (!c.rows.length)
      return res.status(404).json({ ok: false, error: "course_not_found" });

    const courseRow = c.rows[0];
    const courseId = courseRow.id;

    // ✅ NEW: payment branching
    const payment_mode = String(courseRow.payment_mode || "PAY_AT_COURSE").trim().toUpperCase();
    const stripe_account_id = String(courseRow.stripe_account_id || "").trim();

    // ✅ FIX: read env safely
    const envPlatformFeeBps = Number(process.env.PLATFORM_FEE_BPS || 0);
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || "").trim();

    // ✅ per-course fee override
    const courseFeeBpsRaw =
      courseRow.platform_fee_bps !== undefined && courseRow.platform_fee_bps !== null
        ? Number(courseRow.platform_fee_bps)
        : envPlatformFeeBps;

    const courseFeeBps = Number.isFinite(courseFeeBpsRaw)
      ? Math.max(0, Math.min(10000, Math.trunc(courseFeeBpsRaw)))
      : 0;

    // ✅ Subscriber discount config (defaults to 5%)
const SUBSCRIBER_DISCOUNT_PCT = Number(process.env.SUBSCRIBER_DISCOUNT_PCT || 5);
const SUBSCRIBER_EMAILS = String(process.env.SUBSCRIBER_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ✅ Determine if booking email is an active subscriber
async function isSubscriberEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;

  // 1) Env allowlist fallback (fastest to get live)
  if (SUBSCRIBER_EMAILS.includes(e)) return true;

  // 2) Optional: users table
  try {
    const r = await client.query(
      `
      SELECT 1
      FROM users
      WHERE lower(email) = lower($1)
        AND (
          COALESCE(is_pro,false) = true
          OR lower(COALESCE(plan,'')) IN ('pro','subscriber','paid')
          OR lower(COALESCE(subscription_status,'')) IN ('active','trialing')
        )
      LIMIT 1;
      `,
      [e]
    );
    if (r.rows?.length) return true;
  } catch {}

  // 3) Optional: subscriptions table
  try {
    const r2 = await client.query(
      `
      SELECT 1
      FROM subscriptions
      WHERE lower(email) = lower($1)
        AND status IN ('active','trialing')
      LIMIT 1;
      `,
      [e]
    );
    if (r2.rows?.length) return true;
  } catch {}

  return false;
}

    await client.query("BEGIN");
    didBegin = true;

    await advisoryLockForSlot(client, {
      courseId,
      dateYmd: date,
      timeHhMm: time,
      holes,
      layout_key,
      front_nine_key,
      back_nine_key,
    });

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint);`, [
      `addons:${courseId}`,
    ]);

    let startAtIso = toIsoDateTimeLocal(date, time);
    const dur = durationMinsForHoles(courseRow, holes);
    const endAtIso = new Date(new Date(startAtIso).getTime() + dur * 60 * 1000).toISOString();

    const courseCartQty = Number(courseRow.cart_qty || 0);
    const courseClubsQty = Number(courseRow.hire_clubs_qty || 0);

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

    if (cart_qty > 0 && courseCartQty > 0 && cart_qty > cartRemaining) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({ ok: false, error: "cart_sold_out", cartRemaining });
    }

    if (hire_clubs_qty > 0 && courseClubsQty > 0 && hire_clubs_qty > clubsRemaining) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({ ok: false, error: "hire_clubs_sold_out", clubsRemaining });
    }

    const courseCartFeeCents = Number(courseRow.cart_fee_cents || 0);
    const courseHireClubsFeeCents = Number(courseRow.hire_clubs_fee_cents || 0);

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

    const t = await client.query(
      `
      SELECT tee_time, status, booked_players, max_players, price_per_player_cents,
             layout_key, front_nine_key, back_nine_key
      FROM booking_times
      WHERE course_id=$1
        AND play_date=$2::date
        AND holes=$4
        AND split_part(tee_time,'|',1) = $3
        AND (
          ($4 = 18 AND lower(front_nine_key) = lower($6) AND lower(back_nine_key) = lower($7))
          OR
          ($4 = 9 AND lower(layout_key) = lower($5))
        )
      LIMIT 1
      FOR UPDATE;
      `,
      [
        courseId,
        date,
        time,
        holes,
        layout_key || "",
        front_nine_key || "",
        back_nine_key || "",
      ]
    );

    if (!t.rows.length) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(404).json({ ok: false, error: "time_not_found" });
    }

    const timeRow = t.rows[0];

    // ✅ IMPORTANT FIX:
    // booking_times.tee_time can be like "06:40|18:front|back".
    // booking_bookings.tee_time MUST be plain "HH:MM" so availability + daily sheet joins work.
    const teeTimeDbRaw = String(timeRow.tee_time || time || "").trim();
    const teeTimeDb = teeTimeDbRaw.split("|")[0].trim();

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

const ppp = Number(timeRow.price_per_player_cents || 0);

// ✅ addons total
const addonsCents =
  (final_has_cart ? cart_fee_cents : 0) +
  (final_has_hire_clubs ? hire_clubs_fee_cents : 0);

// ✅ SUBSCRIBER DISCOUNT (5% off green fees only)
const isSubscriber = await isSubscriberEmail(golfer_email);
const baseGreenCents = Math.max(0, ppp * players);

const discountCents =
  isSubscriber && SUBSCRIBER_DISCOUNT_PCT > 0
    ? Math.round((baseGreenCents * SUBSCRIBER_DISCOUNT_PCT) / 100)
    : 0;

const greenAfterDiscountCents = Math.max(0, baseGreenCents - discountCents);

// ✅ final total stored + charged
const totalCents = greenAfterDiscountCents + addonsCents;

const reference = makeRef("TR");
const bookingStatus = payment_mode === "PAY_ON_BOOKING" ? "PENDING_PAYMENT" : "CONFIRMED";

// ✅ PAY_AT_COURSE should show "amount due" on daily sheets (same as totalCents)
const amountDueCents = payment_mode === "PAY_AT_COURSE" ? totalCents : 0;

// ✅ subscriber discount flags come from the discount we just calculated
const subscriberDiscountApplied = discountCents > 0;
const subscriberDiscountCents = discountCents;

const ins = await client.query(
  `
  INSERT INTO booking_bookings
    (course_id, play_date, tee_time, holes, players,
     golfer_name, golfer_email, golfer_phone,
     price_per_player_cents, total_cents, amount_due_cents,
     reference, status,
     subscriber_discount_applied, subscriber_discount_cents,
     start_at, end_at,
     paid, checked_in,
     has_cart, cart_qty, cart_fee_cents,
     has_hire_clubs, hire_clubs_qty, hire_clubs_fee_cents,
     layout_key, front_nine_key, back_nine_key,
     created_at)
  VALUES
    ($1,$2::date,$3,$4,$5,
     $6,$7,$8,
     $9,$10,$11,
     $12,$13,
     $14,$15,
     $16::timestamptz,$17::timestamptz,
     false,false,
     $18,$19,$20,
     $21,$22,$23,
     $24,$25,$26,
     now())
  RETURNING id, reference;
  `,
  [
    courseId,                   // $1
    date,                       // $2
    teeTimeDb,                  // $3
    holes,                      // $4
    players,                    // $5
    golfer_name || null,        // $6
    golfer_email || null,       // $7
    golfer_phone || null,       // $8
    ppp,                        // $9
    totalCents,                 // $10
    amountDueCents,             // $11
    reference,                  // $12
    bookingStatus,              // $13
    subscriberDiscountApplied,  // $14
    subscriberDiscountCents,    // $15
    startAtIso,                 // $16
    endAtIso,                   // $17
    final_has_cart,             // $18
    cart_qty,                   // $19
    cart_fee_cents,             // $20
    final_has_hire_clubs,       // $21
    hire_clubs_qty,             // $22
    hire_clubs_fee_cents,       // $23
    timeRow.layout_key || "",         // $24
    timeRow.front_nine_key || "",     // $25
    timeRow.back_nine_key || "",      // $26
  ]
);

const bookingId = ins.rows[0]?.id;

const newBooked = bookedPlayers + players;

await client.query(
  `
  UPDATE booking_times
  SET
    booked_players = $8,
    status = CASE
      WHEN status = 'BLOCKED' THEN 'BLOCKED'
      WHEN $8 >= max_players THEN 'BOOKED'
      ELSE 'AVAILABLE'
    END,
    updated_at = now()
  WHERE course_id=$1
    AND play_date=$2::date
    AND tee_time=$3
    AND holes=$4
    AND (
      ($4 = 18 AND lower(front_nine_key) = lower($6) AND lower(back_nine_key) = lower($7))
      OR
      ($4 = 9 AND lower(layout_key) = lower($5))
    );
  `,
  [
    courseId,
    date,
    teeTimeDb,
    holes,
    layout_key || "",
    front_nine_key || "",
    back_nine_key || "",
    newBooked,
  ]
);

    // ✅ CHANGE: create Stripe session AFTER UPDATE but BEFORE COMMIT
    if (payment_mode === "PAY_ON_BOOKING") {
      if (!stripe) {
        await client.query("ROLLBACK");
        didBegin = false;
        return res.status(500).json({ ok: false, error: "stripe_not_configured" });
      }
      if (!stripe_account_id) {
        await client.query("ROLLBACK");
        didBegin = false;
        return res.status(400).json({ ok: false, error: "course_missing_stripe_account" });
      }
      if (!publicBaseUrl) {
        await client.query("ROLLBACK");
        didBegin = false;
        return res.status(500).json({ ok: false, error: "public_base_url_missing" });
      }

      // ✅ ADD: ensure connected account is fully onboarded for transfers
      try {
        const acct = await stripe.accounts.retrieve(stripe_account_id);
        const transfersCap = acct?.capabilities?.transfers;

        if (transfersCap && String(transfersCap) !== "active") {
          await client.query("ROLLBACK");
          didBegin = false;
          return res.status(400).json({
            ok: false,
            error: "course_stripe_not_ready",
            message: "Course Stripe Connect onboarding not completed (transfers not active).",
          });
        }

        if (acct?.charges_enabled === false || acct?.payouts_enabled === false) {
          await client.query("ROLLBACK");
          didBegin = false;
          return res.status(400).json({
            ok: false,
            error: "course_stripe_not_ready",
            message: "Course Stripe account is not enabled for charges/payouts yet.",
          });
        }
      } catch (e) {
        console.warn("Stripe account readiness check failed:", e?.message || e);
      }

      const application_fee_amount = Math.max(
        0,
        Math.round((totalCents * courseFeeBps) / 10000)
      );

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: golfer_email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "aud",
              unit_amount: totalCents, // ✅ already discounted if subscriber
              product_data: {
                name: `${courseRow.name} — ${holes} holes (${players} players)`,
                description: `${date} ${time}`,
              },
            },
          },
        ],
        payment_intent_data: {
          application_fee_amount,
          transfer_data: { destination: stripe_account_id },
          metadata: {
            booking_id: String(bookingId || ""),
            reference,
            course_slug: slug,
            platform_fee_bps: String(courseFeeBps),

            // ✅ subscriber audit
            subscriber: isSubscriber ? "1" : "0",
            subscriber_discount_pct: String(isSubscriber ? SUBSCRIBER_DISCOUNT_PCT : 0),
            discount_cents: String(discountCents || 0),
          },
        },
        metadata: {
          booking_id: String(bookingId || ""),
          reference,
          course_slug: slug,
          platform_fee_bps: String(courseFeeBps),

          // ✅ subscriber audit
          subscriber: isSubscriber ? "1" : "0",
          subscriber_discount_pct: String(isSubscriber ? SUBSCRIBER_DISCOUNT_PCT : 0),
          discount_cents: String(discountCents || 0),
        },
        success_url: `${BASE_URL}/book-success.html?reference=${encodeURIComponent(reference)}`,
        cancel_url: `${BASE_URL}/book/${slug}?cancelled=1`,
      });

      await client.query("COMMIT");
      didBegin = false;

      return res.json({
        ok: true,
        reference,
        payment_mode: "PAY_ON_BOOKING",
        checkoutUrl: session.url,
        course: { slug: courseRow.slug, name: courseRow.name },
        booking: {
          date,
          time,
          holes,
          players,
          pricePerPlayerCents: ppp,

          isSubscriber,
          discountPct: isSubscriber ? SUBSCRIBER_DISCOUNT_PCT : 0,
          discountCents,

          totalCents,
          addonsCents,
          amountDueCents: 0, // ✅ prepaid
          cart_qty,
          hire_clubs_qty,
          layout_key,
          front_nine_key,
          back_nine_key,
        },
        emailOk: false,
        emailReason: "pay_on_booking",
      });
    }

    await client.query("COMMIT");
    didBegin = false;

    // ---- PAY_AT_COURSE existing analytics/email/response ----
    recordEvent({
      type: "booking_created",
      userId: getClientIp(req) || null,
      courseName: courseRow.name,
      meta: { slug, date, time, holes, players, reference, cart_qty, hire_clubs_qty, layout_key, front_nine_key, back_nine_key },
    }).catch(() => {});
    recordBookingEvent(req, {
      courseSlug: slug,
      eventType: "booking_confirmed",
      payload: { slug, date, time, holes, players, reference, cart_qty, hire_clubs_qty, layout_key, front_nine_key, back_nine_key },
    }).catch(() => {});

    const emailResult = await sendBookingEmail({
      to: golfer_email,
      courseName: courseRow.name,
      date,
      time,
      holes,
      players,
      reference,
      pricePerPlayerCents: ppp,
      totalCents: totalCents, // ✅ already discounted if subscriber
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

        isSubscriber,
        discountPct: isSubscriber ? SUBSCRIBER_DISCOUNT_PCT : 0,
        discountCents,

        totalCents,
        addonsCents,
        amountDueCents, // ✅ shows what they owe at course
        cart_qty,
        hire_clubs_qty,
        layout_key,
        front_nine_key,
        back_nine_key,
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
// ===============================
// CONFIRM PAYMENT (PAY_ON_BOOKING)
// Called by book-course.html after Stripe redirect
// ===============================
router.post("/confirm-payment", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "session_id_required" });

    // 1) Load session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Must be paid (Stripe uses payment_status: 'paid' for Checkout)
    if (session.payment_status !== "paid") {
      return res.status(409).json({
        ok: false,
        error: "not_paid_yet",
        payment_status: session.payment_status || null,
      });
    }

    const meta = session.metadata || {};
    const reference = String(meta.reference || "").trim();
    if (!reference) {
      return res.status(400).json({ ok: false, error: "missing_reference_in_metadata" });
    }

    // 2) Finalize booking (idempotent — safe if webhook already ran)
    const fin = await finalizePaidBooking({
      reference,
      stripe_session_id: String(session.id || ""),
      stripe_payment_intent: String(session.payment_intent || ""),
    });

    if (!fin || fin.ok !== true) {
      return res.status(500).json({ ok: false, error: fin?.error || "finalize_failed" });
    }

    // 3) Return booking details for the frontend confirmation modal
    const b = await db.query(
      `
      SELECT
        b.reference,
        b.play_date,
        b.tee_time,
        b.holes,
        b.players,
        b.golfer_email,
        b.price_per_player_cents,
        b.total_cents,
        b.cart_fee_cents,
        b.hire_clubs_fee_cents,
        c.name AS course_name
      FROM booking_bookings b
      JOIN booking_courses c ON c.id = b.course_id
      WHERE b.reference = $1
      LIMIT 1;
      `,
      [reference]
    );

    const booking = b.rows[0];
    if (!booking) return res.status(404).json({ ok: false, error: "booking_not_found" });

    return res.json({
      ok: true,
      reference: booking.reference,
      email: booking.golfer_email,
      date: String(booking.play_date).slice(0, 10),
      time: String(booking.tee_time || "").split("|")[0], // should already be HH:MM now
      holes: Number(booking.holes || 0),
      players: Number(booking.players || 0),
      courseName: booking.course_name,

      // used by your UI (selectedSlot in handleStripeReturn)
      pricePerPlayerCents: Number(booking.price_per_player_cents || 0),

      // nice-to-have for totals (your showBookingConfirmation uses these)
      totalCents: Number(booking.total_cents || 0),
      cartCents: Number(booking.cart_fee_cents || 0),
      hireClubsCents: Number(booking.hire_clubs_fee_cents || 0),

      // pass through finalize email result (if you return it)
      emailOk: fin.emailOk === true,
      emailReason: fin.emailReason || null,
    });
  } catch (e) {
    console.error("confirm-payment error", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
// ===============================
// STRIPE WEBHOOK (PAY_ON_BOOKING)
// ===============================
router.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(400).send("Stripe not configured");

    const sig = req.headers["stripe-signature"];
    const endpointSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

    if (!endpointSecret) {
      console.error("❌ Missing STRIPE_WEBHOOK_SECRET env var");
      return res.status(500).send("Missing webhook secret");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Stripe webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ Mark booking as paid + confirmed when checkout completes
    if (event.type === "checkout.session.completed") {
  const session = event.data.object;

  const reference = session?.metadata?.reference
    ? String(session.metadata.reference).trim()
    : "";

  if (!reference) {
    console.error("❌ Webhook missing reference metadata");
    return res.status(400).send("Missing reference");
  }

  try {
    // ✅ This marks paid+confirmed AND sends email (idempotent / safe on retries)
    await finalizePaidBooking({
      reference,
      stripe_session_id: String(session.id || ""),
      stripe_payment_intent: String(session.payment_intent || ""),
    });

    console.log("✅ Webhook finalized booking:", { reference });
  } catch (e) {
    console.error("❌ Webhook finalize failed", e?.message || e);
    return res.status(500).send("Finalize error");
  }
}

return res.json({ received: true });
  }
);

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