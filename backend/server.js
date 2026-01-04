// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import Stripe from "stripe"; // ✅ Stripe
import jwt from "jsonwebtoken"; // ✅ NEW (only used to read email from Bearer token)

// ✅ NEW: cookies (needed for booking admin auth cookie)
import cookieParser from "cookie-parser";

// ✅ NEW: booking routes
import bookingRoutes from "./bookingRoutes.js";

// ✅✅✅ ADD (needed): booking views (view booked tee times / bookings) ✅✅✅
import bookingViewsRouter from "./bookingViews.js";
// ✅✅✅ END ADD ✅✅✅
import bookingAnalyticsRouter from "./bookingAnalyticsRoutes.js";
import { ensureBookingAddonsSchema } from "./bookingMigrate.js";
import analyticsRouter from "./analyticsRoutes.js";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics (Postgres)
import { recordEvent, getAnalyticsSummary, getTopCourses } from "./analytics.js";

// Cache + DB
import db from "./db.js";
import { getCachedSlots, saveSlotsToCache } from "./slotCache.js";

// Auth router
import authRouter from "./auth.js";

// 🔔 Alerts (NEW)
import alertsRouter from "./alertsRoutes.js";
import { startAlertWorker, runAlertTickOnce } from "./alertWorker.js"; // ✅ ADDED runAlertTickOnce

// ✅ NEW: Rounds router
import roundsRouter from "./roundsRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ ADD THIS (Render/HTTPS proxy support so secure cookies can be set)
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

// ✅ Live site base URL (use everywhere we generate links)
// ✅ FIX: define SITE_URL only once (was duplicated later)
const SITE_URL = (process.env.SITE_URL || "https://teeradar.com.au").trim();

// ✅ SUPER ADMIN emails (comma-separated in env)
const SUPER_ADMINS = (process.env.SUPER_ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isSuperAdmin(email) {
  return SUPER_ADMINS.includes(String(email || "").toLowerCase());
}

// ✅ Stripe init
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Map of plan keys → Stripe price IDs
const PRICE_IDS = {
  BASIC_MONTHLY: "price_1SdnQTASm4geYL4WeBGAEEkA",
  BASIC_ANNUAL: "price_1SdnRLASm4geYL4W23IKreHO",
  PRO_MONTHLY: "price_1SdnSGASm4geYL4WBWsFWUNe",
  PRO_ANNUAL: "price_1SdnSpASm4geYL4W1yxaZf2i",
};

// ✅ Reverse map: price → plan + favourite limit
const PRICE_TO_PLAN = {};
for (const [key, priceId] of Object.entries(PRICE_IDS)) {
  if (!priceId) continue;
  if (key.startsWith("BASIC")) {
    PRICE_TO_PLAN[priceId] = { plan: "BASIC", maxFavs: 3 };
  } else if (key.startsWith("PRO")) {
    PRICE_TO_PLAN[priceId] = { plan: "PRO", maxFavs: 10 };
  }
}

app.get("/api/analytics/debug", async (req, res) => {
  try {
    const total = await db.query(`SELECT COUNT(*)::int AS n FROM analytics;`);
    const byType = await db.query(`
      SELECT type, COUNT(*)::int AS n
      FROM analytics
      GROUP BY type
      ORDER BY n DESC
      LIMIT 50;
    `);

    const recent = await db.query(`
      SELECT type, user_id, course_name, occurred_at
      FROM analytics
      ORDER BY occurred_at DESC, id DESC
      LIMIT 25;
    `);

    res.json({
      ok: true,
      total: total.rows[0]?.n ?? 0,
      byType: byType.rows,
      recent: recent.rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ✅ NEW: small helper to get email from body/query OR Bearer token
function getEmailFromRequest(req) {
  const fromBody = req.body && req.body.email ? String(req.body.email) : "";
  const fromQuery = req.query && req.query.email ? String(req.query.email) : "";
  let email = (fromBody || fromQuery || "").trim().toLowerCase();
  if (email) return email;

  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  if (!token) return "";

  // Prefer verified token if a secret exists
  const JWT_SECRET =
    process.env.JWT_SECRET ||
    process.env.AUTH_JWT_SECRET ||
    process.env.AUTH_SECRET ||
    "";

  try {
    if (JWT_SECRET) {
      const payload = jwt.verify(token, JWT_SECRET);
      const tokenEmail =
        (payload && (payload.email || payload.userEmail || payload.sub)) || "";
      return String(tokenEmail).trim().toLowerCase();
    }
  } catch {
    // fall through to decode-only
  }

  // Fallback: decode without verifying
  try {
    const payload = jwt.decode(token);
    const tokenEmail =
      (payload && (payload.email || payload.userEmail || payload.sub)) || "";
    return String(tokenEmail).trim().toLowerCase();
  } catch {
    return "";
  }
}

// ✅ NEW: require login via Bearer token (for "My Rounds")
function requireAuth(req, res, next) {
  const JWT_SECRET =
    process.env.JWT_SECRET ||
    process.env.AUTH_JWT_SECRET ||
    process.env.AUTH_SECRET ||
    "";

  if (!JWT_SECRET) {
    return res.status(500).json({ ok: false, error: "JWT_SECRET not set" });
  }

  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      email: payload.email,
    };
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
// ✅ NEW: ensure users table has plan column (Stripe/webhooks + analytics rely on it)
async function ensureUsersPlanColumn() {
  try {
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'FREE';
    `);

    // backfill safety (older rows)
    await db.query(`
      UPDATE users
      SET plan = 'FREE'
      WHERE plan IS NULL OR TRIM(plan) = '';
    `);

    console.log("✅ users.plan column ready");
  } catch (err) {
    console.error("❌ error ensuring users plan column:", err);
  }
}
ensureUsersPlanColumn();
// ✅ NEW: ensure user_preferences table exists
async function ensureUserPreferencesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        email TEXT PRIMARY KEY,
        home_state TEXT,
        favourites JSONB,
        preferred_days TEXT[],
        preferred_earliest TEXT,
        preferred_latest TEXT,
        preferred_holes INTEGER,
        preferred_party_size INTEGER,
        alert_frequency TEXT,
        alert_last_sent TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await db.query(`
      ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS alert_frequency TEXT;
    `);

    await db.query(`
      ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS alert_last_sent TIMESTAMPTZ;
    `);

    console.log("✅ user_preferences table ready");
  } catch (err) {
    console.error("❌ error ensuring user_preferences table:", err);
  }
}
ensureUserPreferencesTable();

// ✅ NEW: ensure users table has home course columns (so preferences really persist)
async function ensureUsersHomeCourseColumns() {
  try {
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course TEXT;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course_id TEXT;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course_state TEXT;
    `);

    console.log("✅ users home_course columns ready");
  } catch (err) {
    console.error("❌ error ensuring users home_course columns:", err);
  }
}
ensureUsersHomeCourseColumns();

// ✅ NEW: table for alert "hits" (used by the logged-in popup unread/viewed flow)
async function ensureAlertHitsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS alert_hits (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT,
        course_id TEXT,
        state TEXT,
        date TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS alert_hits_email_read_idx
      ON alert_hits (email, read_at);
    `);

    console.log("✅ alert_hits table ready");
  } catch (err) {
    console.error("❌ error ensuring alert_hits table:", err);
  }
}
ensureAlertHitsTable();

// ✅ NEW: ensure rounds + round_holes tables exist (score tracking)
async function ensureRoundsTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,

        course TEXT NOT NULL,
        layout TEXT,
        state TEXT,

        holes INTEGER NOT NULL,
        par_mode TEXT NOT NULL,

        created_at TIMESTAMPTZ DEFAULT now(),

        CONSTRAINT fk_round_user
          FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS round_holes (
        id SERIAL PRIMARY KEY,
        round_id INTEGER NOT NULL,

        hole_number INTEGER NOT NULL,
        par INTEGER,
        strokes INTEGER,
        putts INTEGER,

        CONSTRAINT fk_round
          FOREIGN KEY (round_id)
          REFERENCES rounds(id)
          ON DELETE CASCADE,

        CONSTRAINT unique_round_hole
          UNIQUE (round_id, hole_number)
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_rounds_user
      ON rounds(user_id);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_round_holes_round
      ON round_holes(round_id);
    `);

    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS players_count INTEGER;
    `);

    await db.query(`
      ALTER TABLE rounds
      ALTER COLUMN players_count SET DEFAULT 1;
    `);

    await db.query(`
      UPDATE rounds
      SET players_count = 1
      WHERE players_count IS NULL;
    `);

    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS player_names JSONB;
    `);

    await db.query(`
      UPDATE rounds
      SET player_names = COALESCE(player_names, '[]'::jsonb)
      WHERE player_names IS NULL;
    `);

    await db.query(`
      ALTER TABLE rounds
      ALTER COLUMN player_names SET DEFAULT '[]'::jsonb;
    `);

    await db.query(`
      ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS strokes_by_player JSONB;
    `);

    await db.query(`
      ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS putts_by_player JSONB;
    `);

    await db.query(`
      UPDATE round_holes
      SET
        strokes_by_player = COALESCE(strokes_by_player, '{}'::jsonb),
        putts_by_player   = COALESCE(putts_by_player, '{}'::jsonb)
      WHERE strokes_by_player IS NULL OR putts_by_player IS NULL;
    `);

    await db.query(`
      ALTER TABLE round_holes
      ALTER COLUMN strokes_by_player SET DEFAULT '{}'::jsonb;
    `);

    await db.query(`
      ALTER TABLE round_holes
      ALTER COLUMN putts_by_player SET DEFAULT '{}'::jsonb;
    `);

    await db.query(`
      ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS distance_m INTEGER;
    `);

    console.log("✅ rounds + round_holes tables ready");
  } catch (err) {
    console.error("❌ error ensuring rounds tables:", err);
  }
}
ensureRoundsTables();

/* ✅✅✅ ONLY ADDITION (needed): ensure booking tables exist (so admin can create courses + generate times) ✅✅✅ */
async function ensureBookingTables() {
  try {
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
      CREATE INDEX IF NOT EXISTS booking_bookings_course_date_idx
      ON booking_bookings (course_id, play_date);
    `);

    console.log("✅ booking tables ready");
  } catch (err) {
    console.error("❌ error ensuring booking tables:", err);
  }
}
ensureBookingTables();
/* ✅✅✅ END ONLY ADDITION ✅✅✅ */
ensureBookingTables();
ensureBookingAddonsSchema(db)
  .then(() => console.log("✅ booking add-ons schema ready"))
  .catch((err) => console.error("❌ error ensuring booking add-ons schema:", err));
/* ✅✅✅ FIX (needed): CORS + preflight, and do NOT duplicate SITE_URL ✅✅✅ */
const EXTRA_CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  "https://www.teeradar.com.au",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  ...EXTRA_CORS_ORIGINS,
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // allow curl/server-to-server
  if (ALLOWED_ORIGINS.has(origin)) return true;

  try {
    const u = new URL(origin);
    const host = (u.hostname || "").toLowerCase();
    if (host.endsWith(".onrender.com")) return true; // allow render previews
  } catch {}
  return false;
}

const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(null, false); // ✅ don't throw
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Booking-Admin-Secret",
    "x-booking-admin-secret",
  ],
};

app.use(cors(corsOptions));
// ✅ IMPORTANT: preflight must be OK (some browsers will fail login without this)
app.options("*", cors(corsOptions));
/* ✅✅✅ END FIX ✅✅✅ */

// -------------------------------------------------
// Stripe Webhook – must be BEFORE express.json
// -------------------------------------------------
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Stripe webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          const email = (session.customer_details?.email || session.customer_email || "")
            .toString()
            .trim()
            .toLowerCase();

          const subId = session.subscription;

          if (email && subId) {
            const sub = await stripe.subscriptions.retrieve(subId, {
              expand: ["items.data.price"],
            });

            const priceId = sub?.items?.data?.[0]?.price?.id || null;
            const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;

            const plan = mapped?.plan || "BASIC"; // fallback if unknown
            await db.query(
              `UPDATE users SET plan = $2 WHERE LOWER(email) = $1`,
              [email, plan]
            );

            console.log("✅ Updated plan from checkout:", email, plan, priceId);
          } else {
            console.log("ℹ️ checkout.session.completed missing email/subscription", {
              email: !!email,
              subId: !!subId,
            });
          }
          break;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;

          const customerId = sub.customer;
          const priceId = sub?.items?.data?.[0]?.price?.id || null;

          const cust = await stripe.customers.retrieve(customerId);
          const email = (cust?.email || "").toString().trim().toLowerCase();

          if (email) {
            let plan = "FREE";

            if (
              event.type !== "customer.subscription.deleted" &&
              sub.status === "active"
            ) {
              const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;
              plan = mapped?.plan || "BASIC";
            }

            await db.query(
              `UPDATE users SET plan = $2 WHERE LOWER(email) = $1`,
              [email, plan]
            );

            console.log("✅ Updated plan from subscription:", email, plan, priceId);
          }
          break;
        }

        case "invoice.payment_succeeded": {
          const invoice = event.data.object;
          console.log("💰 invoice.payment_succeeded:", invoice.id);
          break;
        }

        default:
          console.log(`ℹ️ Unhandled Stripe event type: ${event.type}`);
          break;
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler failed:", err);
      return res.status(500).json({ received: true }); // still 200/ok-ish for Stripe
    }
  }
);
app.use(express.json());

// ✅ NEW: cookies (needed for booking admin auth cookie)
app.use(cookieParser());

// ✅ Booking Admin: accept header auth as well as cookies (Safari can drop cookies)
function _isBookingAdminReq(req) {
  const expected = String(process.env.BOOKING_ADMIN_SECRET || "").trim();
  const got = String(req.headers["x-booking-admin-secret"] || "").trim();

  if (expected && got && got === expected) return true;

  return (
    req.cookies?.tr_book_admin === "1" ||
    req.cookies?.booking_admin === "1" ||
    req.cookies?.bookingAdmin === "1" ||
    req.cookies?.booking_admin_auth === "1"
  );
}

// ✅ DEBUG: confirm admin auth is being received (must be ABOVE app.get("*") fallback)
app.get("/api/book/admin/_debug", (req, res) => {
  res.json({
    ok: true,
    gotHeader: !!req.headers["x-booking-admin-secret"],
    isBookingAdmin: _isBookingAdminReq(req),
    cookies: {
      booking_admin: req.cookies?.booking_admin || null,
      bookingAdmin: req.cookies?.bookingAdmin || null,
      booking_admin_auth: req.cookies?.booking_admin_auth || null,
    },
  });
});

app.use(express.static(path.join(__dirname, "..", "public")));

/* ✅✅✅ ONLY ADDITION (needed): more robust scorecards file discovery (Render-safe) ✅✅✅ */
function _buildScorecardsCandidates(st) {
  const s = String(st || "").trim().toUpperCase();
  const variants = [
    `scorecards-${s.toLowerCase()}.json`,
    `scorecards-${s}.json`,
    `scorecards_${s.toLowerCase()}.json`,
    `scorecards_${s}.json`,
  ];

  const out = [];

  // backend locations
  for (const fn of variants) {
    out.push(path.join(__dirname, "data", "scorecards", fn));
    out.push(path.join(__dirname, "data", fn));
    out.push(path.join(__dirname, fn));
  }

  // public locations
  for (const fn of variants) {
    out.push(path.join(__dirname, "..", "public", "data", "scorecards", fn));
    out.push(path.join(__dirname, "..", "public", "scorecards", fn));
    out.push(path.join(__dirname, "..", "public", "data", fn));
  }

  // cwd fallbacks (Render working dir can differ)
  for (const fn of variants) {
    out.push(path.join(process.cwd(), "backend", "data", "scorecards", fn));
    out.push(path.join(process.cwd(), "backend", "data", fn));
    out.push(path.join(process.cwd(), "data", "scorecards", fn));
    out.push(path.join(process.cwd(), "data", fn));
    out.push(path.join(process.cwd(), "public", "data", "scorecards", fn));
    out.push(path.join(process.cwd(), "public", "data", fn));
  }

  return Array.from(new Set(out));
}

function _safeListDir(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readdirSync(p).slice(0, 80);
  } catch {
    return null;
  }
}

function _readScorecardsForState(st) {
  const candidates = _buildScorecardsCandidates(st);
  const errors = [];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;

      const raw = fs.readFileSync(p, "utf8");

      const fixed = raw
        .replace(/^\uFEFF/, "")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/,\s*([}\]])/g, "$1");

      const j = JSON.parse(fixed);

      if (Array.isArray(j)) return { data: j, foundPath: p, candidates, errors };
      if (j && Array.isArray(j.scorecards))
        return { data: j.scorecards, foundPath: p, candidates, errors };
    } catch (e) {
      errors.push({
        path: p,
        message: String(e?.message || e),
      });
    }
  }

  return { data: null, foundPath: "", candidates, errors };
}
/* ✅✅✅ END ONLY ADDITION ✅✅✅ */

/* ✅✅✅ ONLY ADDITION (needed): expose backend scorecards JSON to frontend ✅✅✅ */
app.get("/api/scorecards/:state", (req, res) => {
  try {
    const st = String(req.params.state || "").trim().toUpperCase();
    if (!st) return res.status(400).json({ error: "state required" });

    const { data, foundPath, candidates, errors } = _readScorecardsForState(st);

    if (!Array.isArray(data)) {
      return res.status(404).json({
        error: "scorecards file not found",
        state: st,
        expectedExamples: [
          "backend/data/scorecards/scorecards-wa.json",
          "public/data/scorecards/scorecards-wa.json",
        ],
        tried: candidates,
        parseErrors: errors,
        debug: {
          __dirname,
          cwd: process.cwd(),
          backendDataDir: _safeListDir(path.join(__dirname, "data")),
          backendScorecardsDir: _safeListDir(
            path.join(__dirname, "data", "scorecards")
          ),
          publicDataDir: _safeListDir(path.join(__dirname, "..", "public", "data")),
          publicScorecardsDir: _safeListDir(
            path.join(__dirname, "..", "public", "data", "scorecards")
          ),
        },
      });
    }

    if (foundPath) {
      console.log(`✅ scorecards loaded for ${st} from ${foundPath}`);
    }

    return res.json(data);
  } catch (err) {
    console.error("scorecards route error", err);
    return res.status(500).json({ error: "failed to load scorecards" });
  }
});
/* ✅✅✅ END ONLY ADDITION ✅✅✅ */

app.use("/api/auth", authRouter);

// ✅ NEW: booking API router
app.use("/api/book", bookingRoutes);

// ✅✅✅ ADD (needed): mount booking views router (admin/course-admin views) ✅✅✅
app.use((req, res, next) => {
  req.isSuperAdmin = (email) => isSuperAdmin(email);
  req.isBookingAdmin = () => _isBookingAdminReq(req);
  req.bookingAdmin = _isBookingAdminReq(req);
  next();
});

// ✅✅✅ ADD THIS ✅✅✅
app.use(bookingAnalyticsRouter);
// ✅✅✅ END ADD ✅✅✅
app.use("/api/analytics", analyticsRouter);
app.use(bookingViewsRouter);
// ✅✅✅ END ADD ✅✅✅

// ✅ NOTE: roundsRouter mounts routes that can collide with the inline /api/rounds handlers below.
// Keeping inline /api/rounds as the source of truth here.
// app.use("/api/rounds", roundsRouter);

// -------------------------------------------------
// ✅ NEW: /api/me (for bookings page to read home state)
// -------------------------------------------------
app.get("/api/me", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const { rows } = await db.query(
      `
      SELECT
        u.email,
        u.home_course,
        u.home_course_id,
        u.home_course_state,
        p.home_state
      FROM users u
      LEFT JOIN user_preferences p
        ON p.email = u.email
      WHERE u.email = $1
      LIMIT 1;
      `,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "user not found" });
    }

    const row = rows[0];

    return res.json({
      email: row.email,
      homeCourse: row.home_course || null,
      homeCourseId: row.home_course_id || null,
      homeCourseState: row.home_state || row.home_course_state || null,
    });
  } catch (err) {
    console.error("/api/me error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// -------------------------------------------------
// ✅ NEW: GET account preferences (Option 2 response shape)
// -------------------------------------------------
app.get("/api/account/preferences", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });

    const { rows } = await db.query(
      `
      SELECT *
      FROM user_preferences
      WHERE email = $1
      LIMIT 1;
      `,
      [email]
    );

    if (!rows.length) {
      return res.json({ ok: true, found: false, preferences: null });
    }

    return res.json({ ok: true, found: true, preferences: rows[0] });
  } catch (err) {
    console.error("/api/account/preferences GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ✅ Optional alias
app.get("/api/preferences", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });

    const { rows } = await db.query(
      `
      SELECT *
      FROM user_preferences
      WHERE email = $1
      LIMIT 1;
      `,
      [email]
    );

    if (!rows.length) {
      return res.json({ ok: true, found: false, preferences: null });
    }

    return res.json({ ok: true, found: true, preferences: rows[0] });
  } catch (err) {
    console.error("/api/preferences GET error", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -------------------------------------------------
// ✅ NEW: My Rounds (logged-in only)
// -------------------------------------------------
app.get("/api/rounds", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }

    const { rows } = await db.query(
      `
      SELECT id, course, layout, state, holes, par_mode, players_count, player_names, created_at
      FROM rounds
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200;
      `,
      [userId]
    );

    return res.json({ ok: true, rounds: rows || [] });
  } catch (err) {
    console.error("/api/rounds GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

app.post("/api/rounds", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }

    const {
      course,
      layout = null,
      state = null,
      holes = 18,
      pars = null,
      par_mode = "PUBLISHED",
      playersCount = 1,
      playerNames = null,
    } = req.body || {};

    const courseName = (course || "").toString().trim();
    const holesCount = Number(holes);

    if (!courseName) {
      return res.status(400).json({ ok: false, error: "course is required" });
    }

    if (![9, 18].includes(holesCount)) {
      return res.status(400).json({ ok: false, error: "holes must be 9 or 18" });
    }

    const parMode = (par_mode || "").toString().trim().toUpperCase() || "PUBLISHED";

    let parsedPars = Array.isArray(pars)
      ? pars.map((p) =>
          p === null || typeof p === "undefined" || p === "" ? null : Number(p)
        )
      : null;

    let publishedDistances = null;

    if ((!parsedPars || !parsedPars.length) && parMode === "PUBLISHED") {
      const pub = getPublishedParsAndDistances(courseName, state, holesCount);
      if (Array.isArray(pub.pars) && pub.pars.length === holesCount) {
        parsedPars = pub.pars.slice(0, holesCount);
      }
      if (Array.isArray(pub.distances) && pub.distances.length === holesCount) {
        publishedDistances = pub.distances.slice(0, holesCount);
      }
    }

    if (parsedPars && parsedPars.length !== holesCount) {
      return res.status(400).json({
        ok: false,
        error: `pars must have length ${holesCount} (or be null)`,
      });
    }

    const pc = Number(playersCount);
    const safePlayersCount = Number.isFinite(pc) ? Math.max(1, Math.min(4, pc)) : 1;

    const namesArr = Array.isArray(playerNames)
      ? playerNames.map((x) => String(x || "").trim()).slice(0, 4)
      : [];

    while (namesArr.length < safePlayersCount) namesArr.push("");

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode, players_count, player_names, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      RETURNING id, course, layout, state, holes, par_mode, players_count, player_names, created_at;
      `,
      [
        userId,
        courseName,
        layout,
        state,
        holesCount,
        parMode,
        safePlayersCount,
        JSON.stringify(namesArr),
      ]
    );

    const round = roundInsert.rows[0];

    const values = [];
    const params = [];
    let idx = 1;

    for (let i = 1; i <= holesCount; i++) {
      const parVal = parsedPars ? parsedPars[i - 1] : null;
      const distVal = Array.isArray(publishedDistances)
        ? publishedDistances[i - 1]
        : null;

      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(round.id, i, parVal, distVal, null, null);
    }

    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts)
      VALUES ${values.join(", ")}
      `,
      params
    );

    return res.json({ ok: true, round });
  } catch (err) {
    console.error("/api/rounds POST error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal error", detail: err.message });
  }
});

app.get("/api/rounds/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const roundId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid round id" });
    }

    const roundRes = await db.query(
      `
      SELECT id, user_id, course, layout, state, holes, par_mode, players_count, player_names, created_at
      FROM rounds
      WHERE id = $1
      LIMIT 1;
      `,
      [roundId]
    );

    if (!roundRes.rows.length) {
      return res.status(404).json({ ok: false, error: "Round not found" });
    }

    const round = roundRes.rows[0];

    if (Number(round.user_id) !== userId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const holesRes = await db.query(
      `
      SELECT hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [roundId]
    );

    return res.json({ ok: true, round, holes: holesRes.rows || [] });
  } catch (err) {
    console.error("/api/rounds/:id GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

app.patch("/api/rounds/:id/hole/:holeNumber", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const roundId = Number(req.params.id);
    const holeNumber = Number(req.params.holeNumber);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid round id" });
    }
    if (!Number.isInteger(holeNumber) || holeNumber <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid hole number" });
    }

    const own = await db.query(
      `SELECT id FROM rounds WHERE id = $1 AND user_id = $2 LIMIT 1;`,
      [roundId, userId]
    );
    if (!own.rows.length) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { strokes, putts, par, strokesByPlayer, puttsByPlayer } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === ""
        ? null
        : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === ""
        ? null
        : Number(putts);

    const parVal =
      par === null || typeof par === "undefined" || par === "" ? undefined : Number(par);

    if (strokesVal !== null && !Number.isFinite(strokesVal)) {
      return res.status(400).json({ ok: false, error: "strokes must be a number or null" });
    }
    if (puttsVal !== null && !Number.isFinite(puttsVal)) {
      return res.status(400).json({ ok: false, error: "putts must be a number or null" });
    }
    if (typeof parVal !== "undefined" && !Number.isFinite(parVal)) {
      return res.status(400).json({ ok: false, error: "par must be a number or omitted" });
    }

    const sbp =
      strokesByPlayer && typeof strokesByPlayer === "object" && !Array.isArray(strokesByPlayer)
        ? JSON.stringify(strokesByPlayer)
        : null;

    const pbp =
      puttsByPlayer && typeof puttsByPlayer === "object" && !Array.isArray(puttsByPlayer)
        ? JSON.stringify(puttsByPlayer)
        : null;

    const result = await db.query(
      `
      UPDATE round_holes
      SET
        strokes = $3,
        putts = $4,
        par = COALESCE($5, par),
        strokes_by_player = COALESCE($6::jsonb, strokes_by_player),
        putts_by_player = COALESCE($7::jsonb, putts_by_player)
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player;
      `,
      [
        roundId,
        holeNumber,
        strokesVal,
        puttsVal,
        typeof parVal === "undefined" ? null : parVal,
        sbp,
        pbp,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Hole not found" });
    }

    return res.json({ ok: true, hole: result.rows[0] });
  } catch (err) {
    console.error("/api/rounds/:id/hole/:holeNumber PATCH error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// 🔔 Alerts API
app.use("/api/alerts", alertsRouter);

app.get("/api/alerts/unread", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });

    const { rows } = await db.query(
      `
      SELECT id, email, course_name, course_id, state, date, slots, created_at
      FROM alert_hits
      WHERE email = $1 AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [email]
    );

    const hits = rows.map((r) => ({
      id: r.id,
      email: r.email,
      course_name: r.course_name,
      course_id: r.course_id,
      state: r.state,
      date: r.date,
      slots: r.slots || [],
      created_at: r.created_at,
    }));

    res.json({ ok: true, hits });
  } catch (err) {
    console.error("/api/alerts/unread error:", err);
    res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

app.post("/api/alerts/mark-read", async (req, res) => {
  try {
    const { email, ids = [] } = req.body || {};
    const trimmedEmail = (email || "").toString().trim().toLowerCase();
    if (!trimmedEmail) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const cleanIds = Array.isArray(ids)
      ? ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : [];

    if (!cleanIds.length) {
      return res.json({ ok: true, updated: 0 });
    }

    const result = await db.query(
      `
      UPDATE alert_hits
      SET read_at = now()
      WHERE email = $1
        AND id = ANY($2::bigint[])
      `,
      [trimmedEmail, cleanIds]
    );

    res.json({ ok: true, updated: result.rowCount || 0 });
  } catch (err) {
    console.error("/api/alerts/mark-read error", err);
    res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// Stripe Checkout – create subscription session
// -------------------------------------------------
app.post("/api/subscribe", async (req, res) => {
  try {
    const { plan, email } = req.body || {};
    const priceId = PRICE_IDS[plan];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid subscription plan" });
    }

    const customerEmail =
      email && email.toString().trim() !== ""
        ? email.toString().trim().toLowerCase()
        : undefined;

    const successUrl =
      process.env.STRIPE_SUCCESS_URL ||
      `${SITE_URL}/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}&paid=1`;
    const cancelUrl = process.env.STRIPE_CANCEL_URL || `${SITE_URL}/subscribe-cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: customerEmail,
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe checkout failed", detail: err.message });
  }
});

// -------------------------------------------------
// ✅ Billing portal – open Stripe customer portal
// -------------------------------------------------
app.post("/api/billing/portal", async (req, res) => {
  try {
    const trimmedEmail = getEmailFromRequest(req);
    const { returnUrl } = req.body || {};

    if (!trimmedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    const customers = await stripe.customers.list({
      email: trimmedEmail,
      limit: 1,
    });

    if (!customers.data.length) {
      console.log("No Stripe customer for email:", trimmedEmail);
      return res.status(404).json({ error: "no_stripe_customer_for_email" });
    }

    const customer = customers.data[0];

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl || `${SITE_URL}/account.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("billing portal error:", err);
    res.status(500).json({ error: "billing_portal_failed", detail: err.message });
  }
});

// -------------------------------------------------
// 🔎 Account plan lookup (Stripe is source of truth)
// -------------------------------------------------
app.get("/api/account/plan", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const customers = await stripe.customers.list({ email, limit: 1 });

    if (!customers.data.length) {
      return res.json({ plan: "FREE", maxFavs: 3, reason: "no_stripe_customer" });
    }

    const customer = customers.data[0];

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
      limit: 1,
      expand: ["data.items.data.price"],
    });

    if (!subs.data.length) {
      return res.json({ plan: "FREE", maxFavs: 3, reason: "no_active_subscription" });
    }

    const sub = subs.data[0];
    const firstItem = sub.items.data[0];
    const priceId = firstItem?.price?.id;

    if (!priceId || !PRICE_TO_PLAN[priceId]) {
      return res.json({ plan: "BASIC", maxFavs: 3, reason: "unknown_price", priceId });
    }

    const { plan, maxFavs } = PRICE_TO_PLAN[priceId];

    return res.json({ plan, maxFavs, priceId });
  } catch (err) {
    console.error("account/plan error:", err);
    res.status(500).json({ error: "plan_lookup_failed", detail: err.message });
  }
});

// -------------------------------------------------
// ✅ Save account preferences
// -------------------------------------------------
app.post("/api/account/preferences", async (req, res) => {
  try {
    const {
      email,
      homeState,
      favourites = [],
      days = [],
      earliest,
      latest,
      holes,
      partySize,
      alertFrequency,
      homeCourse,
      homeCourseId,
      homeCourseState,
    } = req.body || {};

    const trimmedEmail = (email || "").toString().trim().toLowerCase();
    if (!trimmedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    const preferredDays = Array.isArray(days) && days.length ? days : null;

    await db.query(
      `
      INSERT INTO user_preferences (
        email, home_state, favourites, preferred_days,
        preferred_earliest, preferred_latest, preferred_holes, preferred_party_size,
        alert_frequency, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      ON CONFLICT (email) DO UPDATE SET
        home_state = EXCLUDED.home_state,
        favourites = EXCLUDED.favourites,
        preferred_days = EXCLUDED.preferred_days,
        preferred_earliest = EXCLUDED.preferred_earliest,
        preferred_latest = EXCLUDED.preferred_latest,
        preferred_holes = EXCLUDED.preferred_holes,
        preferred_party_size = EXCLUDED.preferred_party_size,
        alert_frequency = EXCLUDED.alert_frequency,
        updated_at = now()
      `,
      [
        trimmedEmail,
        homeState || null,
        JSON.stringify(favourites || []),
        preferredDays,
        earliest || null,
        latest || null,
        holes ? Number(holes) : null,
        partySize ? Number(partySize) : null,
        alertFrequency || null,
      ]
    );

    const finalHomeCourseState = homeCourseState || homeState || null;

    await db.query(
      `
      UPDATE users
      SET
        home_course = COALESCE(NULLIF($2, ''), home_course),
        home_course_id = COALESCE(NULLIF($3, ''), home_course_id),
        home_course_state = COALESCE(NULLIF($4, ''), home_course_state)
      WHERE email = $1
      `,
      [trimmedEmail, homeCourse || "", homeCourseId || "", finalHomeCourseState || ""]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("account/preferences error:", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// Load course data
// -------------------------------------------------
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const courses = rawCourses.map((c) => {
  const latNum = Number(c.lat);
  const lngNum = Number(c.lng);

  return {
    ...c,
    lat: Number.isFinite(latNum) ? latNum : PERTH_LAT,
    lng: Number.isFinite(lngNum) ? lngNum : PERTH_LNG,
  };
});

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

console.log(`Loaded ${courses.length} courses.`);
console.log(`Loaded ${Object.keys(feeGroups).length} fee group entries.`);

// -------------------------------------------------
// ✅ NEW: Load scorecards (published pars + distances) and attach to /api/courses
// -------------------------------------------------
function _normCourseName(s) {
  let x = String(s || "").trim().toLowerCase();
  x = x.replace(/\s*\([^)]*\)\s*$/, "");
  x = x.replace(/\s*\b(18|9)\s*holes?\b\s*$/, "");
  x = x.replace(/\s{2,}/g, " ").trim();
  return x;
}
function _courseKey(course, state) {
  return `${_normCourseName(course)}|${String(state || "").trim().toUpperCase()}`;
}
function _pickDefaultTee(distances_m) {
  if (!distances_m || typeof distances_m !== "object") return null;
  const tees = Object.keys(distances_m);
  if (!tees.length) return null;
  const preferred = ["White", "Yellow", "Blue", "Red"];
  for (const t of preferred) if (tees.includes(t)) return t;
  return tees[0];
}

let scorecardsWA = null;
{
  const { data, foundPath } = _readScorecardsForState("WA");
  if (Array.isArray(data)) {
    scorecardsWA = data;
    console.log("✅ WA scorecards loaded from:", foundPath);
  } else {
    console.log(
      "⚠️ WA scorecards not found on disk at boot (will still work if you later add the file and redeploy)."
    );
  }
}

const scorecardsAll = [].concat(Array.isArray(scorecardsWA) ? scorecardsWA : []);

const scorecardIndex = new Map();
for (const sc of scorecardsAll) {
  const courseName = sc.course || sc.name || "";
  const st = (sc.state || "").toString().toUpperCase();
  const holes = Number(sc.holes) || null;
  if (!courseName || !st || !holes) continue;

  const k = `${_courseKey(courseName, st)}|${holes}`;
  if (!scorecardIndex.has(k)) scorecardIndex.set(k, []);
  scorecardIndex.get(k).push(sc);
}

function getPublishedParsAndDistances(courseName, state, holes) {
  const st = String(state || "").trim().toUpperCase();
  const h = Number(holes);
  const k = `${_courseKey(courseName, st)}|${h}`;
  const list = scorecardIndex.get(k) || [];
  if (list.length !== 1) return { pars: null, distances: null };

  const sc = list[0];
  if (!Array.isArray(sc.pars) || sc.pars.length !== h) return { pars: null, distances: null };

  const teeDefault = _pickDefaultTee(sc.distances_m);
  const distances =
    teeDefault && sc.distances_m && Array.isArray(sc.distances_m[teeDefault])
      ? sc.distances_m[teeDefault].slice(0, h)
      : null;

  return { pars: sc.pars, distances };
}

const coursesEnriched = courses.map((c) => {
  const courseName = c.name || c.course || "";
  const st = (c.state || "").toString().toUpperCase();
  const holes = Number(c.holes) || null;

  if (!courseName || !st || !holes) return c;

  const k = `${_courseKey(courseName, st)}|${holes}`;
  const list = scorecardIndex.get(k) || [];

  if (list.length === 1 && Array.isArray(list[0].pars) && list[0].pars.length === holes) {
    const sc = list[0];

    const teeDefault = _pickDefaultTee(sc.distances_m);
    const distancesDefault =
      teeDefault && sc.distances_m && Array.isArray(sc.distances_m[teeDefault])
        ? sc.distances_m[teeDefault].slice(0, holes)
        : null;

    if (holes === 18) {
      return {
        ...c,
        pars18: sc.pars,
        distances18: distancesDefault || undefined,
        distancesByTee: sc.distances_m || undefined,
        teeDefault: teeDefault || undefined,
      };
    }
    if (holes === 9) {
      return {
        ...c,
        pars9: sc.pars,
        distances9: distancesDefault || undefined,
        distancesByTee: sc.distances_m || undefined,
        teeDefault: teeDefault || undefined,
      };
    }
    return c;
  }

  if (list.length > 1) {
    const layouts = list
      .map((x) => (x.layout || "").toString().trim())
      .filter((x) => x.length > 0);

    return {
      ...c,
      availableLayouts: Array.from(new Set(layouts)),
      hasMultipleScorecards: true,
    };
  }

  return c;
});

// -------------------------------------------------
// Health Check
// -------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// -------------------------------------------------
// Course List
// -------------------------------------------------
app.get("/api/courses", (req, res) => {
  res.json(coursesEnriched);
});

// -------------------------------------------------
// Search (state filter + state-aware cache)
// -------------------------------------------------
app.post("/api/search", async (req, res) => {
  try {
    const {
      date,
      earliest = "06:00",
      latest = "17:00",
      holes = "",
      partySize = 1,
      state = "",
    } = req.body || {};

    if (!date) return res.status(400).json({ error: "date is required" });

    const holesValue =
      holes === "" || holes === null || typeof holes === "undefined" ? "" : Number(holes);

    const stateCode = (state || "").toString().toUpperCase();

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,
      partySize: Number(partySize) || 1,
      state: stateCode || null,
    };

    console.log("Incoming /api/search", criteria);

    const searchCourses = stateCode
      ? courses.filter((c) => (c.state || "").toString().toUpperCase() === stateCode)
      : courses;

    console.log(`Searching ${searchCourses.length} courses for state=${stateCode || "ALL"}`);

    const jobs = searchCourses.map(async (c) => {
      const courseId = `${(c.state || "NA").toString().toUpperCase()}::${c.id || c.name}`;
      const provider = c.provider || "Other";

      const cached = getCachedSlots({
        courseId,
        date,
        holes: holesValue || null,
        partySize: criteria.partySize,
      });

      if (cached) {
        console.log(`⚡ cache hit → ${c.name} (${cached.length} slots)`);
        return cached;
      }

      try {
        const result = await scrapeCourse(c, criteria, feeGroups);
        const count = Array.isArray(result) ? result.length : 0;

        console.log(`✅ scraped ${c.name} → ${count} slots`);

        await saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: result || [],
        });

        return result || [];
      } catch (err) {
        console.error(`❌ scrape error for ${c.name}:`, err.message);

        await saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: [],
        });

        return [];
      }
    });

    const allResults = await Promise.all(jobs);
    const slots = allResults.flat();

    console.log(`🔎 /api/search complete → ${slots.length} total slots`);
    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// Analytics Event Ingest
// -------------------------------------------------

// -------------------------------------------------
// Analytics Summary
// -------------------------------------------------

// -------------------------------------------------
// Registered Users for Admin Dashboard
// -------------------------------------------------
// ✅ NOTE: This is handled by analyticsRoutes.js at:
// ✅ GET /api/analytics/users
// (The broken orphan block that caused "Unexpected token }" has been removed.)

// -------------------------------------------------
// Contact Form Email System
// -------------------------------------------------
app.post("/api/contact", async (req, res) => {
  const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = process.env.SMTP_PORT;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;

  console.log("[contact env] email:", CONTACT_EMAIL);
  console.log("[contact env] host:", SMTP_HOST);
  console.log("[contact env] port:", SMTP_PORT);
  console.log("[contact env] user:", SMTP_USER);
  console.log("[contact env] pass present:", !!SMTP_PASS);

  if (!CONTACT_EMAIL || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_PORT) {
    return res.status(500).json({ ok: false, error: "Email service not configured" });
  }

  const { email, question, details } = req.body;

  if (!email || !question || !details) {
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: `"TeeRadar Contact" <${SMTP_USER}>`,
      to: CONTACT_EMAIL,
      subject: `New TeeRadar Question: ${question}`,
      text: `
From: ${email}

Question:
${question}

Details:
${details}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).json({ ok: false, error: "Email failed to send" });
  }
});

// -------------------------------------------------
// 🔎 DEBUG: confirm rounds are stored in DB
// -------------------------------------------------
app.get("/api/debug/rounds-db", async (req, res) => {
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS rounds FROM rounds;`);
    const h = await db.query(`SELECT COUNT(*)::int AS holes FROM round_holes;`);

    res.json({
      ok: true,
      dbType: process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "Postgres (env vars)",
      rounds: r.rows[0].rounds,
      holes: h.rows[0].holes,
      host: process.env.PGHOST || null,
      database: process.env.PGDATABASE || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------
// ✅ NEW: Booking pages (must be BEFORE frontend fallback)
// -------------------------------------------------
app.get("/book/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "book-admin.html"));
});

app.get("/book/:slug", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "book-course.html"));
});

// ✅ Explicit admin pages (must be BEFORE frontend fallback)
app.get("/book-admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "book-admin.html"));
});

app.get("/course-admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "course-admin.html"));
});

// ✅ Optional short URLs
app.get("/book-admin", (req, res) => res.redirect("/book-admin.html"));
app.get("/course-admin", (req, res) => res.redirect("/course-admin.html"));

/* ✅✅✅ FIX (analytics page): make /analytics work (otherwise it hits "*" and loads index) ✅✅✅ */
app.get("/analytics", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "analytics.html"));
});
app.get("/analytics.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "analytics.html"));
});
/* ✅✅✅ END FIX ✅✅✅ */

// -------------------------------------------------
// Frontend fallback
// -------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// -------------------------------------------------
// Start Server
// -------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});

// 🔔 Start alerts worker
startAlertWorker();

let __alertTickRunning = false;

async function runAlertTickSafe() {
  if (__alertTickRunning) return;
  __alertTickRunning = true;
  try {
    await runAlertTickOnce();
  } catch (err) {
    console.error("❌ runAlertTickSafe error:", err?.message || err);
  } finally {
    __alertTickRunning = false;
  }
}

const ALERT_TICK_INTERVAL_MS =
  Number(process.env.ALERT_TICK_INTERVAL_MS) || 5 * 60 * 1000;

setTimeout(runAlertTickSafe, 20000);
setInterval(runAlertTickSafe, ALERT_TICK_INTERVAL_MS);