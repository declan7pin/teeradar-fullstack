// backend/db/alertsDb.js
import Database from "better-sqlite3";

// Use the same DB file you already use for analytics
const db = new Database("analytics.db");
db.pragma("journal_mode = WAL");

// Create tables automatically if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS availability_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_email TEXT NOT NULL,
    course_id TEXT NOT NULL,
    date TEXT NOT NULL,          -- YYYY-MM-DD
    time_from TEXT NOT NULL,     -- "HH:MM"
    time_to TEXT NOT NULL,       -- "HH:MM"
    group_size INTEGER NOT NULL, -- number of players
    subscription_level INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL,
    tee_time TEXT NOT NULL,      -- "YYYY-MM-DDTHH:MM"
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ----- Helper functions -----

export function createWatch({
  userId,
  userEmail,
  courseId,
  date,
  timeFrom,
  timeTo,
  groupSize,
  subscriptionLevel,
}) {
  const stmt = db.prepare(`
    INSERT INTO availability_watches
      (user_id, user_email, course_id, date, time_from, time_to, group_size, subscription_level, active)
    VALUES
      (@userId, @userEmail, @courseId, @date, @timeFrom, @timeTo, @groupSize, @subscriptionLevel, 1)
  `);

  const info = stmt.run({
    userId,
    userEmail,
    courseId,
    date,
    timeFrom,
    timeTo,
    groupSize,
    subscriptionLevel,
  });

  return info.lastInsertRowid;
}

export function getWatchesForUser(userId) {
  return db
    .prepare(
      `SELECT * FROM availability_watches
       WHERE user_id = ? AND active = 1
       ORDER BY created_at DESC`
    )
    .all(userId);
}

export function countActiveWatchesForUser(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM availability_watches
       WHERE user_id = ? AND active = 1`
    )
    .get(userId);
  return row?.count ?? 0;
}

export function deactivateWatch({ watchId, userId }) {
  return db
    .prepare(
      `UPDATE availability_watches
       SET active = 0
       WHERE id = ? AND user_id = ?`
    )
    .run(watchId, userId);
}

// Used by the worker
export function getAllActiveWatches() {
  return db
    .prepare(
      `SELECT *
       FROM availability_watches
       WHERE active = 1`
    )
    .all();
}

export function getSentTeeTimesForWatch(watchId) {
  return db
    .prepare(
      `SELECT tee_time
       FROM notifications_sent
       WHERE watch_id = ?`
    )
    .all(watchId)
    .map((row) => row.tee_time);
}

export function recordNotificationSent({ watchId, teeTime }) {
  return db
    .prepare(
      `INSERT INTO notifications_sent (watch_id, tee_time)
       VALUES (?, ?)`
    )
    .run(watchId, teeTime);
}