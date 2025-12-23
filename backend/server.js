// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import Stripe from "stripe"; // ✅ Stripe
import jwt from "jsonwebtoken"; // ✅ NEW (only used to read email from Bearer token)

import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics (Postgres)
import {
  recordEvent,
  getAnalyticsSummary,
  getTopCourses,
} from "./analytics.js";

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
const PORT = process.env.PORT || 3000;

// ✅ Live site base URL (use everywhere we generate links)
const SITE_URL = "https://teeradar.com.au";

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

// ✅ NEW: small helper to get email from body/query OR Bearer token
function getEmailFromRequest(req) {
  const fromBody = (req.body && req.body.email) ? String(req.body.email) : "";
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

  // Fallback: decode without verifying (lets billing portal work even if you haven't set JWT_SECRET)
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

    // Ensure columns exist on older deployments
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

    // ✅ NEW (only adds what's needed): players + multi-player storage
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

    console.log("✅ rounds + round_holes tables ready");
  } catch (err) {
    console.error("❌ error ensuring rounds tables:", err);
  }
}
ensureRoundsTables();

app.use(cors());

// -------------------------------------------------
// Stripe Webhook – must be BEFORE express.json
// -------------------------------------------------
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
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

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("✅ Stripe checkout completed for:", session.customer_email);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        console.log("❌ Subscription cancelled:", subscription.id);
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        console.log("💰 Payment succeeded for:", invoice.customer_email);
        break;
      }
      default:
        console.log(`ℹ️ Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ✅✅✅ ONLY ADDITION (needed): expose backend scorecards JSON to frontend ✅✅✅ */
app.get("/api/scorecards/:state", (req, res) => {
  try {
    const st = String(req.params.state || "").trim().toUpperCase();
    if (!st) return res.status(400).json({ error: "state required" });

    const candidates = [
      path.join(__dirname, "data", "scorecards", `scorecards-${st.toLowerCase()}.json`),
      path.join(__dirname, "data", "scorecards", `scorecards-${st}.json`),
      path.join(__dirname, "data", "scorecards", `scorecards_${st.toLowerCase()}.json`),
      path.join(__dirname, "data", "scorecards", `scorecards_${st}.json`),
      path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${st.toLowerCase()}.json`),
      path.join(__dirname, "..", "public", "data", `scorecards-${st.toLowerCase()}.json`),
      path.join(__dirname, "..", "public", "scorecards", `scorecards-${st.toLowerCase()}.json`),
    ];

    let parsed = null;
    let foundPath = "";

    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, "utf8");
        const j = JSON.parse(raw);

        if (Array.isArray(j)) {
          parsed = j;
          foundPath = p;
          break;
        }
        if (j && Array.isArray(j.scorecards)) {
          parsed = j.scorecards;
          foundPath = p;
          break;
        }
      } catch {
        // try next candidate
      }
    }

    if (!Array.isArray(parsed)) {
      return res.status(404).json({
        error: "scorecards file not found",
        file: `scorecards-${st.toLowerCase()}.json`,
        tried: candidates.map((p) => path.basename(p)),
      });
    }

    if (foundPath) {
      console.log(`✅ scorecards loaded for ${st} from ${foundPath}`);
    }

    return res.json(parsed);
  } catch (err) {
    console.error("scorecards route error", err);
    return res.status(500).json({ error: "failed to load scorecards" });
  }
});
/* ✅✅✅ END ONLY ADDITION ✅✅✅ */

app.use("/api/auth", authRouter);

// -------------------------------------------------
// ✅ /api/me (for bookings page to read home state)
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
// ✅ GET account preferences
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
    console.error("/api/preferences GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
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

    const preferredDays =
      Array.isArray(days) && days.length ? days : null;

    await db.query(
      `
      INSERT INTO user_preferences (
        email,
        home_state,
        favourites,
        preferred_days,
        preferred_earliest,
        preferred_latest,
        preferred_holes,
        preferred_party_size,
        alert_frequency,
        updated_at
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

    const finalHomeCourseState =
      (homeCourseState || homeState || null);

    await db.query(
      `
      UPDATE users
      SET
        home_course = COALESCE(NULLIF($2, ''), home_course),
        home_course_id = COALESCE(NULLIF($3, ''), home_course_id),
        home_course_state = COALESCE(NULLIF($4, ''), home_course_state)
      WHERE email = $1
      `,
      [
        trimmedEmail,
        (homeCourse || ""),
        (homeCourseId || ""),
        (finalHomeCourseState || ""),
      ]
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

// ✅ FIX: coerce lat/lng to numbers (courses.json often stores them as strings)
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
// ✅ Load scorecards (robust) and attach to /api/courses
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
function _safeReadJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function _pickDefaultTee(distances_m) {
  if (!distances_m || typeof distances_m !== "object") return null;
  const tees = Object.keys(distances_m);
  if (!tees.length) return null;
  const preferred = ["White", "Yellow", "Blue", "Red"];
  for (const t of preferred) if (tees.includes(t)) return t;
  return tees[0];
}

// ✅ NEW: load scorecards from multiple locations + accept multiple schemas
function _loadScorecardsForState(stateCode) {
  const st = String(stateCode || "").trim().toUpperCase();
  if (!st) return [];

  const candidates = [
    // backend
    path.join(__dirname, "data", "scorecards", `scorecards-${st.toLowerCase()}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards-${st}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${st.toLowerCase()}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${st}.json`),

    // public
    path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${st.toLowerCase()}.json`),
    path.join(__dirname, "..", "public", "data", `scorecards-${st.toLowerCase()}.json`),
    path.join(__dirname, "..", "public", "scorecards", `scorecards-${st.toLowerCase()}.json`),
  ];

  let raw = null;
  let found = "";
  for (const p of candidates) {
    const j = _safeReadJsonIfExists(p);
    if (!j) continue;
    raw = j;
    found = p;
    break;
  }

  if (!raw) return [];

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && Array.isArray(raw.scorecards)) arr = raw.scorecards;
  else arr = [];

  if (found) console.log(`✅ scorecards candidate for ${st}: ${found}`);

  // normalize entries so enrichment works even if state/holes fields are missing
  return arr
    .map((sc) => {
      const courseName = sc.course || sc.name || sc.title || "";
      const pars = Array.isArray(sc.pars) ? sc.pars : (Array.isArray(sc.par) ? sc.par : null);

      // infer holes if missing
      const holes =
        Number(sc.holes) ||
        (Array.isArray(pars) ? pars.length : null) ||
        null;

      // normalize distances structure names
      const distances_m = sc.distances_m || sc.distancesByTee || sc.distances || null;

      return {
        ...sc,
        course: courseName,
        state: (sc.state ? String(sc.state).toUpperCase() : st),
        holes: holes,
        pars: pars,
        distances_m: distances_m,
      };
    })
    .filter((x) => x.course && x.state && x.holes);
}

// Load scorecards (you can add more states any time)
const scorecardsAll = []
  .concat(_loadScorecardsForState("WA"))
  .concat(_loadScorecardsForState("NT"))
  .concat(_loadScorecardsForState("QLD"))
  .concat(_loadScorecardsForState("NSW"))
  .concat(_loadScorecardsForState("VIC"))
  .concat(_loadScorecardsForState("SA"))
  .concat(_loadScorecardsForState("TAS"))
  .concat(_loadScorecardsForState("ACT"));

// Build index: course|state|holes -> [scorecardEntries]
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

// Create enriched version of the courses list
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
      holes === "" || holes === null || typeof holes === "undefined"
        ? ""
        : Number(holes);

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
      ? courses.filter(
          (c) => (c.state || "").toString().toUpperCase() === stateCode
        )
      : courses;

    console.log(
      `Searching ${searchCourses.length} courses for state=${stateCode || "ALL"}`
    );

    const jobs = searchCourses.map(async (c) => {
      const courseId = `${(c.state || "NA").toString().toUpperCase()}::${
        c.id || c.name
      }`;

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
// ✅ My Rounds (logged-in only)  — FIXED & COMPLETED
// -------------------------------------------------

// List my rounds (latest first)
app.get("/api/rounds", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }

    const { rows } = await db.query(
      `
      SELECT id, course, layout, state, holes, par_mode, created_at, players_count
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

// Create a round + create blank holes (pars optional)
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
      players_count = 1,
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
    const pc = Math.max(1, Math.min(4, Number(players_count) || 1));

    const parsedPars = Array.isArray(pars)
      ? pars.map((p) => (p === null || typeof p === "undefined" || p === "" ? null : Number(p)))
      : null;

    if (parsedPars && parsedPars.length !== holesCount) {
      return res.status(400).json({
        ok: false,
        error: `pars must have length ${holesCount} (or be null)`,
      });
    }

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode, created_at, players_count)
      VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
      RETURNING id, course, layout, state, holes, par_mode, created_at, players_count;
      `,
      [userId, courseName, layout, state, holesCount, parMode, pc]
    );

    const round = roundInsert.rows[0];

    const values = [];
    const params = [];
    let idx = 1;

    for (let i = 1; i <= holesCount; i++) {
      const parVal = parsedPars ? parsedPars[i - 1] : null;
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(round.id, i, parVal, null, null, "{}" , "{}");
    }

    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, strokes, putts, strokes_by_player, putts_by_player)
      VALUES ${values.join(", ")}
      `,
      params
    );

    return res.json({ ok: true, round });
  } catch (err) {
    console.error("/api/rounds POST error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

// Get a round (and its holes) – must be my round
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
      SELECT id, user_id, course, layout, state, holes, par_mode, created_at, players_count
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
      SELECT hole_number, par, strokes, putts, strokes_by_player, putts_by_player
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

// ✅ NEW: Save entire scorecard (my-rounds.html uses PUT /api/rounds/:id)
app.put("/api/rounds/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const roundId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid round id" });
    }

    const own = await db.query(
      `SELECT id FROM rounds WHERE id = $1 AND user_id = $2 LIMIT 1;`,
      [roundId, userId]
    );
    if (!own.rows.length) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const { holes = [] } = req.body || {};
    if (!Array.isArray(holes) || !holes.length) {
      return res.json({ ok: true, updated: 0 });
    }

    let updated = 0;

    for (const h of holes) {
      const holeNumber = Number(h?.hole_number);
      if (!Number.isInteger(holeNumber) || holeNumber <= 0) continue;

      const parVal = (h.par === "" || h.par === null || typeof h.par === "undefined") ? null : Number(h.par);
      const strokesVal = (h.strokes === "" || h.strokes === null || typeof h.strokes === "undefined") ? null : Number(h.strokes);
      const puttsVal = (h.putts === "" || h.putts === null || typeof h.putts === "undefined") ? null : Number(h.putts);

      const strokesBy = (h.strokes_by_player && typeof h.strokes_by_player === "object") ? h.strokes_by_player : {};
      const puttsBy = (h.putts_by_player && typeof h.putts_by_player === "object") ? h.putts_by_player : {};

      const r = await db.query(
        `
        UPDATE round_holes
        SET
          par = $3,
          strokes = $4,
          putts = $5,
          strokes_by_player = $6::jsonb,
          putts_by_player   = $7::jsonb
        WHERE round_id = $1 AND hole_number = $2
        `,
        [
          roundId,
          holeNumber,
          Number.isFinite(parVal) ? parVal : null,
          Number.isFinite(strokesVal) ? strokesVal : null,
          Number.isFinite(puttsVal) ? puttsVal : null,
          JSON.stringify(strokesBy || {}),
          JSON.stringify(puttsBy || {}),
        ]
      );

      updated += (r.rowCount || 0);
    }

    return res.json({ ok: true, updated });
  } catch (err) {
    console.error("/api/rounds/:id PUT error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

// ✅ NEW: Delete round (my-rounds.html uses DELETE /api/rounds/:id)
app.delete("/api/rounds/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const roundId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid round id" });
    }

    const result = await db.query(
      `DELETE FROM rounds WHERE id = $1 AND user_id = $2`,
      [roundId, userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, error: "Round not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("/api/rounds/:id DELETE error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Update a single hole (kept)
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

    const { strokes, putts, par } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === ""
        ? null
        : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === ""
        ? null
        : Number(putts);

    const parVal =
      par === null || typeof par === "undefined" || par === ""
        ? undefined
        : Number(par);

    if (strokesVal !== null && !Number.isFinite(strokesVal)) {
      return res.status(400).json({ ok: false, error: "strokes must be a number or null" });
    }
    if (puttsVal !== null && !Number.isFinite(puttsVal)) {
      return res.status(400).json({ ok: false, error: "putts must be a number or null" });
    }
    if (typeof parVal !== "undefined" && !Number.isFinite(parVal)) {
      return res.status(400).json({ ok: false, error: "par must be a number or omitted" });
    }

    const result = await db.query(
      `
      UPDATE round_holes
      SET
        strokes = $3,
        putts = $4,
        par = COALESCE($5, par)
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, strokes, putts;
      `,
      [roundId, holeNumber, strokesVal, puttsVal, typeof parVal === "undefined" ? null : parVal]
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

// ✅ IMPORTANT: mount roundsRouter AFTER the inline handlers so it cannot hijack /api/rounds
app.use("/api/rounds", roundsRouter);

// 🔔 Alerts API
app.use("/api/alerts", alertsRouter);

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
    const cancelUrl =
      process.env.STRIPE_CANCEL_URL ||
      `${SITE_URL}/subscribe-cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: customerEmail,
      allow_promotion_codes: true,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res
      .status(500)
      .json({ error: "Stripe checkout failed", detail: err.message });
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
      return res
        .status(404)
        .json({ error: "no_stripe_customer_for_email" });
    }

    const customer = customers.data[0];

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl || `${SITE_URL}/account.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("billing portal error", err);
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

    const customers = await stripe.customers.list({
      email,
      limit: 1,
    });

    if (!customers.data.length) {
      return res.json({
        plan: "FREE",
        maxFavs: 3,
        reason: "no_stripe_customer",
      });
    }

    const customer = customers.data[0];

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
      limit: 1,
      expand: ["data.items.data.price"],
    });

    if (!subs.data.length) {
      return res.json({
        plan: "FREE",
        maxFavs: 3,
        reason: "no_active_subscription",
      });
    }

    const sub = subs.data[0];
    const firstItem = sub.items.data[0];
    const priceId = firstItem?.price?.id;

    if (!priceId || !PRICE_TO_PLAN[priceId]) {
      return res.json({
        plan: "BASIC",
        maxFavs: 3,
        reason: "unknown_price",
        priceId,
      });
    }

    const { plan, maxFavs } = PRICE_TO_PLAN[priceId];

    return res.json({
      plan,
      maxFavs,
      priceId,
    });
  } catch (err) {
    console.error("account/plan error:", err);
    res.status(500).json({ error: "plan_lookup_failed", detail: err.message });
  }
});

// -------------------------------------------------
// Analytics Event Ingest
// -------------------------------------------------
app.post("/api/analytics/event", async (req, res) => {
  try {
    const { type, payload = {}, at } = req.body || {};

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const userId = payload.userId || ip || null;

    const courseName =
      payload.course ||
      payload.courseName ||
      payload.course_name ||
      payload.courseTitle ||
      null;

    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName,
    });

    await recordEvent({ type, userId, courseName, at });
    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// -------------------------------------------------
// Analytics Summary
// -------------------------------------------------
function buildFlatSummary(summary, topCourses) {
  return {
    homePageViews: summary.homeViews ?? 0,
    courseBookingClicks: summary.bookingClicks ?? 0,
    searches: summary.searches ?? 0,
    newUsers: summary.newUsers7d ?? 0,
    homeViews: summary.homeViews ?? 0,
    bookingClicks: summary.bookingClicks ?? 0,
    usersAllTime: summary.usersAllTime ?? 0,
    usersToday: summary.usersToday ?? 0,
    usersWeek: summary.usersWeek ?? 0,
    topCourses: topCourses || [],
  };
}

app.get("/api/analytics", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    const topCourses = await getTopCourses(10);
    res.json(buildFlatSummary(summary, topCourses));
  } catch (err) {
    console.error("analytics summary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------
// Registered Users for Admin Dashboard
// -------------------------------------------------
app.get("/api/analytics/users", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id,
        u.email,
        u.home_course,
        u.created_at,
        u.last_login,
        p.home_state,
        p.favourites,
        p.preferred_days,
        p.preferred_earliest,
        p.preferred_latest,
        p.preferred_holes,
        p.preferred_party_size,
        p.alert_frequency
      FROM users u
      LEFT JOIN user_preferences p
        ON p.email = u.email
      ORDER BY u.id DESC
      LIMIT 200;
    `);

    const users = rows.map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_seen_at: u.last_login || u.created_at || null,
      home_course: u.home_course || null,
      home_state: u.home_state || null,
      favourites: u.favourites || null,
      preferred_days: u.preferred_days || null,
      preferred_earliest: u.preferred_earliest || null,
      preferred_latest: u.preferred_latest || null,
      preferred_holes: u.preferred_holes,
      preferred_party_size: u.preferred_party_size,
      alert_frequency: u.alert_frequency || null,
      alert_days: u.preferred_days || null,
      alert_time_range:
        u.preferred_earliest && u.preferred_latest
          ? `${u.preferred_earliest}–${u.preferred_latest}`
          : null,
      alert_holes: u.preferred_holes,
      alert_players: u.preferred_party_size,
    }));

    res.json({ users });
  } catch (err) {
    console.error("analytics users error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// -------------------------------------------------
// Delete user
// -------------------------------------------------
app.delete("/api/analytics/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid user id" });
    }

    const result = await db.query(`DELETE FROM users WHERE id = $1`, [id]);

    console.log("🗑 deleted user id =", id, "rows:", result.rowCount);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "user not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("delete user error", err);
    res.status(500).json({ error: "internal error" });
  }
});

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
    return res
      .status(500)
      .json({ ok: false, error: "Email service not configured" });
  }

  const { email, question, details } = req.body;

  if (!email || !question || !details) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing required fields" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: false,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
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

// ✅ ADDED: run alert ticks frequently so per-user frequency (6h/12h/etc) actually works
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