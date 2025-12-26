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
  })();

  return initPromise;
}

/**
 * Record an analytics event into Postgres.
 *
 * Supports BOTH:
 *  1) recordEvent({ type, userId, courseName, at, roundId })   (legacy)
 *  2) recordEvent("type", { userId, courseName, at, roundId }) (new)
 */
export async function recordEvent(typeOrObj, payload = {}) {
  try {
    await ensureAnalyticsTable();

    // --- backwards compatible parsing ---
    let type = "";
    let p = {};

    if (typeOrObj && typeof typeOrObj === "object" && !Array.isArray(typeOrObj)) {
      // legacy style: recordEvent({ type, userId, courseName, at, roundId })
      p = typeOrObj || {};
      type = String(p.type || "").trim();
    } else {
      // new style: recordEvent("type", { ... })
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

    const timestamp = at || new Date().toISOString();

    await db.query(
      `INSERT INTO analytics (type, user_id, course_name, occurred_at, round_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        type,
        userId || null,
        courseName || null,
        timestamp,
        Number.isFinite(roundId) ? roundId : null,
      ]
    );
  } catch (err) {
    console.error("Postgres analytics insert failed:", err);
  }
}

/**
 * ✅ NEW: Top played courses based on round_played events
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

  // ----- existing metrics (unchanged) -----

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

  // ✅ NEW: course counts for rounds played
  summary.topPlayedCourses = await getTopPlayedCourses(10);
  summary.topPlayedCourses30d = await getTopPlayedCourses(10, 30);

  // New users last 7 days
  summary.newUsers7d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '7 days'`
  );

  // Also expose as newUsers for your dashboard
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

  // This week (last 7 days including today)
  summary.usersWeek = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= date_trunc('day', NOW()) - INTERVAL '6 days'`
  );

  // ----- new metrics added below -----

  // Distinct users in the last 30 days (for "last month" views)
  summary.users30d = await count(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE occurred_at >= NOW() - INTERVAL '30 days'`
  );

  // Returning users in the last 7 days:
  // users who had activity in the last 7 days AND also before that
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

  // Conversion rates (returned as 0–1 ratios; front-end can multiply by 100 for %)
  summary.homeToBookingRate =
    summary.homeViews > 0 ? summary.bookingClicks / summary.homeViews : 0;

  summary.searchToBookingRate =
    summary.searches > 0 ? summary.bookingClicks / summary.searches : 0;

  // Aliases that the frontend expects
  summary.homePageViews = summary.homeViews;
  summary.courseBookingClicks = summary.bookingClicks;
  summary.conversionHomeToBooking = summary.homeToBookingRate;
  summary.conversionSearchToBooking = summary.searchToBookingRate;

  // Optional alias
  summary.rounds = summary.roundsPlayed;

  // Repeat bookers: users with >1 booking_click / course_booking_click
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

  // Peak booking hour (by booking_click + course_booking_click)
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