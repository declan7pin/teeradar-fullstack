// backend/analytics.js
// Postgres-based analytics storage

import db from "./db.js";

let initPromise = null;

// Ensure the analytics table exists (run once)
async function ensureAnalyticsTable() {
  if (initPromise) return initPromise;

  initPromise = db.query(`
    CREATE TABLE IF NOT EXISTS analytics (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL,
      user_id     TEXT,
      course_name TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return initPromise;
}

/**
 * Record an analytics event into Postgres.
 *
 * type:        "home_view" | "search" | "booking_click" | "course_booking_click"
 * userId:      string (IP or generated ID)
 * courseName:  string (optional)
 * at:          timestamp string
 */
export async function recordEvent({ type, userId, courseName, at }) {
  try {
    await ensureAnalyticsTable();

    const timestamp = at || new Date().toISOString();

    await db.query(
      `INSERT INTO analytics (type, user_id, course_name, occurred_at)
       VALUES ($1, $2, $3, $4)`,
      [type, userId || null, courseName || null, timestamp]
    );
  } catch (err) {
    console.error("Postgres analytics insert failed:", err);
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