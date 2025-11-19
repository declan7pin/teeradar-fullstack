// backend/analytics.js
//
// Lightweight analytics using sql.js (SQLite compiled to WebAssembly).
// Data is stored in backend/analytics.sqlite so it survives restarts
// on the same Render instance (but will reset on new deploys).

import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, "analytics.sqlite");

let db;
let SQL;

// Initialise sql.js and open/create the DB
const dbReady = (async () => {
  SQL = await initSqlJs({
    locateFile: (file) =>
      path.join(__dirname, "..", "node_modules", "sql.js", "dist", file)
  });

  let fileBuffer = null;
  if (fs.existsSync(DB_FILE)) {
    try {
      fileBuffer = fs.readFileSync(DB_FILE);
      console.log("Analytics DB loaded from file.");
    } catch (err) {
      console.error("Error reading analytics DB, starting fresh:", err.message);
    }
  }

  if (fileBuffer) {
    db = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    db = new SQL.Database();
  }

  // Create table if not exists
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id TEXT,
      course_name TEXT,
      created_at TEXT NOT NULL
    );
  `);

  persistDb();
})();

// Helper to persist DB contents to disk
function persistDb() {
  try {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  } catch (err) {
    console.error("Error persisting analytics DB:", err.message);
  }
}

// Small helper to run a query that returns a single row
function singleRow(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = {};
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// --------- PUBLIC API FUNCTIONS ----------

/**
 * Record a single analytics event.
 * @param {Object} param0
 *   type: "home_view" | "search" | "booking_click" | ...
 *   userId: string | null
 *   courseName: string | null
 *   at: ISO timestamp (optional)
 */
export async function recordEvent({ type, userId, courseName, at }) {
  await dbReady;
  if (!type) return;

  const ts = at || new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO events (type, user_id, course_name, created_at) VALUES (?, ?, ?, ?)"
  );
  stmt.run([type, userId || null, courseName || null, ts]);
  stmt.free();
  persistDb();
}

/**
 * Get summary metrics for the admin dashboard.
 *  - homeViews: total home page views
 *  - searches: total searches
 *  - bookingClicks: total booking clicks
 *  - usersAllTime: distinct users (all events)
 *  - usersToday: distinct users since midnight local time
 *  - usersWeek: distinct users in last 7 days
 *  - newUsers7d: users whose first-ever event was in last 7 days
 */
export async function getAnalyticsSummary() {
  await dbReady;

  const homeViews =
    singleRow(
      "SELECT COUNT(*) AS c FROM events WHERE type = 'home_view';"
    ).c || 0;

  const searches =
    singleRow("SELECT COUNT(*) AS c FROM events WHERE type = 'search';").c ||
    0;

  const bookingClicks =
    singleRow(
      "SELECT COUNT(*) AS c FROM events WHERE type = 'booking_click';"
    ).c || 0;

  const usersAllTime =
    singleRow(
      "SELECT COUNT(DISTINCT user_id) AS c FROM events WHERE user_id IS NOT NULL;"
    ).c || 0;

  const usersToday =
    singleRow(
      `
      SELECT COUNT(DISTINCT user_id) AS c
      FROM events
      WHERE user_id IS NOT NULL
        AND date(created_at, 'localtime') = date('now', 'localtime');
    `
    ).c || 0;

  const usersWeek =
    singleRow(
      `
      SELECT COUNT(DISTINCT user_id) AS c
      FROM events
      WHERE user_id IS NOT NULL
        AND datetime(created_at) >= datetime('now', '-7 days');
    `
    ).c || 0;

  const newUsers7d =
    singleRow(
      `
      SELECT COUNT(*) AS c FROM (
        SELECT user_id, MIN(created_at) AS first_seen
        FROM events
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      )
      WHERE datetime(first_seen) >= datetime('now', '-7 days');
    `
    ).c || 0;

  return {
    homeViews,
    searches,
    bookingClicks,
    usersAllTime,
    usersToday,
    usersWeek,
    newUsers7d
  };
}

/**
 * Get the most-clicked courses for the "Most clicked courses" panel.
 * Returns an array of { courseName, clicks }.
 */
export async function getTopCourses(limit = 5) {
  await dbReady;

  const stmt = db.prepare(
    `
    SELECT course_name AS courseName, COUNT(*) AS clicks
    FROM events
    WHERE type = 'booking_click' AND course_name IS NOT NULL
    GROUP BY course_name
    ORDER BY clicks DESC
    LIMIT ?;
  `
  );
  stmt.bind([limit]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}
