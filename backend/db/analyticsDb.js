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

// 🔹 NEW: simple upsert for registered users by email
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
 * 🔹 NEW: record a registered user's email
 * Call this from your auth/registration flow.
 */
export function recordRegisteredUser(email) {
  if (!email) return;
  const trimmed = String(email).trim().toLowerCase();
  if (!trimmed) return;
  upsertUserStmt.run(trimmed);
}

/**
 * 🔹 NEW: fetch registered users for the admin dashboard
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
 *   top_courses: [{ courseName, clicks }, ...]
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
    top_courses: []
  };

  for (const row of byType) {
    if (row.type === "home_view" || row.type === "home_page_view") {
      summary.home_page_views = row.count;
    } else if (row.type === "booking_click") {
      summary.booking_clicks = row.count;
    } else if (row.type === "search") {
      summary.searches = row.count;
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

  // Top 5 most-clicked courses
  const topCourses = db
    .prepare(
      `SELECT course_name AS courseName, COUNT(*) AS clicks
       FROM analytics_events
       WHERE type = 'booking_click'
         AND course_name IS NOT NULL
         AND course_name <> ''
       GROUP BY course_name
       ORDER BY clicks DESC
       LIMIT 5`
    )
    .all();

  summary.top_courses = topCourses;

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
  // 🔹 NEW exports
  recordRegisteredUser,
  getRegisteredUsers
};