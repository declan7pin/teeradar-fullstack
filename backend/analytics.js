// backend/analytics.js
// Postgres-based analytics storage

import db from "./db.js";

let initPromise = null;

// Ensure the analytics table exists (run once)
async function ensureAnalyticsTable() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id          SERIAL PRIMARY KEY,
        type        TEXT NOT NULL,
        user_id     TEXT,
        course_name TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ✅ add round_id for dedupe (doesn't break existing rows)
    await db.query(`
      ALTER TABLE analytics
      ADD COLUMN IF NOT EXISTS round_id BIGINT;
    `);

    // ✅ add plan for alert/subscription segmentation (safe)
    await db.query(`
      ALTER TABLE analytics
      ADD COLUMN IF NOT EXISTS plan TEXT;
    `);

    // ✅ add meta JSON for future-proofing (safe)
    await db.query(`
      ALTER TABLE analytics
      ADD COLUMN IF NOT EXISTS meta JSONB;
    `);

    // helpful indexes (safe)
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_type_time
      ON analytics (type, occurred_at DESC);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_user_course_time
      ON analytics (user_id, course_name, occurred_at DESC);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_round_id
      ON analytics (round_id);
    `);

    // ✅ Ensure alert hit storage exists (your alertWorker writes to this)
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_hits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT NOT NULL,
        provider TEXT,
        date TEXT NOT NULL,              -- 'YYYY-MM-DD'
        holes INTEGER,
        party_size INTEGER,
        earliest TEXT,
        latest TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);

    // ✅ Ensure alert sent log exists (so "alerts sent (7d)" is real)
    await db.query(`
      CREATE TABLE IF NOT EXISTS alert_emails_sent (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        hit_count INTEGER DEFAULT 0,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  })();

  return initPromise;
}

// ---------- helpers ----------
function normalisePlan(plan) {
  if (!plan) return null;
  const p = String(plan).trim().toUpperCase();
  if (!p) return null;
  if (p === "PRO") return "PRO";
  if (p === "BASIC") return "BASIC";
  if (p === "FREE") return "FREE";
  if (p === "TRIAL") return "TRIAL";
  // allow custom labels but keep short
  return p.slice(0, 32);
}

function safeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (
      obj &&
      Object.prototype.hasOwnProperty.call(obj, k) &&
      obj[k] != null
    )
      return obj[k];
  }
  return fallback;
}

// Event type aliases for alerts (kept for backwards compat if you ever log alerts into analytics)
const ALERT_SENT_TYPES = ["alert_sent", "alert_email_sent", "alerts_sent"];
const ALERT_HIT_TYPES = ["alert_hit", "alert_match", "alerts_hit"];

// ✅ Round event aliases (so rounds can register even if your UI logs a slightly different type)
const ROUND_TYPES = [
  "round_played",
  "round_completed",
  "round_saved",
  "scorecard_saved",
  "round_created",
];

/**
 * Record an analytics event into Postgres.
 *
 * Supports BOTH:
 *  1) recordEvent({ type, userId, courseName, at, roundId, plan, meta })   (legacy)
 *  2) recordEvent("type", { userId, courseName, at, roundId, plan, meta }) (new)
 */
export async function recordEvent(typeOrObj, payload = {}) {
  try {
    await ensureAnalyticsTable();

    // --- backwards compatible parsing ---
    let type = "";
    let p = {};

    if (typeOrObj && typeof typeOrObj === "object" && !Array.isArray(typeOrObj)) {
      // legacy style
      p = typeOrObj || {};
      type = String(p.type || "").trim();
    } else {
      // new style
      type = String(typeOrObj || "").trim();
      p = payload && typeof payload === "object" ? payload : {};
    }

    if (!type) return;

    // ✅ Some callers wrap data under payload
    if (p.payload && typeof p.payload === "object") {
      p = { ...p.payload, ...p };
    }

    const at = p.at || p.occurred_at || p.occurredAt || null;

    const userId =
      p.userId ??
      p.user_id ??
      p.user ??
      p.uid ??
      p.email ?? // allow email as user id
      null;

    const courseName =
      p.courseName ??
      p.course_name ??
      p.course ??
      p.course?.name ??
      p.round?.courseName ??
      p.round?.course ??
      null;

    // ✅ roundId appears in multiple shapes
    const roundIdRaw =
      p.roundId ??
      p.round_id ??
      p.round?.id ??
      p.round?.roundId ??
      p.round?.round_id ??
      null;

    const roundId =
      roundIdRaw === null ||
      typeof roundIdRaw === "undefined" ||
      roundIdRaw === ""
        ? null
        : Number(roundIdRaw);

    // ✅ plan + meta
    const planRaw =
      p.plan ??
      p.plan_name ??
      p.subscriptionPlan ??
      p.subscription_plan ??
      null;

    const plan = normalisePlan(planRaw);

    const metaRaw =
      p.meta ??
      p.data ??
      p.details ??
      null;

    const meta = safeJson(metaRaw);

    const timestamp = at || new Date().toISOString();

    await db.query(
      `INSERT INTO analytics (type, user_id, course_name, occurred_at, round_id, plan, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        type,
        userId || null,
        courseName || null,
        timestamp,
        Number.isFinite(roundId) ? roundId : null,
        plan,
        meta ? JSON.stringify(meta) : null,
      ]
    );
  } catch (err) {
    console.error("Postgres analytics insert failed:", err);
  }
}

/**
 * ✅ Top played courses based on round events
 * Returns: [{ courseName, rounds }]
 *
 * NOTE: counts DISTINCT COALESCE(round_id, id) so test rounds still count even
 * if your round_id isn't being sent yet.
 */
export async function getTopPlayedCourses(limit = 10, days = null) {
  await ensureAnalyticsTable();

  const params = [ROUND_TYPES, limit];
  let whereTime = "";

  if (Number.isFinite(Number(days)) && Number(days) > 0) {
    params.push(Number(days));
    whereTime = `AND occurred_at >= NOW() - ($3 * INTERVAL '1 day')`;
  }

  const { rows } = await db.query(
    `
    SELECT
      course_name AS "courseName",
      COUNT(DISTINCT COALESCE(round_id, id))::int AS "rounds"
    FROM analytics
    WHERE type = ANY($1)
      AND course_name IS NOT NULL
      AND course_name <> ''
      ${whereTime}
    GROUP BY course_name
    ORDER BY COUNT(DISTINCT COALESCE(round_id, id)) DESC
    LIMIT $2
    `,
    params
  );

  return rows;
}

// ✅ Alerts (7d): Top courses based on user_alert_hits
async function getTopAlertCoursesFromHits7d(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `
    SELECT
      course_name AS "courseName",
      COUNT(*)::int AS "hits"
    FROM user_alert_hits
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND course_name IS NOT NULL
      AND course_name <> ''
    GROUP BY course_name
    ORDER BY COUNT(*) DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows;
}

// ✅ Alerts (7d): Alerts by plan derived from users table + alert_emails_sent
async function getAlertsByPlan7d() {
  await ensureAnalyticsTable();

  // If users.plan isn't present in your DB, this will fall back gracefully.
  try {
    const { rows } = await db.query(
      `
      SELECT
        UPPER(COALESCE(u.plan,'FREE')) AS plan,
        COUNT(a.id)::int AS count
      FROM alert_emails_sent a
      LEFT JOIN users u ON u.email = a.email
      WHERE a.sent_at >= NOW() - INTERVAL '7 days'
      GROUP BY UPPER(COALESCE(u.plan,'FREE'))
      ORDER BY COUNT(a.id) DESC
      `
    );

    const out = { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 };
    rows.forEach((r) => {
      const key = String(r.plan || "UNKNOWN").toUpperCase();
      out[key] = (out[key] || 0) + (Number(r.count) || 0);
    });

    return out;
  } catch (err) {
    return { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 };
  }
}

// ✅ Alerts (7d): avg minutes from hit -> email sent (same user, within 10 mins)
async function getAvgTimeToHitMins7d() {
  await ensureAnalyticsTable();

  try {
    const { rows } = await db.query(
      `
      WITH hits AS (
        SELECT email, created_at
        FROM user_alert_hits
        WHERE created_at >= NOW() - INTERVAL '7 days'
      ),
      sends AS (
        SELECT email, sent_at
        FROM alert_emails_sent
        WHERE sent_at >= NOW() - INTERVAL '7 days'
      ),
      pairs AS (
        SELECT
          h.email,
          EXTRACT(EPOCH FROM (s.sent_at - h.created_at)) / 60.0 AS mins
        FROM hits h
        JOIN sends s
          ON s.email = h.email
         AND s.sent_at >= h.created_at
         AND s.sent_at <= h.created_at + INTERVAL '10 minutes'
      )
      SELECT AVG(mins) AS avg_mins
      FROM pairs
      `
    );

    const avg = rows?.[0]?.avg_mins;
    if (avg == null) return 0;
    const v = Number(avg);
    return Number.isFinite(v) ? v : 0;
  } catch (err) {
    return 0;
  }
}

// ✅ Subscriptions summary (derived from users.plan if present)
async function getSubscriptionsSummary() {
  const out = {
    subscribersActive: 0,
    basicCount: 0,
    proCount: 0,
    mrrEstimate: 0,
    trialToPaidRate: null,
  };

  const BASIC_MRR = Number(process.env.BASIC_MRR || 0);
  const PRO_MRR = Number(process.env.PRO_MRR || 0);

  try {
    const { rows } = await db.query(`
      SELECT UPPER(COALESCE(plan,'FREE')) AS plan, COUNT(*)::int AS n
      FROM users
      GROUP BY UPPER(COALESCE(plan,'FREE'))
    `);

    const map = new Map(rows.map((r) => [String(r.plan), Number(r.n) || 0]));
    out.basicCount = map.get("BASIC") || 0;
    out.proCount = map.get("PRO") || 0;
    out.subscribersActive = out.basicCount + out.proCount;
    out.mrrEstimate = out.basicCount * BASIC_MRR + out.proCount * PRO_MRR;

    // trialToPaidRate needs lifecycle history; leave null unless you add trial tracking table/events.
    out.trialToPaidRate = null;

    return out;
  } catch (err) {
    return out;
  }
}

/**
 * Return a summary of key metrics.
 */
export async function getAnalyticsSummary() {
  await ensureAnalyticsTable();

  const summary = {};

  async function count(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows.length ? Number(rows[0].n) || 0 : 0;
  }

  // ----- existing metrics -----

  summary.homeViews = await count(
    `SELECT COUNT(*)::int AS n FROM analytics WHERE type = 'home_view'`
  );

  summary.bookingClicks = await count(
    `SELECT COUNT(*)::int AS n
     FROM analytics
     WHERE type IN ('booking_click','course_booking_click')`
  );

  summary.searches = await count(
    `SELECT COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'search'`
  );

  // ✅ rounds played (dedupe by COALESCE(round_id,id), and accept multiple round types)
  summary.roundsPlayed = await count(
    `SELECT COUNT(DISTINCT COALESCE(round_id, id))::int AS n
     FROM analytics
     WHERE type = ANY($1)`,
    [ROUND_TYPES]
  );

  summary.roundsPlayed7d = await count(
    `SELECT COUNT(DISTINCT COALESCE(round_id, id))::int AS n
     FROM analytics
     WHERE type = ANY($1)
       AND occurred_at >= NOW() - INTERVAL '7 days'`,
    [ROUND_TYPES]
  );

  summary.topPlayedCourses = await getTopPlayedCourses(10);
  summary.topPlayedCourses30d = await getTopPlayedCourses(10, 30);

  // New users last 7 days
  summary.newUsers7d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '7 days'`
  );
  summary.newUsers = summary.newUsers7d;

  // All-time users
  summary.usersAllTime = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n FROM analytics`
  );

  // Today
  summary.usersToday = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= date_trunc('day', NOW())`
  );

  // This week
  summary.usersWeek = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= date_trunc('day', NOW()) - INTERVAL '6 days'`
  );

  // Last 30 days
  summary.users30d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '30 days'`
  );

  // Returning users (7d)
  summary.returningUsers7d = await count(
    `
    WITH recent AS (
      SELECT DISTINCT user_id
      FROM analytics
      WHERE occurred_at >= NOW() - INTERVAL '7 days'
    ),
    earlier AS (
      SELECT DISTINCT user_id
      FROM analytics
      WHERE occurred_at < NOW() - INTERVAL '7 days'
    )
    SELECT COUNT(*)::int AS n
    FROM recent
    JOIN earlier USING (user_id)
    `
  );

  // Conversion rates (0–1)
  summary.homeToBookingRate =
    summary.homeViews > 0 ? summary.bookingClicks / summary.homeViews : 0;

  summary.searchToBookingRate =
    summary.searches > 0 ? summary.bookingClicks / summary.searches : 0;

  // Aliases for frontend
  summary.homePageViews = summary.homeViews;
  summary.courseBookingClicks = summary.bookingClicks;
  summary.conversionHomeToBooking = summary.homeToBookingRate;
  summary.conversionSearchToBooking = summary.searchToBookingRate;

  summary.rounds = summary.roundsPlayed;

  // Repeat bookers
  summary.repeatBookers = await count(
    `
    SELECT COUNT(*)::int AS n
    FROM (
      SELECT user_id
      FROM analytics
      WHERE type IN ('booking_click','course_booking_click')
        AND user_id IS NOT NULL
        AND user_id <> ''
      GROUP BY user_id
      HAVING COUNT(*) > 1
    ) AS sub
    `
  );

  // Peak booking hour
  {
    const { rows } = await db.query(
      `
      SELECT
        to_char(date_trunc('hour', occurred_at), 'HH24') AS hour,
        COUNT(*)::int AS clicks
      FROM analytics
      WHERE type IN ('booking_click','course_booking_click')
      GROUP BY hour
      ORDER BY clicks DESC
      LIMIT 1
      `
    );

    summary.peakBookingHour = rows.length
      ? { hour: rows[0].hour, clicks: rows[0].clicks }
      : null;
  }

  // Course-level metrics
  summary.topCourses = await getTopCourses(10);
  summary.topSearchedCourses = await getTopSearchedCourses(10);
  summary.demandRank = await getDemandRanking(10);

  // =========================
  // ✅ ALERTS (WIRED IN FOR REAL)
  // =========================

  // Alerts sent (7d) – comes from alert_emails_sent (logged by alertWorker)
  summary.alertsSent7d = await count(
    `SELECT COUNT(*)::int AS n
     FROM alert_emails_sent
     WHERE sent_at >= NOW() - INTERVAL '7 days'`
  );

  // Alert hits (7d) – comes from user_alert_hits (written when availability found)
  summary.alertHits7d = await count(
    `SELECT COUNT(*)::int AS n
     FROM user_alert_hits
     WHERE created_at >= NOW() - INTERVAL '7 days'`
  );

  summary.hitRate7d =
    summary.alertsSent7d > 0 ? summary.alertHits7d / summary.alertsSent7d : 0;

  summary.avgTimeToHitMins = await getAvgTimeToHitMins7d();

  summary.alertsByPlan = await getAlertsByPlan7d();

  summary.topAlertCourses = await getTopAlertCoursesFromHits7d(10);

  // =========================
  // ✅ SUBSCRIPTIONS (WIRED IN)
  // =========================
  const subs = await getSubscriptionsSummary();
  summary.subscribersActive = subs.subscribersActive;
  summary.basicPro = `${subs.basicCount}/${subs.proCount}`;
  summary.basicCount = subs.basicCount;
  summary.proCount = subs.proCount;
  summary.mrrEstimate = subs.mrrEstimate;
  summary.trialToPaidRate = subs.trialToPaidRate;

  return summary;
}

/**
 * Return top courses by click count.
 */
export async function getTopCourses(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `SELECT
        course_name AS "courseName",
        COUNT(*)::int AS "clicks"
     FROM analytics
     WHERE course_name IS NOT NULL
       AND type IN ('booking_click','course_booking_click')
     GROUP BY course_name
     ORDER BY COUNT(*) DESC
     LIMIT $1`,
    [limit]
  );

  return rows;
}

/**
 * Return top courses by search count.
 * Uses per-course search events ("search_course").
 */
export async function getTopSearchedCourses(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `SELECT
        course_name AS "courseName",
        COUNT(*)::int AS "searches"
     FROM analytics
     WHERE course_name IS NOT NULL
       AND type = 'search_course'
     GROUP BY course_name
     ORDER BY COUNT(*) DESC
     LIMIT $1`,
    [limit]
  );

  return rows;
}

/**
 * Course demand ranking:
 * score = (per-course searches * 2) + booking clicks.
 */
export async function getDemandRanking(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `
    SELECT
      course_name AS "courseName",
      SUM(CASE WHEN type = 'search_course' THEN 1 ELSE 0 END)::int AS "searches",
      SUM(CASE WHEN type IN ('booking_click','course_booking_click') THEN 1 ELSE 0 END)::int AS "clicks",
      (
        SUM(CASE WHEN type = 'search_course' THEN 1 ELSE 0 END) * 2
        + SUM(CASE WHEN type IN ('booking_click','course_booking_click') THEN 1 ELSE 0 END)
      )::int AS "score"
    FROM analytics
    WHERE course_name IS NOT NULL
      AND type IN ('search_course','booking_click','course_booking_click')
    GROUP BY course_name
    ORDER BY "score" DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows;
}