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
import { startAlertWorker } from "./alertWorker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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
        // TODO: later sync to DB if you like
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

app.use("/api/auth", authRouter);

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

// 🔔 Alerts API
app.use("/api/alerts", alertsRouter);

// ✅ NEW: fallback endpoints for the "logged-in popup" unread/viewed flow
// These are safe even if alertsRoutes.js already implements them (Express will route to the first match).
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

    // Return in the shape the frontend expects
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
    console.error("/api/alerts/mark-read error:", err);
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
      "https://teeradar.com.au/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}&paid=1";
    const cancelUrl =
      process.env.STRIPE_CANCEL_URL ||
      "https://teeradar.com.au/subscribe-cancel.html";

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
    // ✅ email can come from body OR Bearer token (account.html currently sends only returnUrl)
    const trimmedEmail = getEmailFromRequest(req);

    const { returnUrl } = req.body || {};

    if (!trimmedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    // 1) Find Stripe customer by email
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

    // 2) Create billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url:
        returnUrl ||
        "https://teeradar.com.au/account.html",
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

    // 1) Find customer by email
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

    // 2) Find active subscription for that customer
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
// ✅ Save account preferences (for favourites + scan settings)
// ✅ FIX: also persist home course into users table so /api/me returns the new value
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
      alertFrequency, // 🔹 NEW

      // ✅ NEW: home course fields (sent by account page)
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

    // ✅ NEW: persist home course to users table (source of truth for /api/me)
    // Prefer explicit homeCourseState, fall back to homeState
    const finalHomeCourseState =
      (homeCourseState || homeState || null);

    await db.query(
      `
      UPDATE users
      SET
        home_course = $2,
        home_course_id = $3,
        home_course_state = $4
      WHERE email = $1
      `,
      [
        trimmedEmail,
        homeCourse || null,
        homeCourseId || null,
        finalHomeCourseState,
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
// Health Check
// -------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// -------------------------------------------------
// Course List
// -------------------------------------------------
app.get("/api/courses", (req, res) => {
  res.json(courses);
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
    console.error("analytics summary error", err);
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

      // existing preference fields
      home_state: u.home_state || null,
      favourites: u.favourites || null,
      preferred_days: u.preferred_days || null,
      preferred_earliest: u.preferred_earliest || null,
      preferred_latest: u.preferred_latest || null,
      preferred_holes: u.preferred_holes,
      preferred_party_size: u.preferred_party_size,
      alert_frequency: u.alert_frequency || null,

      // 🔹 NEW: aliases specifically for the analytics "Alert settings" card
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
    console.error("analytics users error:", err);
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