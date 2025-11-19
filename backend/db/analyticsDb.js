// backend/db/analyticsDb.js
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// analytics.db will live in backend/data/
const dbPath = path.join(__dirname, "..", "data", "analytics.db");

// Open / create DB
const db = new Database(dbPath);

// Better concurrent safety
db.pragma("journal_mode = WAL");

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    at TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO analytics_events (type, at, payload_json)
  VALUES (@type, @at, @payload_json)
`);

/**
 * Store a single analytics event.
 * Called from /api/analytics/event in server.js
 */
export function logAnalyticsEvent({ type, at, payload }) {
  try {
    insertStmt.run({
      type: type || null,
      at: at || new Date().toISOString(),
      payload_json: payload ? JSON.stringify(payload) : null
    });
  } catch (err) {
    console.error("Failed to write analytics event to DB:", err.message);
  }
}

export default {
  logAnalyticsEvent
};
