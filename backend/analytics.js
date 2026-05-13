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

    // add-ons (safe)
    await db.query(`ALTER TABLE analytics ADD COLUMN IF NOT EXISTS round_id BIGINT;`);
    await db.query(`ALTER TABLE analytics ADD COLUMN IF NOT EXISTS round_key TEXT;`);
    await db.query(`ALTER TABLE analytics ADD COLUMN IF NOT EXISTS plan TEXT;`);
    await db.query(`ALTER TABLE analytics ADD COLUMN IF NOT EXISTS meta JSONB;`);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_type_time
      ON analytics (type, occurred_at DESC);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_user_course_time
      ON analytics (user_id, course_name, occurred_at DESC);
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_analytics_round_id ON analytics (round_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_analytics_round_key ON analytics (round_key);`);
    await db.query(`
  CREATE INDEX IF NOT EXISTS idx_analytics_occurred_at
  ON analytics (occurred_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_analytics_course_type_time
  ON analytics (course_name, type, occurred_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_analytics_type_course_time
  ON analytics (type, course_name, occurred_at DESC);
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_analytics_meta_provider
  ON analytics ((LOWER(COALESCE(meta->>'provider',''))));
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

// ✅ Normalise event types so dashboards never zero out due to naming drift
function normaliseType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";

  // home views
  if (["home_view", "home", "home-page-view", "home_page_view", "homepage_view", "homeview", "home_page_views"].includes(x)) {
    return "home_view";
  }

  // searches
  if (["search", "search_submit", "searches", "search_view", "search_run"].includes(x)) {
    return "search";
  }

  // per-course search (optional)
  if (["search_course", "course_search", "searched_course", "search-course"].includes(x)) {
    return "search_course";
  }

  // booking clicks
  if (["booking_click", "book_click", "booking", "bookingclick"].includes(x)) {
    return "booking_click";
  }

  // course booking clicks
  if (["course_booking_click", "course-booking-click", "course_booking", "course_bookingclick"].includes(x)) {
    return "course_booking_click";
  }

  // rounds played
  if (["round_played", "roundplayed", "played_round", "scorecard_saved", "round_saved"].includes(x)) {
    return "round_played";
  }

  // alerts (leave as-is but keep consistent keys)
  if (["alert_sent", "alert_email_sent", "alerts_sent"].includes(x)) return "alert_sent";
  if (["alert_hit", "alert_match", "alerts_hit"].includes(x)) return "alert_hit";

  // default: keep original trimmed, but cap length
  return String(t).trim().slice(0, 64);
}

// Event type aliases for alerts (tolerant)
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

    let type = "";
    let p = {};

    if (typeOrObj && typeof typeOrObj === "object" && !Array.isArray(typeOrObj)) {
      p = typeOrObj || {};
      type = String(p.type || "").trim();
    } else {
      type = String(typeOrObj || "").trim();
      p = payload && typeof payload === "object" ? payload : {};
    }

    type = normaliseType(type);
    if (!type) return;

    const at = p.at || p.occurred_at || null;

    const userId = p.userId ?? p.user_id ?? p.user ?? p.uid ?? null;

    const courseName = p.courseName ?? p.course_name ?? p.course ?? null;

    const roundIdRaw = p.roundId ?? p.round_id ?? null;

    const roundRawStr =
      roundIdRaw === null || typeof roundIdRaw === "undefined" ? "" : String(roundIdRaw).trim();

    const roundIdNum = roundRawStr ? Number(roundRawStr) : null;

    const round_id = Number.isFinite(roundIdNum) ? roundIdNum : null;
    const round_key = roundRawStr && !Number.isFinite(roundIdNum) ? roundRawStr.slice(0, 128) : null;

    const planRaw =
      p.plan ?? p.plan_name ?? p.subscriptionPlan ?? p.subscription_plan ?? null;
    const plan = normalisePlan(planRaw);

    const metaRaw = p.meta ?? p.payload ?? p.data ?? p.details ?? null;
    const metaObj = safeJson(metaRaw);
    const metaJson = metaObj ? JSON.stringify(metaObj) : null;

    const timestamp = at || new Date().toISOString();

    await db.query(
      `INSERT INTO analytics (type, user_id, course_name, occurred_at, round_id, round_key, plan, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [type, userId || null, courseName || null, timestamp, round_id, round_key, plan, metaJson]
    );
  } catch (err) {
    console.error("Postgres analytics insert failed:", err?.message || err);
  }
}

/**
 * Top played courses based on round_played events
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
      COUNT(DISTINCT COALESCE(round_key, round_id::text))::int AS "rounds"
    FROM analytics
    WHERE type = 'round_played'
      AND COALESCE(round_key, round_id::text) IS NOT NULL
      AND course_name IS NOT NULL
      AND course_name <> ''
      ${whereTime}
    GROUP BY course_name
    ORDER BY COUNT(DISTINCT COALESCE(round_key, round_id::text)) DESC
    LIMIT $1
    `,
    params
  );

  return rows;
}

// ---------------- ALERT helpers ----------------
async function getTopAlertCourses7d(limit = 10) {
  await ensureAnalyticsTable();
  const { rows } = await db.query(
    `
    SELECT course_name AS "courseName", COUNT(*)::int AS "hits"
    FROM analytics
    WHERE type = ANY($1::text[])
      AND occurred_at >= NOW() - INTERVAL '7 days'
      AND course_name IS NOT NULL AND course_name <> ''
    GROUP BY course_name
    ORDER BY COUNT(*) DESC
    LIMIT $2
    `,
    [ALERT_HIT_TYPES, limit]
  );
  return rows;
}

async function getAlertsByPlan7d() {
  await ensureAnalyticsTable();
  const { rows } = await db.query(
    `
    SELECT COALESCE(plan, 'UNKNOWN') AS "plan", COUNT(*)::int AS "count"
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
export async function getAnalyticsSummary(filters = {}) {
  await ensureAnalyticsTable();

  const summary = {};

  const provider = String(filters.provider || "").trim().toLowerCase();
  const from = String(filters.from || "").trim();
  const to = String(filters.to || "").trim();

  function applyFilters(sql, params = []) {
    const whereParts = [];
    const whereParams = [];
    let paramIdx = params.length + 1;

    if (provider) {
      whereParts.push(`LOWER(COALESCE(meta->>'provider','')) = $${paramIdx}`);
      whereParams.push(provider);
      paramIdx++;
    }

    if (from) {
      whereParts.push(`occurred_at >= $${paramIdx}::date`);
      whereParams.push(from);
      paramIdx++;
    }

    if (to) {
      whereParts.push(`occurred_at < ($${paramIdx}::date + INTERVAL '1 day')`);
      whereParams.push(to);
      paramIdx++;
    }

    const extraWhere = whereParts.length
      ? " AND " + whereParts.join(" AND ")
      : "";

    return {
      sql: sql.replaceAll("__FILTERS__", extraWhere),
      params: [...params, ...whereParams],
    };
  }

  async function count(sql, params = []) {
    const q = applyFilters(sql, params);
    const { rows } = await db.query(q.sql, q.params);
    return rows.length ? Number(rows[0].n) || 0 : 0;
  }

  async function rowsQuery(sql, params = []) {
    const q = applyFilters(sql, params);
    const { rows } = await db.query(q.sql, q.params);
    return rows || [];
  }

  summary.homeViews = await count(`
    SELECT COUNT(*)::int AS n
    FROM analytics
    WHERE type IN ('home_view','home_page_view','homepage_view','homeView','home')
    __FILTERS__
  `);

  summary.bookingClicks = await count(`
    SELECT COUNT(*)::int AS n
    FROM analytics
    WHERE type IN (
      'booking_click','course_booking_click',
      'booking','book_click','course_booking'
    )
    __FILTERS__
  `);

  summary.searches = await count(`
    SELECT COUNT(*)::int AS n
    FROM analytics
    WHERE type IN ('search','search_submit','searches')
    __FILTERS__
  `);

  summary.roundsPlayed = await count(`
    SELECT COUNT(DISTINCT COALESCE(round_key, round_id::text))::int AS n
    FROM analytics
    WHERE type IN ('round_played','round_saved','scorecard_saved')
      AND COALESCE(round_key, round_id::text) IS NOT NULL
    __FILTERS__
  `);

  summary.roundsPlayed7d = await count(`
    SELECT COUNT(DISTINCT COALESCE(round_key, round_id::text))::int AS n
    FROM analytics
    WHERE type IN ('round_played','round_saved','scorecard_saved')
      AND COALESCE(round_key, round_id::text) IS NOT NULL
      AND occurred_at >= NOW() - INTERVAL '7 days'
    __FILTERS__
  `);

  summary.newUsers7d = await count(`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM analytics
    WHERE occurred_at >= NOW() - INTERVAL '7 days'
    __FILTERS__
  `);

  summary.newUsers = summary.newUsers7d;

  summary.usersAllTime = await count(`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM analytics
    WHERE user_id IS NOT NULL
    __FILTERS__
  `);

  summary.usersToday = await count(`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM analytics
    WHERE occurred_at >= date_trunc('day', NOW())
    __FILTERS__
  `);

  summary.usersWeek = await count(`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM analytics
    WHERE occurred_at >= date_trunc('day', NOW()) - INTERVAL '6 days'
    __FILTERS__
  `);

  summary.users30d = await count(`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM analytics
    WHERE occurred_at >= NOW() - INTERVAL '30 days'
    __FILTERS__
  `);

  summary.returningUsers7d = await count(`
    WITH recent AS (
      SELECT DISTINCT user_id
      FROM analytics
      WHERE occurred_at >= NOW() - INTERVAL '7 days'
        AND user_id IS NOT NULL
        __FILTERS__
    ),
    earlier AS (
      SELECT DISTINCT user_id
      FROM analytics
      WHERE occurred_at < NOW() - INTERVAL '7 days'
        AND user_id IS NOT NULL
        __FILTERS__
    )
    SELECT COUNT(*)::int AS n
    FROM recent
    JOIN earlier USING (user_id)
  `);

  summary.topCourses = await rowsQuery(`
    SELECT course_name AS "courseName", COUNT(*)::int AS "clicks"
    FROM analytics
    WHERE course_name IS NOT NULL
      AND course_name <> ''
      AND type IN ('booking_click','course_booking_click','booking','book_click','course_booking')
    __FILTERS__
    GROUP BY course_name
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);

  summary.topSearchedCourses = await rowsQuery(`
    SELECT course_name AS "courseName", COUNT(*)::int AS "searches"
    FROM analytics
    WHERE course_name IS NOT NULL
      AND course_name <> ''
      AND type IN ('search_course','course_search','searched_course')
    __FILTERS__
    GROUP BY course_name
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);

  summary.demandRank = await rowsQuery(`
    SELECT
      course_name AS "courseName",
      SUM(CASE WHEN type IN ('search_course','course_search','searched_course') THEN 1 ELSE 0 END)::int AS "searches",
      SUM(CASE WHEN type IN ('booking_click','course_booking_click','booking','book_click','course_booking') THEN 1 ELSE 0 END)::int AS "clicks",
      (
        SUM(CASE WHEN type IN ('search_course','course_search','searched_course') THEN 1 ELSE 0 END) * 2
        + SUM(CASE WHEN type IN ('booking_click','course_booking_click','booking','book_click','course_booking') THEN 1 ELSE 0 END)
      )::int AS "score"
    FROM analytics
    WHERE course_name IS NOT NULL
      AND course_name <> ''
      AND type IN (
        'search_course','course_search','searched_course',
        'booking_click','course_booking_click','booking','book_click','course_booking'
      )
    __FILTERS__
    GROUP BY course_name
    ORDER BY "score" DESC
    LIMIT 10
  `);

  summary.topPlayedCourses = await rowsQuery(`
    SELECT
      course_name AS "courseName",
      COUNT(DISTINCT COALESCE(round_key, round_id::text))::int AS "rounds"
    FROM analytics
    WHERE type = 'round_played'
      AND COALESCE(round_key, round_id::text) IS NOT NULL
      AND course_name IS NOT NULL
      AND course_name <> ''
    __FILTERS__
    GROUP BY course_name
    ORDER BY COUNT(DISTINCT COALESCE(round_key, round_id::text)) DESC
    LIMIT 10
  `);

  summary.topPlayedCourses30d = await rowsQuery(`
    SELECT
      course_name AS "courseName",
      COUNT(DISTINCT COALESCE(round_key, round_id::text))::int AS "rounds"
    FROM analytics
    WHERE type = 'round_played'
      AND COALESCE(round_key, round_id::text) IS NOT NULL
      AND course_name IS NOT NULL
      AND course_name <> ''
      AND occurred_at >= NOW() - INTERVAL '30 days'
    __FILTERS__
    GROUP BY course_name
    ORDER BY COUNT(DISTINCT COALESCE(round_key, round_id::text)) DESC
    LIMIT 10
  `);

  summary.homeToBookingRate =
    summary.homeViews > 0 ? summary.bookingClicks / summary.homeViews : 0;

  summary.searchToBookingRate =
    summary.searches > 0 ? summary.bookingClicks / summary.searches : 0;

  summary.homePageViews = summary.homeViews;
  summary.courseBookingClicks = summary.bookingClicks;
  summary.conversionHomeToBooking = summary.homeToBookingRate;
  summary.conversionSearchToBooking = summary.searchToBookingRate;
  summary.rounds = summary.roundsPlayed;

  summary.alertsSent7d = 0;
  summary.alertHits7d = 0;
  summary.hitRate7d = 0;
  summary.avgTimeToHitMins = 0;
  summary.alertsByPlan = { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 };
  summary.topAlertCourses = [];

  try {
    summary.alertsSent7d = await count(`
      SELECT COUNT(*)::int AS n
      FROM analytics
      WHERE type = ANY($1::text[])
        AND occurred_at >= NOW() - INTERVAL '7 days'
      __FILTERS__
    `, [ALERT_SENT_TYPES]);

    summary.alertHits7d = await count(`
      SELECT COUNT(*)::int AS n
      FROM analytics
      WHERE type = ANY($1::text[])
        AND occurred_at >= NOW() - INTERVAL '7 days'
      __FILTERS__
    `, [ALERT_HIT_TYPES]);

    summary.hitRate7d =
      summary.alertsSent7d > 0 ? summary.alertHits7d / summary.alertsSent7d : 0;

    summary.avgTimeToHitMins = await getAvgTimeToHitMins7d();
    summary.alertsByPlan = await getAlertsByPlan7d();
    summary.topAlertCourses = await getTopAlertCourses7d(10);
  } catch (e) {
    console.error("⚠️ Alerts analytics failed (ignored):", e?.message || e);
  }

  summary.alertsSent = summary.alertsSent7d;
  summary.alertHits = summary.alertHits7d;
  summary.hitRate = summary.hitRate7d;
  summary.avgTimeToHit = summary.avgTimeToHitMins;

  summary.alertsSent7Days = summary.alertsSent7d;
  summary.alertHits7Days = summary.alertHits7d;
  summary.hitRate7Days = summary.hitRate7d;
  summary.avgTimeToHitMinutes = summary.avgTimeToHitMins;

  summary.alertsByPlan7d = summary.alertsByPlan;
  summary.topAlertCourses7d = summary.topAlertCourses;

  return summary;
}
export async function getTopCourses(limit = 10) {
  await ensureAnalyticsTable();

  const { rows } = await db.query(
    `SELECT course_name AS "courseName", COUNT(*)::int AS "clicks"
     FROM analytics
     WHERE course_name IS NOT NULL
       AND course_name <> ''
       AND type IN ('booking_click','course_booking_click','booking','book_click','course_booking')
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
    `SELECT course_name AS "courseName", COUNT(*)::int AS "searches"
     FROM analytics
     WHERE course_name IS NOT NULL
       AND course_name <> ''
       AND type IN ('search_course','course_search','searched_course')
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
      SUM(CASE WHEN type IN ('search_course','course_search','searched_course') THEN 1 ELSE 0 END)::int AS "searches",
      SUM(CASE WHEN type IN ('booking_click','course_booking_click','booking','book_click','course_booking') THEN 1 ELSE 0 END)::int AS "clicks",
      (
        SUM(CASE WHEN type IN ('search_course','course_search','searched_course') THEN 1 ELSE 0 END) * 2
        + SUM(CASE WHEN type IN ('booking_click','course_booking_click','booking','book_click','course_booking') THEN 1 ELSE 0 END)
      )::int AS "score"
    FROM analytics
    WHERE course_name IS NOT NULL
      AND course_name <> ''
      AND type IN (
        'search_course','course_search','searched_course',
        'booking_click','course_booking_click','booking','book_click','course_booking'
      )
    GROUP BY course_name
    ORDER BY "score" DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows;
}