// backend/analytics.js
import db from "./db.js";

/**
 * Record an analytics event into SQLite.
 * 
 * type:        "home_view" | "search" | "booking_click" | "course_booking_click"
 * userId:      string (IP or generated ID)
 * courseName:  string (optional)
 * at:          timestamp string
 */
export async function recordEvent({ type, userId, courseName, at }) {
  try {
    const timestamp = at || new Date().toISOString();
    await db.run(
      `INSERT INTO analytics (type, user_id, course_name, timestamp)
       VALUES (?, ?, ?, ?)`,
      type,
      userId || null,
      courseName || null,
      timestamp
    );
  } catch (err) {
    console.error("SQLite analytics insert failed:", err);
  }
}

/**
 * Return a summary of key metrics.
 */
export async function getAnalyticsSummary() {
  const summary = {};

  summary.homeViews = Number(
    (await db.get(
      `SELECT COUNT(*) AS n FROM analytics WHERE type = "home_view"`
    ))?.n || 0
  );

  summary.bookingClicks = Number(
    (await db.get(
      `SELECT COUNT(*) AS n FROM analytics WHERE type IN ("booking_click","course_booking_click")`
    ))?.n || 0
  );

  summary.searches = Number(
    (await db.get(
      `SELECT COUNT(*) AS n FROM analytics WHERE type = "search"`
    ))?.n || 0
  );

  // Unique active users (7 days)
  summary.newUsers7d = Number(
    (await db.get(
      `SELECT COUNT(DISTINCT user_id) AS n
       FROM analytics
       WHERE timestamp >= datetime('now','-7 days')`
    ))?.n || 0
  );

  // All-time users
  summary.usersAllTime = Number(
    (await db.get(
      `SELECT COUNT(DISTINCT user_id) AS n FROM analytics`
    ))?.n || 0
  );

  // Today users
  summary.usersToday = Number(
    (await db.get(
      `SELECT COUNT(DISTINCT user_id) AS n
       FROM analytics
       WHERE date(timestamp) = date('now')`
    ))?.n || 0
  );

  // This week users
  summary.usersWeek = Number(
    (await db.get(
      `SELECT COUNT(DISTINCT user_id) AS n
       FROM analytics
       WHERE timestamp >= datetime('now','-6 days')`
    ))?.n || 0
  );

  return summary;
}

/**
 * Return top courses by click count.
 */
export async function getTopCourses(limit = 10) {
  return await db.all(
    `SELECT course_name AS courseName,
            COUNT(*) AS clicks
     FROM analytics
     WHERE course_name IS NOT NULL
       AND type IN ("booking_click","course_booking_click")
     GROUP BY course_name
     ORDER BY clicks DESC
     LIMIT ?`,
    limit
  );
}