// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import Stripe from "stripe"; // ✅ Stripe
import jwt from "jsonwebtoken"; // ✅ NEW (only used to read email from Bearer token)
import { ensureBookingTemplateSchema } from "./bookingTemplateMigrate.js";
import { ensureRoundsTables, ensureScorecardTemplatesTables } from "./roundsMigrate.js";
import { ensureCoursePaymentModeSchema } from "./paymentMigrate.js";
import { ensureSubscriberStatusSchema } from "./subscriberMigrate.js";
// ✅ NEW: cookies (needed for booking admin auth cookie)
import cookieParser from "cookie-parser";

// ✅ NEW: booking routes
import bookingRoutes from "./bookingRoutes.js";

// ✅✅✅ ADD (needed): booking views (view booked tee times / bookings) ✅✅✅
import bookingViewsRouter from "./bookingViews.js";
// ✅✅✅ END ADD ✅✅✅
import bookingAnalyticsRouter from "./bookingAnalyticsRoutes.js";
import { ensureBookingAddonsSchema } from "./bookingMigrate.js";
import { ensureScorecardCoursesSchema } from "./scorecardCourseMigrate.js"; // ✅ ADD
import analyticsRouter from "./analyticsRoutes.js";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";
import groupVotesRouter from "./groupVotesRoutes.js";
import { ensureGroupVotesTables } from "./groupVotesMigrate.js";
import friendsRouter from "./friendsRoutes.js";

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
// 🔔 Push notifications
import pushRouter from "./pushRoutes.js";
import { ensurePushSubscriptionsTable } from "./pushMigrate.js";

// ✅ NEW: Rounds router
import roundsRouter from "./roundsRoutes.js";
// ✅ NEW: Scorecards router (public)
import scorecardsRouter from "./scorecardsRouter.js";

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
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "")
  .trim()
  .replace(/^["']|["']$/g, "")     // remove surrounding quotes if Render stored them
  .replace(/\s+/g, "");           // remove ALL whitespace/newlines inside the key

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

console.log("💳 stripe configured:", {
  hasKey: !!STRIPE_SECRET_KEY,
  keyPrefix: STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 7) : null,
});

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
function normalizePlan(plan) {
  const p = String(plan || "").trim().toUpperCase();
  if (p === "BASIC") return "BASIC";
  if (p === "PRO") return "PRO";
  return "FREE";
}

function derivePlanFromPriceId(priceId) {
  const mapped = priceId ? PRICE_TO_PLAN[priceId] : null;
  return normalizePlan(mapped?.plan || "FREE");
}

function computeEntitlementActive(status, currentPeriodEnd) {
  const s = String(status || "").trim().toLowerCase();
  if (s !== "active" && s !== "trialing") return false;
  if (!currentPeriodEnd) return false;

  const endMs = new Date(currentPeriodEnd).getTime();
  if (!Number.isFinite(endMs)) return false;

  return endMs > Date.now();
}

async function upsertSubscriberStatusFromStripe({ email, customerId, subscription }) {
  if (!email || !subscription) return;

  const normalizedEmail = String(email).trim().toLowerCase();
  const stripeCustomerId = String(customerId || subscription.customer || "").trim();
  const subscriptionId = String(subscription.id || "").trim();
  const status = String(subscription.status || "inactive").trim().toLowerCase();

  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const canceledAt = subscription.canceled_at
    ? new Date(subscription.canceled_at * 1000).toISOString()
    : null;

  const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;

  const priceId = subscription?.items?.data?.[0]?.price?.id || null;
  const paidPlan = derivePlanFromPriceId(priceId);

  const entitlementActive = computeEntitlementActive(status, currentPeriodEnd);

  // ✅ Option B: effective plan becomes FREE once entitlement ends
  const effectivePlan = entitlementActive ? paidPlan : "FREE";

  await db.query(
    `
    INSERT INTO subscriber_status (
      email,
      stripe_customer_id,
      subscription_id,
      status,
      plan,
      cancel_at_period_end,
      canceled_at,
      current_period_end,
      entitlement_active,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (email)
    DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      subscription_id = EXCLUDED.subscription_id,
      status = EXCLUDED.status,
      plan = EXCLUDED.plan,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      canceled_at = EXCLUDED.canceled_at,
      current_period_end = EXCLUDED.current_period_end,
      entitlement_active = EXCLUDED.entitlement_active,
      updated_at = now()
    `,
    [
      normalizedEmail,
      stripeCustomerId || null,
      subscriptionId || null,
      status,
      effectivePlan,
      cancelAtPeriodEnd,
      canceledAt,
      currentPeriodEnd,
      entitlementActive,
    ]
  );

  // Keep legacy users.plan aligned for older parts of the app
  await db.query(
    `
    UPDATE users
    SET plan = $2
    WHERE LOWER(email) = LOWER($1)
    `,
    [normalizedEmail, effectivePlan]
  );
}

async function getSubscriberStatusByEmail(email) {
  const result = await db.query(
    `
    SELECT
      email,
      stripe_customer_id,
      subscription_id,
      status,
      plan,
      cancel_at_period_end,
      canceled_at,
      current_period_end,
      entitlement_active,
      updated_at
    FROM subscriber_status
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
    `,
    [email]
  );

  return result.rows?.[0] || null;
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
async function syncSubscriberStatusFromStripeByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || !stripe) return null;

  const customers = await stripe.customers.list({
    email: normalizedEmail,
    limit: 1,
  });

  const customer = customers?.data?.[0];
  if (!customer?.id) {
    return null;
  }

  // Look for a current subscription that should grant access
  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 20,
    expand: ["data.items.data.price"],
  });

  if (!subs?.data?.length) {
    await db.query(
      `
      INSERT INTO subscriber_status (
        email,
        stripe_customer_id,
        subscription_id,
        status,
        plan,
        cancel_at_period_end,
        canceled_at,
        current_period_end,
        entitlement_active,
        updated_at
      )
      VALUES ($1,$2,NULL,'inactive','FREE',false,NULL,NULL,false,now())
      ON CONFLICT (email)
      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        subscription_id = NULL,
        status = 'inactive',
        plan = 'FREE',
        cancel_at_period_end = false,
        canceled_at = NULL,
        current_period_end = NULL,
        entitlement_active = false,
        updated_at = now()
      `,
      [normalizedEmail, String(customer.id)]
    );

    await db.query(
      `UPDATE users SET plan = 'FREE' WHERE LOWER(email) = LOWER($1)`,
      [normalizedEmail]
    );

    return null;
  }

  // Prefer entitled subscription first: active/trialing and still in period
  const ordered = [...subs.data].sort((a, b) => {
    const aEntitled = computeEntitlementActive(
      a?.status,
      a?.current_period_end ? new Date(a.current_period_end * 1000).toISOString() : null
    ) ? 1 : 0;
    const bEntitled = computeEntitlementActive(
      b?.status,
      b?.current_period_end ? new Date(b.current_period_end * 1000).toISOString() : null
    ) ? 1 : 0;

    if (bEntitled !== aEntitled) return bEntitled - aEntitled;

    const aEnd = a?.current_period_end || 0;
    const bEnd = b?.current_period_end || 0;
    return bEnd - aEnd;
  });

  const best = ordered[0];
  if (!best) return null;

  await upsertSubscriberStatusFromStripe({
    email: normalizedEmail,
    customerId: String(customer.id),
    subscription: best,
  });

  return best;
}

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

// ✅ NEW: ensure users display name column exists
async function ensureUsersDisplayNameColumn() {
  try {
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS display_name TEXT;
    `);

    console.log("✅ users display_name column ready");
  } catch (err) {
    console.error("❌ error ensuring users display_name column:", err);
  }
}

ensureUsersDisplayNameColumn();

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
ensurePushSubscriptionsTable();
ensureRoundsTables();
ensureScorecardTemplatesTables();
ensureSubscriberStatusSchema(); // ✅ ADD: creates subscriber_status table in code

async function ensureUserFriendsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_friends (
        id BIGSERIAL PRIMARY KEY,
        requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        accepted_at TIMESTAMPTZ,
        CHECK (status IN ('pending', 'accepted', 'blocked')),
        CHECK (requester_user_id <> addressee_user_id),
        UNIQUE (requester_user_id, addressee_user_id)
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_requester
      ON user_friends (requester_user_id);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_addressee
      ON user_friends (addressee_user_id);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_status
      ON user_friends (status);
    `);

    console.log("✅ user_friends table ready");
  } catch (err) {
    console.error("❌ error ensuring user_friends table:", err);
  }
}

ensureUserFriendsTable();

/* ✅✅✅ ONLY ADDITION (needed): ensure booking tables exist (so admin can create courses + generate times) ✅✅✅ */
async function ensureBookingTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS booking_courses (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        notes TEXT,

        -- ✅ payment config
        payment_mode TEXT NOT NULL DEFAULT 'PAY_AT_COURSE',
        stripe_account_id TEXT,

        -- ✅ per-course platform fee override (basis points)
        -- NULL => fallback to env (PLATFORM_FEE_BPS)
        platform_fee_bps INTEGER,

        -- ✅ optional flag to indicate they offer subscriber discount (for your UI / reporting)
        subscriber_discount_enabled BOOLEAN NOT NULL DEFAULT false,

        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // If you already run this, keep it
    await ensureCoursePaymentModeSchema();

    // ✅ Safe adds for existing DBs
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
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'PROSHOP';
    `);

    await db.query(`
      UPDATE booking_course_users
      SET role = 'PROSHOP'
      WHERE role IS NULL OR TRIM(role) = '';
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS booking_times (
        id BIGSERIAL PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES booking_courses(id) ON DELETE CASCADE,
        play_date DATE NOT NULL,
        tee_time TEXT NOT NULL,
        holes INTEGER NOT NULL,

        max_players INTEGER NOT NULL DEFAULT 4,
        booked_players INTEGER NOT NULL DEFAULT 0,
        price_per_player_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',

        layout_key TEXT NOT NULL DEFAULT '',
        front_nine_key TEXT NOT NULL DEFAULT '',
        back_nine_key  TEXT NOT NULL DEFAULT '',

        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),

        UNIQUE(course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key)
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
      ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;
    `);

    await db.query(`
      ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false;
    `);

    await db.query(`
      ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
    `);

    await db.query(`
      ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
    `);

    await db.query(`
      ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
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

// ✅ NEW: auto-migrate existing Postgres booking_times so multiple routings can coexist
async function ensureBookingTimesRoutingSchema() {
  const LOCK_KEY = 987654321; // any constant int is fine
  try {
    const lockRes = await db.query("SELECT pg_try_advisory_lock($1) AS locked;", [LOCK_KEY]);
    if (!lockRes.rows?.[0]?.locked) {
      console.log("ℹ️ booking_times routing migration: another instance is running it");
      return;
    }

    console.log("🔧 booking_times routing migration: starting");

    // 1) Ensure routing + booked_players columns exist (✅ correct names)
    await db.query(`
      ALTER TABLE booking_times
        ADD COLUMN IF NOT EXISTS booked_players integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS layout_key text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS front_nine_key text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS back_nine_key  text NOT NULL DEFAULT '';
    `);

    // 2) Backfill any nulls (safety for older rows)
    await db.query(`UPDATE booking_times SET booked_players = 0 WHERE booked_players IS NULL;`);
    await db.query(`UPDATE booking_times SET layout_key = '' WHERE layout_key IS NULL;`);
    await db.query(`UPDATE booking_times SET front_nine_key = '' WHERE front_nine_key IS NULL;`);
    await db.query(`UPDATE booking_times SET back_nine_key  = '' WHERE back_nine_key  IS NULL;`);

    // 2.5) If you previously used front9_key/back9_key, copy values across (safe + dynamic)
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='booking_times' AND column_name='front9_key'
        ) THEN
          EXECUTE '
            UPDATE booking_times
            SET front_nine_key = COALESCE(NULLIF(front_nine_key, ''''), COALESCE(front9_key, ''''))
            WHERE COALESCE(front_nine_key, '''') = '''';
          ';
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='booking_times' AND column_name='back9_key'
        ) THEN
          EXECUTE '
            UPDATE booking_times
            SET back_nine_key = COALESCE(NULLIF(back_nine_key, ''''), COALESCE(back9_key, ''''))
            WHERE COALESCE(back_nine_key, '''') = '''';
          ';
        END IF;
      END
      $$;
    `);

    // 3) Drop the OLD unique constraint (course_id, play_date, tee_time, holes) if it exists
    const oldUq = await db.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'u'
        AND t.relname = 'booking_times'
        AND (
          SELECT array_agg(a.attname::text ORDER BY a.attname::text)
          FROM unnest(c.conkey) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ) = ARRAY['course_id','holes','play_date','tee_time']::text[];
    `);

    for (const r of oldUq.rows || []) {
      console.log("🧹 dropping old booking_times unique constraint:", r.conname);
      await db.query(`ALTER TABLE booking_times DROP CONSTRAINT IF EXISTS "${r.conname}";`);
    }

    // 3.5) DEDUPE existing rows so the new unique index can be created
    await db.query(`
      WITH ranked AS (
        SELECT
          ctid,
          ROW_NUMBER() OVER (
            PARTITION BY course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
          ) AS rn
        FROM booking_times
      )
      DELETE FROM booking_times bt
      USING ranked r
      WHERE bt.ctid = r.ctid
        AND r.rn > 1;
    `);

    // 4) Create the NEW unique index including routing keys (✅ correct names)
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS booking_times_uq_routing
      ON booking_times (course_id, play_date, tee_time, holes, layout_key, front_nine_key, back_nine_key);
    `);

    console.log("✅ booking_times routing migration: done");
  } catch (e) {
    console.error("❌ booking_times routing migration failed:", e);
  } finally {
    try { await db.query("SELECT pg_advisory_unlock($1);", [LOCK_KEY]); } catch {}
  }
}
ensureBookingTimesRoutingSchema();

ensureScorecardCoursesSchema(db)
  .then(() => console.log("✅ scorecard course schema ready"))
  .catch((err) => console.error("❌ error ensuring scorecard course schema:", err));
ensureBookingAddonsSchema(db)
  .then(() => console.log("✅ booking add-ons schema ready"))
  .catch((err) => console.error("❌ error ensuring booking add-ons schema:", err));

ensureBookingTemplateSchema(db)
  .then(() => console.log("✅ booking template schema ready"))
  .catch((err) => console.error("❌ error ensuring booking template schema:", err));
  
  ensureGroupVotesTables(db)
  .then(() => console.log("✅ group votes schema ready"))
  .catch((err) => console.error("❌ error ensuring group votes schema:", err));

/* ✅✅✅ FIX (needed): CORS + preflight, and do NOT duplicate SITE_URL ✅✅✅ */
const EXTRA_CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  SITE_URL,
  "https://teeradar.com.au",
  "https://www.teeradar.com.au",
  "https://teeradar-fullstack-5.onrender.com",

  // local dev
  "http://localhost",
  "https://localhost",
  "http://localhost:3000",
  "https://localhost:3000",
  "http://localhost:5173",
  "https://localhost:5173",

  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://127.0.0.1:3000",
  "https://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "https://127.0.0.1:5173",

  // Capacitor mobile app
  "capacitor://localhost",
  "ionic://localhost",

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
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",

    // booking admin
    "X-Booking-Admin-Secret",
    "x-booking-admin-secret",

    // course admin / booking system
    "X-Course-Admin-Key",
    "x-course-admin-key",
    "X-Course-Slug",
    "x-course-slug",
    "X-Session-Id",
    "x-session-id",
  ],

  // ✅ THIS IS STEP 2
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// ✅ IMPORTANT: preflight must be OK (some browsers will fail login without this)
app.options(/.*/, cors(corsOptions));
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
          // ✅ PAY_ON_BOOKING tee-time payments (non-subscription)
// We set booking_id + reference in session.metadata from bookingRoutes
const bookingIdRaw = session?.metadata?.booking_id;
const bookingId = bookingIdRaw ? Number(bookingIdRaw) : 0;

if (bookingId && session?.payment_status === "paid") {
  await db.query(
    `
    UPDATE booking_bookings
    SET
      status = 'CONFIRMED',
      paid = true,
      updated_at = now()
    WHERE id = $1
    `,
    [bookingId]
  );

  console.log("✅ Tee-time booking paid + confirmed:", bookingId);
  break;
}

          const email = (session.customer_details?.email || session.customer_email || "")
            .toString()
            .trim()
            .toLowerCase();

          const subId = session.subscription;

                    if (email && subId) {
            const sub = await stripe.subscriptions.retrieve(subId, {
              expand: ["items.data.price"],
            });

            try {
              await upsertSubscriberStatusFromStripe({
                email,
                customerId: String(sub?.customer || session.customer || "").trim(),
                subscription: sub,
              });

              const priceId = sub?.items?.data?.[0]?.price?.id || null;
              const effectivePlan = derivePlanFromPriceId(priceId);

              console.log("✅ Updated subscriber status from checkout:", {
                email,
                subscriptionId: sub?.id || null,
                priceId,
                effectivePlan,
                status: sub?.status || null,
                cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
                currentPeriodEnd: sub?.current_period_end || null,
              });
            } catch (e) {
              console.warn(
                "⚠️ checkout.session.completed subscriber upsert failed:",
                e?.message || e
              );
            }
          } else {
            console.log("ℹ️ checkout.session.completed missing email/subscription", {
              email: !!email,
              subId: !!subId,
            });
          }
          break;
        }

                case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const customerId = sub.customer;

          let email = "";

          try {
            const cust = await stripe.customers.retrieve(customerId);
            email = (cust?.email || "").toString().trim().toLowerCase();
          } catch (err) {
            console.warn("⚠️ Failed retrieving Stripe customer for webhook:", err?.message || err);
          }

          if (email) {
            await upsertSubscriberStatusFromStripe({
              email,
              customerId: String(customerId || "").trim(),
              subscription: sub,
            });

            const priceId = sub?.items?.data?.[0]?.price?.id || null;

            console.log("✅ Updated subscriber status from subscription event:", {
              type: event.type,
              email,
              subscriptionId: sub?.id || null,
              priceId,
              status: sub?.status || null,
              cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
              currentPeriodEnd: sub?.current_period_end || null,
            });
          } else {
            console.log("ℹ️ subscription webhook had no customer email", {
              type: event.type,
              customerId: customerId || null,
              subscriptionId: sub?.id || null,
            });
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
// ✅ IMPORTANT: Stripe webhooks need RAW body for signature verification.
// So we apply express.json() to everything EXCEPT webhook routes.
app.use((req, res, next) => {
  const url = req.originalUrl || "";

  // ✅ skip JSON parsing for Stripe webhook endpoints
  if (url === "/api/webhook" || url === "/api/book/stripe-webhook") {
    return next();
  }

  // everything else can be JSON parsed normally
  return express.json({ type: ["application/json", "text/plain"] })(req, res, next);
});

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
// ✅ TEMP FIX: ensure inline <script> in public HTML files can run (book-course/admin use inline JS)
app.use((req, res, next) => {
  // If something upstream/downstream sets CSP, try to remove it first
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("content-security-policy");

  // Allow inline scripts + inline styles for now (you can tighten later)
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' https: data: blob:; " +
      "script-src 'self' 'unsafe-inline' https:; " +
      "style-src 'self' 'unsafe-inline' https:; " +
      "img-src 'self' https: data:; " +
      "connect-src 'self' https: http://localhost https://localhost http://127.0.0.1 https://127.0.0.1 capacitor://localhost ionic://localhost; " +
      "font-src 'self' https: data:;"
  );
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRouter);
// ✅✅✅ ADD (needed): mount booking views router (admin/course-admin views) ✅✅✅

app.use((req, res, next) => {
  req.isSuperAdmin = (email) => isSuperAdmin(email);
  req.isBookingAdmin = () => _isBookingAdminReq(req);
  req.bookingAdmin = _isBookingAdminReq(req);
  next();
});
// ✅ Rounds API
app.use("/api/rounds", roundsRouter);
// ✅ Scorecards API (PUBLIC – no auth)
app.use("/api/scorecards", scorecardsRouter);
// ✅ Friends API
app.use("/api/friends", requireAuth, friendsRouter);
// ✅ NEW: booking API router
app.use("/api/book", (req, res, next) => {
  // Try to get slug from header OR query OR /api/book/:slug style param
  const fromHeader = req.headers["x-course-slug"] || req.headers["X-Course-Slug"];
  const fromQuery = req.query.slug || req.query.course || req.query.courseSlug;
  const fromParam = req.params && req.params.slug;

  const slug = String(fromHeader || fromQuery || fromParam || "")
    .trim()
    .toLowerCase();

  // If bookingRoutes expects header, make sure it always has it
  if (slug && !req.headers["x-course-slug"]) {
    req.headers["x-course-slug"] = slug;
  }

  next();
}, bookingRoutes);



// ✅✅✅ ADD THIS ✅✅✅
app.use(bookingAnalyticsRouter);
// ✅✅✅ END ADD ✅✅✅
app.use("/api/analytics", analyticsRouter);
app.use(bookingViewsRouter);
// ✅✅✅ END ADD ✅✅✅

app.use(groupVotesRouter);

// 🔔 Alerts API
app.use("/api/alerts", alertsRouter);
// 🔔 Push notifications API
app.use("/api/push", pushRouter);

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
  `${SITE_URL}/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}&paid=1&backend=${encodeURIComponent(SITE_URL)}`;

const cancelUrl =
  process.env.STRIPE_CANCEL_URL ||
  `${SITE_URL}/subscribe-cancel.html?backend=${encodeURIComponent(SITE_URL)}`;

        const derivedPlan = derivePlanFromPriceId(priceId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: customerEmail,
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],

      metadata: {
        email: customerEmail || "",
        plan: derivedPlan,
        planKey: String(plan || "").trim().toUpperCase(),
      },

      subscription_data: {
        metadata: {
          email: customerEmail || "",
          plan: derivedPlan,
          planKey: String(plan || "").trim().toUpperCase(),
        },
      },

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

        let sub = await getSubscriberStatusByEmail(email);

    // ✅ self-heal from Stripe if missing or stale
    const looksInactive =
      !sub ||
      !sub.entitlement_active ||
      !sub.current_period_end ||
      new Date(sub.current_period_end).getTime() <= Date.now() ||
      !["active", "trialing"].includes(String(sub.status || "").toLowerCase());

    if (looksInactive && stripe) {
      try {
        await syncSubscriberStatusFromStripeByEmail(email);
        sub = await getSubscriberStatusByEmail(email);
      } catch (e) {
        console.warn("⚠️ account/plan Stripe self-heal failed:", e?.message || e);
      }
    }

    if (!sub) {
      return res.json({
        plan: "FREE",
        maxFavs: 3,
        entitlementActive: false,
        subscriptionStatus: "inactive",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        reason: "no_subscriber_status",
      });
    }

    const plan = normalizePlan(sub.plan);
    const maxFavs = plan === "PRO" ? 10 : 3;

    return res.json({
      plan,
      maxFavs,
      entitlementActive: !!sub.entitlement_active,
      subscriptionStatus: sub.status || "inactive",
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end || null,
      updatedAt: sub.updated_at || null,
    });
  } catch (err) {
    console.error("account/plan error:", err);
    res.status(500).json({ error: "plan_lookup_failed", detail: err.message });
  }
});
app.post("/api/admin/subscriber-status/resync", async (req, res) => {
  try {
    const emailFromReq = getEmailFromRequest(req);
    if (!isSuperAdmin(emailFromReq)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    if (!stripe) {
      return res.status(500).json({ ok: false, error: "stripe_not_configured" });
    }

    const usersRes = await db.query(`
      SELECT email
      FROM users
      WHERE email IS NOT NULL
        AND TRIM(email) <> ''
      ORDER BY id ASC
    `);

    let checked = 0;
    let updated = 0;
    const errors = [];

    for (const row of usersRes.rows || []) {
      const email = String(row.email || "").trim().toLowerCase();
      if (!email) continue;

      checked += 1;

      try {
        const before = await getSubscriberStatusByEmail(email);
        await syncSubscriberStatusFromStripeByEmail(email);
        const after = await getSubscriberStatusByEmail(email);

        const beforePlan = String(before?.plan || "FREE");
        const afterPlan = String(after?.plan || "FREE");
        const beforeEnt = !!before?.entitlement_active;
        const afterEnt = !!after?.entitlement_active;

        if (beforePlan !== afterPlan || beforeEnt !== afterEnt) {
          updated += 1;
        }
      } catch (e) {
        errors.push({
          email,
          error: e?.message || String(e),
        });
      }
    }

    return res.json({
      ok: true,
      checked,
      updated,
      errors: errors.slice(0, 25),
    });
  } catch (err) {
    console.error("subscriber-status resync error:", err);
    return res.status(500).json({
      ok: false,
      error: "subscriber_resync_failed",
      detail: err.message,
    });
  }
});

// -------------------------------------------------
// ✅ Save account preferences
// Free users can save booking defaults.
// Subscribers can also save alert preferences.
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

    const trimmedEmail = String(email || "").trim().toLowerCase();
    if (!trimmedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    const normalizedHomeState =
      String(homeState || "").trim().toUpperCase() || null;

    const normalizedHomeCourse =
      String(homeCourse || "").trim() || null;

    const normalizedHomeCourseId =
      String(homeCourseId || "").trim() || null;

    const finalHomeCourseState =
      String(homeCourseState || "").trim().toUpperCase() ||
      normalizedHomeState ||
      null;

    const preferredDays = Array.isArray(days) && days.length ? days : null;

    let subscriber = await getSubscriberStatusByEmail(trimmedEmail);
    let entitled =
      !!subscriber?.entitlement_active &&
      (String(subscriber?.status || "").toLowerCase() === "active" ||
        String(subscriber?.status || "").toLowerCase() === "trialing") &&
      !!subscriber?.current_period_end &&
      new Date(subscriber.current_period_end).getTime() > Date.now();

    // Optional self-heal from Stripe if local status looks stale
    if (!entitled && stripe) {
      try {
        await syncSubscriberStatusFromStripeByEmail(trimmedEmail);
        subscriber = await getSubscriberStatusByEmail(trimmedEmail);
        entitled =
          !!subscriber?.entitlement_active &&
          (String(subscriber?.status || "").toLowerCase() === "active" ||
            String(subscriber?.status || "").toLowerCase() === "trialing") &&
          !!subscriber?.current_period_end &&
          new Date(subscriber.current_period_end).getTime() > Date.now();
      } catch (e) {
        console.warn("⚠️ preferences save Stripe self-heal failed:", e?.message || e);
      }
    }

    // -------------------------------------------------
    // 1) Save booking defaults for EVERYONE
    // -------------------------------------------------
    await db.query(
      `
      INSERT INTO user_preferences (
        email,
        home_state,
        updated_at
      )
      VALUES ($1, $2, now())
      ON CONFLICT (email) DO UPDATE SET
        home_state = EXCLUDED.home_state,
        updated_at = now()
      `,
      [trimmedEmail, normalizedHomeState]
    );

    await db.query(
      `
      UPDATE users
      SET
        home_course = $2,
        home_course_id = $3,
        home_course_state = $4
      WHERE LOWER(email) = LOWER($1)
      `,
      [
        trimmedEmail,
        normalizedHomeCourse,
        normalizedHomeCourseId,
        finalHomeCourseState,
      ]
    );

    // -------------------------------------------------
    // 2) Free users stop here
    // -------------------------------------------------
    if (!entitled) {
      return res.json({
        ok: true,
        entitlementActive: false,
        plan: "FREE",
        alertsLocked: true,
        saved: {
          homeState: normalizedHomeState,
          homeCourse: normalizedHomeCourse,
          homeCourseId: normalizedHomeCourseId,
          homeCourseState: finalHomeCourseState,
        },
      });
    }

    // -------------------------------------------------
    // 3) Subscribers save alert preferences too
    // -------------------------------------------------
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
        normalizedHomeState,
        JSON.stringify(favourites || []),
        preferredDays,
        earliest || null,
        latest || null,
        holes ? Number(holes) : null,
        partySize ? Number(partySize) : null,
        alertFrequency || null,
      ]
    );

    return res.json({
      ok: true,
      entitlementActive: true,
      plan: normalizePlan(subscriber?.plan || "FREE"),
      saved: {
        homeState: normalizedHomeState,
        homeCourse: normalizedHomeCourse,
        homeCourseId: normalizedHomeCourseId,
        homeCourseState: finalHomeCourseState,
        favourites,
        days,
        earliest: earliest || null,
        latest: latest || null,
        holes: holes ? Number(holes) : null,
        partySize: partySize ? Number(partySize) : null,
        alertFrequency: alertFrequency || null,
      },
    });
  } catch (err) {
    console.error("account/preferences error:", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// ✅ Load account preferences
// Free users still get booking defaults from backend.
// Subscribers also get alert preferences.
// -------------------------------------------------
app.get("/api/account/preferences", async (req, res) => {
  try {
    const trimmedEmail = String(req.query.email || "").trim().toLowerCase();
    if (!trimmedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    let subscriber = await getSubscriberStatusByEmail(trimmedEmail);
    let entitled =
      !!subscriber?.entitlement_active &&
      (String(subscriber?.status || "").toLowerCase() === "active" ||
        String(subscriber?.status || "").toLowerCase() === "trialing") &&
      !!subscriber?.current_period_end &&
      new Date(subscriber.current_period_end).getTime() > Date.now();

    if (!entitled && stripe) {
      try {
        await syncSubscriberStatusFromStripeByEmail(trimmedEmail);
        subscriber = await getSubscriberStatusByEmail(trimmedEmail);
        entitled =
          !!subscriber?.entitlement_active &&
          (String(subscriber?.status || "").toLowerCase() === "active" ||
            String(subscriber?.status || "").toLowerCase() === "trialing") &&
          !!subscriber?.current_period_end &&
          new Date(subscriber.current_period_end).getTime() > Date.now();
      } catch (e) {
        console.warn("⚠️ preferences load Stripe self-heal failed:", e?.message || e);
      }
    }

    const prefRes = await db.query(
      `
      SELECT
        email,
        home_state,
        favourites,
        preferred_days,
        preferred_earliest,
        preferred_latest,
        preferred_holes,
        preferred_party_size,
        alert_frequency
      FROM user_preferences
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [trimmedEmail]
    );

    const userRes = await db.query(
      `
      SELECT
        email,
        home_course,
        home_course_id,
        home_course_state
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [trimmedEmail]
    );

    const pref = prefRes.rows?.[0] || null;
    const user = userRes.rows?.[0] || null;

    return res.json({
      ok: true,
      found: !!(pref || user),
      entitlementActive: entitled,
      plan: entitled ? normalizePlan(subscriber?.plan || "FREE") : "FREE",
      preferences: {
        home_state: pref?.home_state || "",
        favourites: entitled ? (pref?.favourites || []) : [],
        preferred_days: entitled ? (pref?.preferred_days || []) : [],
        preferred_earliest: entitled ? (pref?.preferred_earliest || "") : "",
        preferred_latest: entitled ? (pref?.preferred_latest || "") : "",
        preferred_holes: entitled ? (pref?.preferred_holes ?? "") : "",
        preferred_party_size: entitled ? (pref?.preferred_party_size ?? "1") : "1",
        alert_frequency: entitled ? (pref?.alert_frequency || "POPUPS_ONLY") : "POPUPS_ONLY",

        // extra fields for convenience
        home_course: user?.home_course || "",
        home_course_id: user?.home_course_id || null,
        home_course_state: user?.home_course_state || pref?.home_state || "",
      },
    });
  } catch (err) {
    console.error("account/preferences GET error:", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// ✅ Update display name
// -------------------------------------------------
app.post("/api/account/display-name", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;

    const displayName = String(req.body?.displayName || "")
      .trim()
      .slice(0, 40);

    if (!displayName) {
      return res.status(400).json({
        ok: false,
        error: "Display name required"
      });
    }

    await db.query(
      `
      UPDATE users
      SET display_name = $2
      WHERE id = $1
      `,
      [userId, displayName]
    );

    return res.json({
      ok: true,
      displayName
    });
  } catch (err) {
    console.error("display name update error:", err);

    return res.status(500).json({
      ok: false,
      error: "Could not update display name"
    });
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
// ✅ robust party size parsing (handles "4 players" etc)
function parsePartySize(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  const m = s.match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : 1;
}
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

    function parseHoles(v) {
      if (v === "" || v === null || typeof v === "undefined") return "";
      const m = String(v).match(/\d+/); // pulls 18 from "18 holes"
      const n = m ? Number(m[0]) : NaN;
      return Number.isFinite(n) ? n : "";
    }

    const holesValue = parseHoles(holes);

    const stateCode = (state || "").toString().toUpperCase();

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,
      partySize: parsePartySize(partySize),
      state: stateCode || null,
    };

    console.log("Incoming /api/search", criteria);

    // ✅ Party-size enforcement ONLY when remaining is confidently known
function normalizeRemaining(s) {
  if (!s || typeof s !== "object") return null;

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Helper: read capacity + booked early (TeeRadarBooking uses these reliably)
  const maxPlayers = toNum(
    s.maxPlayers ??
    s.max_players ??
    s.capacity ??
    s.max ??
    s.playersMax ??
    s.maxPlayersPerSlot ??
    s.max_players_per_slot
  );

  const bookedPlayers = toNum(
    s.bookedPlayers ??
    s.booked_players ??
    s.booked ??
    s.taken ??
    s.playersBooked ??
    s.bookedCount ??
    s.booked_count
  );

  // 1) explicit "remaining" fields (best case)
  const direct =
    s.remaining ??
    s.remainingPlayers ??
    s.playersRemaining ??
    s.spotsRemaining ??
    s.playersAvailable ??
    s.spotsAvailable ??
    s.remaining_players ??
    s.remainingSpots ??
    s.spots_left ??
    s.slots_left ??
    s.players_left ??
    s.openings;

  const dr = toNum(direct);

  // ✅ IMPORTANT FIX:
  // If we ALSO have max+booked, and "remaining" suspiciously equals maxPlayers,
  // treat it as CAPACITY (not remaining) and compute remaining = max - booked.
  if (dr !== null) {
    if (maxPlayers !== null && bookedPlayers !== null) {
      // common bad-case: remaining=4 but booked=2 (actually 2 remaining)
      if (dr === maxPlayers && bookedPlayers > 0) {
        return Math.max(0, maxPlayers - bookedPlayers);
      }
      // another bad-case: remaining > maxPlayers (clearly not remaining)
      if (dr > maxPlayers) {
        return Math.max(0, maxPlayers - bookedPlayers);
      }
    }
    return Math.max(0, dr);
  }

  // 2) detect "3/4" style strings anywhere (booked/total)
  const ratioText =
    s.ratio ??
    s.bookedRatio ??
    s.spotsText ??
    s.availability ??
    s.capacityText ??
    s.playersText ??
    s.display ??
    s.label;

  if (typeof ratioText === "string") {
    // 2a) "3/4" format (booked/total)
    let m = ratioText.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const booked = toNum(m[1]);
      const total = toNum(m[2]);
      if (booked !== null && total !== null && total > 0) {
        return Math.max(0, total - booked);
      }
    }

    // 2b) "2 slots available" / "2 spots left" / "2 players left"
    m = ratioText.match(/(\d+)\s*(slots?|spots?|players?)\s*(available|left|remain(ing)?)/i);
    if (m) {
      const n = toNum(m[1]);
      if (n !== null) return Math.max(0, n);
    }
  }

  // 3) compute from max - booked ONLY if BOTH are explicitly known
  if (maxPlayers === null || bookedPlayers === null) return null;

  return Math.max(0, maxPlayers - bookedPlayers);
}

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
        earliest,   // ✅ ADD
        latest,     // ✅ ADD
      });

      if (cached) {
        const normalizedCached = Array.isArray(cached)
          ? cached.map((s) => ({
              ...(s && typeof s === "object" ? s : { time: String(s) }),
              _provider: String(s?._provider || s?.provider || provider || "Other"),
              _courseName: c.name,
              _courseId: courseId,
              _state: (c.state || "").toString().toUpperCase(),
            }))
          : [];

        console.log(`⚡ cache hit → ${c.name} (${normalizedCached.length} slots)`);
        return normalizedCached;
      }

      try {
        const result = await scrapeCourse(c, criteria, feeGroups);

        // ✅ attach provider/course metadata to every slot so we can filter later
        const normalized = Array.isArray(result)
          ? result.map((s) => ({
              ...(s && typeof s === "object" ? s : { time: String(s) }),
              _provider: String(s?._provider || s?.provider || provider || "Other"),
              _courseName: c.name,
              _courseId: courseId,
              _state: (c.state || "").toString().toUpperCase(),
            }))
          : [];

        console.log(`✅ scraped ${c.name} → ${normalized.length} slots`);

        await saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: normalized,
        });

        return normalized;
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

    // ✅ Dedup identical tee-times so we don't "double count" the same thing
    const seen = new Set();
    const dedupedSlots = [];

    for (const s of slots) {
      const key = [
        s?._courseId || s?._courseName || s?.courseName || s?.course || "",
        s?.date || date || "",
        s?.time || "",
        s?.holes || holesValue || "",
        s?._provider || s?.provider || "",
        // include layout if present so 2 different routings don't collapse
        s?.layoutKey || s?.layout_key || "",
        s?.frontNineKey || s?.front_nine_key || "",
        s?.backNineKey || s?.back_nine_key || "",
      ].join("|");

      if (seen.has(key)) continue;
      seen.add(key);
      dedupedSlots.push(s);
    }

    const slotsToUse = dedupedSlots;
    const party = Number(criteria.partySize) || 1;

    // ✅ Stats should be computed on the same list we actually filter (deduped)
    let known = 0,
      unknown = 0,
      blocked = 0;

    for (const s of slotsToUse) {
      const r = normalizeRemaining(s);
      if (r === null) unknown++;
      else {
        known++;
        if (r < party) blocked++;
      }
    }

    console.log("🧪 partySize filter stats", {
      party,
      raw: slotsToUse.length,
      known,
      unknown,
      blocked,
    });

    // ✅ FIX (final): enforce party size whenever remaining is known.
    // Only allow "unknown remaining" for NON booking-engine providers.
    const filtered = slotsToUse.filter((s) => {
  const remaining = normalizeRemaining(s);

  const provRaw = String(s?._provider || s?.provider || "");
const prov = provRaw.toLowerCase();

  // ✅ Robust booking-engine detection:
  // - provider string OR
  // - booking URL points to our /book/ pages OR
  // - slot contains booking engine capacity fields
  const url = String(s?.url || s?.bookingUrl || s?.booking_url || "");
  const looksLikeOurBookingUrl =
    url.includes("/book/") || url.includes("teeradar-fullstack") || url.includes("teeradar.com.au/book/");

  const hasCapacityFields =
    Number.isFinite(Number(s?.maxPlayers ?? s?.max_players)) ||
    Number.isFinite(Number(s?.bookedPlayers ?? s?.booked_players));

  const isBookingEngine =
  prov.includes("teeradarbooking") ||
  prov.includes("teeradar") ||
  prov === "booking" ||
  prov.includes("booking") ||
  looksLikeOurBookingUrl ||
  hasCapacityFields;

  // ✅ If we know remaining, ALWAYS enforce it
  if (remaining !== null) return remaining >= party;

  // ✅ If remaining is unknown:
  // booking-engine slots MUST NOT be shown (they should always have capacity)
  if (isBookingEngine) return false;

  // external scrapers: allow unknown
  return true;
});

    const slotsOut = filtered.map((s) => {
      const remaining = normalizeRemaining(s);
      return {
        ...s,
        remaining: typeof s.remaining === "number" ? s.remaining : remaining,
        fitsParty: remaining === null ? null : remaining >= party,
        _partyRequested: party,
      };
    });

    console.log(
      `🔎 /api/search complete → ${slotsOut.length} slots (partySize=${party}, raw=${slotsToUse.length})`
    );

    return res.json({ slots: slotsOut });
  } catch (err) {
    console.error("search error", err);
    return res.status(500).json({ error: "internal error", detail: err.message });
  }
});

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
// ✅ NEW: Booking success page (MUST be before /book/:slug)
app.get("/book/success", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "book-success.html"));
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
app.get("/group-vote", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "group-vote.html"));
});

app.get("/group-vote.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "group-vote.html"));
});

// -------------------------------------------------
// Frontend fallback
// -------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});
async function backfillExistingSubscriberStatuses() {
  if (!stripe) {
    console.log("ℹ️ Skipping subscriber backfill: Stripe not configured");
    return;
  }

  try {
    const usersRes = await db.query(`
      SELECT email
      FROM users
      WHERE email IS NOT NULL
        AND TRIM(email) <> ''
      ORDER BY id ASC
      LIMIT 200
    `);

    let updated = 0;

    for (const row of usersRes.rows || []) {
      const email = String(row.email || "").trim().toLowerCase();
      if (!email) continue;

      try {
        const before = await getSubscriberStatusByEmail(email);
        const shouldCheck =
          !before ||
          !before.entitlement_active ||
          !before.current_period_end ||
          !["active", "trialing"].includes(String(before.status || "").toLowerCase());

        if (!shouldCheck) continue;

        await syncSubscriberStatusFromStripeByEmail(email);
        updated += 1;
      } catch (e) {
        console.warn("⚠️ subscriber backfill failed for", email, e?.message || e);
      }
    }

    console.log(`✅ subscriber backfill complete (${updated} user(s) checked/repaired)`);
  } catch (err) {
    console.error("❌ subscriber backfill failed:", err);
  }
}
// -------------------------------------------------
// Start Server
// -------------------------------------------------
backfillExistingSubscriberStatuses();

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
