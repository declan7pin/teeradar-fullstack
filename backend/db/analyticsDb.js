// backend/db/analyticsDb.js
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Put analytics.db next to courses.json / fee_groups.json in backend/data
const dbPath = path.join(__dirname, "..", "data", "analytics.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Base table
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    at TEXT,
    user_id TEXT,
    course_name TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// In case table existed without newer columns
try { db.exec(`ALTER TABLE analytics_events ADD COLUMN user_id TEXT;`); } catch {}
try { db.exec(`ALTER TABLE analytics_events ADD COLUMN course_name TEXT;`); } catch {}
try { db.exec(`ALTER TABLE analytics_events ADD COLUMN payload_json TEXT;`); } catch {}

// 🔹 NEW: table to hold registered users / emails
db.exec(`
  CREATE TABLE IF NOT EXISTS registered_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO analytics_events (type, at, user_id, course_name, payload_json)
  VALUES (@type, @at, @user_id, @course_name, @payload_json)
`);

// 🔹 simple upsert for registered users by email
const upsertUserStmt = db.prepare(`
  INSERT INTO registered_users (email, created_at, last_seen_at)
  VALUES (?, datetime('now'), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

/**
 * Log a single analytics event.
 * We auto-extract:
 *  - userId from payload.userId / payload.user_id / payload.clientId
 *  - courseName from payload.courseName / payload.course
 */
export function logAnalyticsEvent({ type, at, payload }) {
  const safePayload = payload || {};

  const userId =
    safePayload.userId ||
    safePayload.user_id ||
    safePayload.clientId ||
    null;

  const courseName =
    safePayload.courseName ||
    safePayload.course ||
    null;

  const record = {
    type: type || "unknown",
    at: at || new Date().toISOString(),
    user_id: userId,
    course_name: courseName,
    payload_json: JSON.stringify(safePayload)
  };

  insertStmt.run(record);
}

/**
 * Record a registered user's email
 */
export function recordRegisteredUser(email) {
  if (!email) return;
  const trimmed = String(email).trim().toLowerCase();
  if (!trimmed) return;
  upsertUserStmt.run(trimmed);
}

/**
 * Fetch registered users for the admin dashboard
 */
export function getRegisteredUsers(limit = 500) {
  return db
    .prepare(
      `SELECT id, email, created_at, last_seen_at
       FROM registered_users
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Summary used by the admin dashboard.
 *
 * Returns:
 * {
 *   home_page_views,
 *   booking_clicks,
 *   searches,
 *   new_users,
 *   unique_users,
 *   total_events,
 *   users_today,
 *   users_week,
 *   users30d,
 *   returning_users_7d,
 *   top_courses: [{ courseName, clicks }, ...],
 *   top_searched_courses: [{ courseName, searches }, ...],
 *   peak_booking_hour: { hour, clicks } | null,
 *   repeat_bookers,
 *   demand_rank: [{ courseName, searches, clicks, score }, ...]
 * }
 */
export function getAnalyticsSummary() {
  const byType = db
    .prepare(`
      SELECT type, COUNT(*) as count
      FROM analytics_events
      GROUP BY type
    `)
    .all();

  const summary = {
    home_page_views: 0,
    booking_clicks: 0,
    searches: 0,
    new_users: 0,
    unique_users: 0,
    total_events: 0,
    users_today: 0,
    users_week: 0,
    users30d: 0,
    returning_users_7d: 0,
    top_courses: [],
    top_searched_courses: [],
    peak_booking_hour: null,
    repeat_bookers: 0,
    demand_rank: []
  };

  for (const row of byType) {
    if (row.type === "home_view" || row.type === "home_page_view") {
      summary.home_page_views = row.count;
    } else if (
      row.type === "booking_click" ||
      row.type === "course_booking_click"   // 🔹 alias for booking clicks
    ) {
      summary.booking_clicks += row.count;
    } else if (
      row.type === "search" ||
      row.type === "search_course"          // 🔹 alias for course-level search
    ) {
      summary.searches += row.count;
    } else if (row.type === "new_user") {
      summary.new_users = row.count;
    }
    summary.total_events += row.count;
  }

  // Unique users across all events
  const uniqueRow = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as cnt
       FROM analytics_events
       WHERE user_id IS NOT NULL AND user_id <> ''`
    )
    .get();
  summary.unique_users = uniqueRow?.cnt || 0;

  // Distinct users today (DAU)
  const todayRow = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as cnt
       FROM analytics_events
       WHERE user_id IS NOT NULL
         AND user_id <> ''
         AND date(at) = date('now')`
    )
    .get();
  summary.users_today = todayRow?.cnt || 0;

  // Distinct users in the last 7 days (WAU)
  const weekRow = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as cnt
       FROM analytics_events
       WHERE user_id IS NOT NULL
         AND user_id <> ''
         AND datetime(at) >= datetime('now', '-6 days')`
    )
    .get();
  summary.users_week = weekRow?.cnt || 0;

  // Distinct users in the last 30 days (MAU-ish)
  const last30Row = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as cnt
       FROM analytics_events
       WHERE user_id IS NOT NULL
         AND user_id <> ''
         AND datetime(at) >= datetime('now', '-30 days')`
    )
    .get();
  summary.users30d = last30Row?.cnt || 0;

  // Returning users in the last 7 days:
  // users with events in last 7 days AND also before that
  const returningRow = db
    .prepare(
      `
      WITH recent AS (
        SELECT DISTINCT user_id
        FROM analytics_events
        WHERE user_id IS NOT NULL
          AND user_id <> ''
          AND datetime(at) >= datetime('now', '-7 days')
      ),
      earlier AS (
        SELECT DISTINCT user_id
        FROM analytics_events
        WHERE user_id IS NOT NULL
          AND user_id <> ''
          AND datetime(at) < datetime('now', '-7 days')
      )
      SELECT COUNT(*) AS cnt
      FROM recent
      JOIN earlier USING (user_id)
      `
    )
    .get();
  summary.returning_users_7d = returningRow?.cnt || 0;

  // Top 5 most-clicked courses (booking_click + course_booking_click)
  const topCourses = db
    .prepare(
      `SELECT course_name AS courseName, COUNT(*) AS clicks
       FROM analytics_events
       WHERE type IN ('booking_click','course_booking_click')
         AND course_name IS NOT NULL
         AND course_name <> ''
       GROUP BY course_name
       ORDER BY clicks DESC
       LIMIT 5`
    )
    .all();
  summary.top_courses = topCourses;

  // Top 5 most-searched courses (course-level search)
  const topSearchedCourses = db
    .prepare(
      `SELECT course_name AS courseName, COUNT(*) AS searches
       FROM analytics_events
       WHERE type = 'search_course'
         AND course_name IS NOT NULL
         AND course_name <> ''
       GROUP BY course_name
       ORDER BY searches DESC
       LIMIT 5`
    )
    .all();
  summary.top_searched_courses = topSearchedCourses;

  // Peak booking hour (booking_click + course_booking_click)
  const peakHourRow = db
    .prepare(
      `SELECT strftime('%H', at) AS hour, COUNT(*) AS clicks
       FROM analytics_events
       WHERE type IN ('booking_click','course_booking_click')
       GROUP BY hour
       ORDER BY clicks DESC
       LIMIT 1`
    )
    .get();
  summary.peak_booking_hour = peakHourRow
    ? { hour: peakHourRow.hour, clicks: peakHourRow.clicks }
    : null;

  // Repeat bookers: users with >1 booking_click / course_booking_click
  const repeatRow = db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT user_id
        FROM analytics_events
        WHERE type IN ('booking_click','course_booking_click')
          AND user_id IS NOT NULL
          AND user_id <> ''
        GROUP BY user_id
        HAVING COUNT(*) > 1
      )
      `
    )
    .get();
  summary.repeat_bookers = repeatRow?.cnt || 0;

  // Course demand ranking (searches * 2 + clicks)
  const demandRows = db
    .prepare(
      `
      SELECT
        course_name AS courseName,
        SUM(
          CASE
            WHEN type IN ('search','search_course') THEN 1
            ELSE 0
          END
        ) AS searches,
        SUM(
          CASE
            WHEN type IN ('booking_click','course_booking_click') THEN 1
            ELSE 0
          END
        ) AS clicks,
        (
          SUM(
            CASE
              WHEN type IN ('search','search_course') THEN 1
              ELSE 0
            END
          ) * 2
          +
          SUM(
            CASE
              WHEN type IN ('booking_click','course_booking_click') THEN 1
              ELSE 0
            END
          )
        ) AS score
      FROM analytics_events
      WHERE course_name IS NOT NULL
        AND course_name <> ''
        AND type IN (
          'search','search_course',
          'booking_click','course_booking_click'
        )
      GROUP BY course_name
      ORDER BY score DESC
      LIMIT 5
      `
    )
    .all();
  summary.demand_rank = demandRows;

  return summary;
}

/**
 * For debugging in the UI.
 */
export function getAllEvents(limit = 200) {
  return db
    .prepare(
      `SELECT *
       FROM analytics_events
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit);
}

export default {
  logAnalyticsEvent,
  getAnalyticsSummary,
  getAllEvents,
  recordRegisteredUser,
  getRegisteredUsers
};