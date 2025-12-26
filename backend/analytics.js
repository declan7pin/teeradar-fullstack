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

// Event type aliases for alerts (so your system still works even if you log slightly different strings)
const ALERT_SENT_TYPES = ["alert_sent", "alert_email_sent", "alerts_sent"];
const ALERT_HIT_TYPES = ["alert_hit", "alert_match", "alerts_hit"];

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
      p = typeOrObj || {};
      type = String(p.type || "").trim();
    } else {
      type = String(typeOrObj || "").trim();
      p = payload && typeof payload === "object" ? payload : {};
    }

    if (!type) return;

    const at = p.at || p.occurred_at || null;

    // accept snake_case or camelCase
    const userId =
      p.userId ??
      p.user_id ??
      p.user ??
      p.uid ??
      null;

    const courseName =
      p.courseName ??
      p.course_name ??
      p.course ??
      null;

    const roundIdRaw =
      p.roundId ??
      p.round_id ??
      null;

    const roundId =
      roundIdRaw === null || typeof roundIdRaw === "undefined" || roundIdRaw === ""
        ? null
        : Number(roundIdRaw);

    const planRaw =
      p.plan ??
      p.plan_name ??
      p.subscriptionPlan ??
      p.subscription_plan ??
      null;

    const plan = normalisePlan(planRaw);

    const metaRaw =
      p.meta ??
      p.payload ??
      p.data ??
      p.details ??
      null;

    const meta = safeJson(metaRaw);

    const timestamp = at || new Date().toISOString();

    // ✅ IMPORTANT: store meta as JSONB properly (do NOT stringify; cast param to jsonb)
    await db.query(
      `INSERT INTO analytics (type, user_id, course_name, occurred_at, round_id, plan, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        type,
        userId || null,
        courseName || null,
        timestamp,
        Number.isFinite(roundId) ? roundId : null,
        plan,
        meta ? meta : null,
      ]
    );
  } catch (err) {
    console.error("Postgres analytics insert failed:", err);
  }
}

/**
 * ✅ Top played courses based on round_played events
 * Returns: [{ courseName, rounds }]
 */
export async function getTopPlayedCourses(limit = 10, days = null) {
  await ensureAnalyticsTable();

  const params = [limit];
  let whereTime = "";

  if (Number.isFinite(Number(days)) && Number(days) > 0) {
    params.push(Number(days));
    whereTime = `AND occurred_at >= NOW() - ($2 * INTERVAL '1 day')`;
  }

  const { rows } = await db.query(
    `
    SELECT
      course_name AS "courseName",
      COUNT(DISTINCT round_id)::int AS "rounds"
    FROM analytics
    WHERE type = 'round_played'
      AND round_id IS NOT NULL
      AND course_name IS NOT NULL
      AND course_name <> ''
      ${whereTime}
    GROUP BY course_name
    ORDER BY COUNT(DISTINCT round_id) DESC
    LIMIT $1
    `,
    params
  );

  return rows;
}

// ✅ Alerts: top courses (7d) based on alert hit events
async function getTopAlertCourses7d(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `
    SELECT
      course_name AS "courseName",
      COUNT(*)::int AS "hits"
    FROM analytics
    WHERE type = ANY($1::text[])
      AND occurred_at >= NOW() - INTERVAL '7 days'
      AND course_name IS NOT NULL
      AND course_name <> ''
    GROUP BY course_name
    ORDER BY COUNT(*) DESC
    LIMIT $2
    `,
    [ALERT_HIT_TYPES, limit]
  );

  return rows;
}

// ✅ Alerts: alerts by plan (7d) based on sent events
async function getAlertsByPlan7d() {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `
    SELECT
      COALESCE(plan, 'UNKNOWN') AS "plan",
      COUNT(*)::int AS "count"
    FROM analytics
    WHERE type = ANY($1::text[])
      AND occurred_at >= NOW() - INTERVAL '7 days'
    GROUP BY COALESCE(plan, 'UNKNOWN')
    ORDER BY COUNT(*) DESC
    `,
    [ALERT_SENT_TYPES]
  );

  const out = { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 };
  rows.forEach((r) => {
    const key = String(r.plan || "UNKNOWN").toUpperCase();
    out[key] = (out[key] || 0) + (Number(r.count) || 0);
  });

  return out;
}

// ✅ Alerts: avg time from alert_sent -> alert_hit (minutes), within 7d
async function getAvgTimeToHitMins7d() {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `
    WITH hits AS (
      SELECT user_id, course_name, occurred_at AS hit_at
      FROM analytics
      WHERE type = ANY($1::text[])
        AND occurred_at >= NOW() - INTERVAL '7 days'
        AND user_id IS NOT NULL AND user_id <> ''
        AND course_name IS NOT NULL AND course_name <> ''
    ),
    paired AS (
      SELECT
        h.user_id,
        h.course_name,
        h.hit_at,
        s.occurred_at AS sent_at,
        EXTRACT(EPOCH FROM (h.hit_at - s.occurred_at))/60.0 AS minutes
      FROM hits h
      JOIN LATERAL (
        SELECT occurred_at
        FROM analytics
        WHERE type = ANY($2::text[])
          AND user_id = h.user_id
          AND course_name = h.course_name
          AND occurred_at <= h.hit_at
        ORDER BY occurred_at DESC
        LIMIT 1
      ) s ON TRUE
      WHERE EXTRACT(EPOCH FROM (h.hit_at - s.occurred_at)) >= 0
        AND EXTRACT(EPOCH FROM (h.hit_at - s.occurred_at)) <= 86400 * 7
    )
    SELECT COALESCE(AVG(minutes), 0)::float AS avg_mins
    FROM paired
    `,
    [ALERT_HIT_TYPES, ALERT_SENT_TYPES]
  );

  const avg = rows?.[0]?.avg_mins;
  return Number.isFinite(Number(avg)) ? Number(avg) : 0;
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

  // ----- existing metrics (keep working no matter what) -----

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

  // ✅ rounds played (deduped by round_id)
  summary.roundsPlayed = await count(
    `SELECT COUNT(DISTINCT round_id)::int AS n
     FROM analytics
     WHERE type = 'round_played'
       AND round_id IS NOT NULL`
  );

  summary.roundsPlayed7d = await count(
    `SELECT COUNT(DISTINCT round_id)::int AS n
     FROM analytics
     WHERE type = 'round_played'
       AND round_id IS NOT NULL
       AND occurred_at >= NOW() - INTERVAL '7 days'`
  );

  summary.topPlayedCourses = await getTopPlayedCourses(10);
  summary.topPlayedCourses30d = await getTopPlayedCourses(10, 30);

  summary.newUsers7d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '7 days'`
  );

  summary.newUsers = summary.newUsers7d;

  summary.usersAllTime = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n FROM analytics`
  );

  summary.usersToday = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= date_trunc('day', NOW())`
  );

  summary.usersWeek = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= date_trunc('day', NOW()) - INTERVAL '6 days'`
  );

  summary.users30d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '30 days'`
  );

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

  summary.homeToBookingRate =
    summary.homeViews > 0 ? summary.bookingClicks / summary.homeViews : 0;

  summary.searchToBookingRate =
    summary.searches > 0 ? summary.bookingClicks / summary.searches : 0;

  summary.homePageViews = summary.homeViews;
  summary.courseBookingClicks = summary.bookingClicks;
  summary.conversionHomeToBooking = summary.homeToBookingRate;
  summary.conversionSearchToBooking = summary.searchToBookingRate;

  summary.rounds = summary.roundsPlayed;

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

  // Attach course-level metrics to the summary
  summary.topCourses = await getTopCourses(10);
  summary.topSearchedCourses = await getTopSearchedCourses(10);
  summary.demandRank = await getDemandRanking(10);

  // =========================
  // ✅ ALERTS (DO NOT BREAK DASHBOARD)
  // =========================
  try {
    summary.alertsSent7d = await count(
      `SELECT COUNT(*)::int AS n
       FROM analytics
       WHERE type = ANY($1::text[])
         AND occurred_at >= NOW() - INTERVAL '7 days'`,
      [ALERT_SENT_TYPES]
    );

    summary.alertHits7d = await count(
      `SELECT COUNT(*)::int AS n
       FROM analytics
       WHERE type = ANY($1::text[])
         AND occurred_at >= NOW() - INTERVAL '7 days'`,
      [ALERT_HIT_TYPES]
    );

    summary.hitRate7d =
      summary.alertsSent7d > 0 ? summary.alertHits7d / summary.alertsSent7d : 0;

    summary.avgTimeToHitMins = await getAvgTimeToHitMins7d();
    summary.alertsByPlan = await getAlertsByPlan7d();
    summary.topAlertCourses = await getTopAlertCourses7d(10);
  } catch (e) {
    console.error("⚠️ Alerts analytics block failed (non-fatal):", e?.message || e);
    summary.alertsSent7d = 0;
    summary.alertHits7d = 0;
    summary.hitRate7d = 0;
    summary.avgTimeToHitMins = 0;
    summary.alertsByPlan = { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 };
    summary.topAlertCourses = [];
  }

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