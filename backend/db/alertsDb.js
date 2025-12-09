// backend/db/alertsDb.js
import pkg from "pg";

const { Pool } = pkg;

// If you already have a shared Pool somewhere (e.g. ./pool.js),
// you can replace this with: `import pool from "./pool.js";`
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
});

// ------- Core helpers --------

export async function createWatch({
  userId,
  userEmail,
  courseId,
  date, // 'YYYY-MM-DD'
  timeFrom, // 'HH:MM'
  timeTo, // 'HH:MM'
  groupSize,
  subscriptionLevel,
}) {
  const query = `
    INSERT INTO availability_watches
      (user_id, user_email, course_id, date, time_from, time_to, group_size, subscription_level, active)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
    RETURNING id;
  `;

  const values = [
    userId,
    userEmail,
    courseId,
    date,
    timeFrom,
    timeTo,
    groupSize,
    subscriptionLevel,
  ];

  const { rows } = await pool.query(query, values);
  return rows[0].id;
}

export async function getWatchesForUser(userId) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM availability_watches
    WHERE user_id = $1 AND active = TRUE
    ORDER BY created_at DESC;
    `,
    [userId]
  );
  return rows;
}

export async function countActiveWatchesForUser(userId) {
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::INT AS count
    FROM availability_watches
    WHERE user_id = $1 AND active = TRUE;
    `,
    [userId]
  );
  return rows[0]?.count ?? 0;
}

export async function deactivateWatch({ watchId, userId }) {
  await pool.query(
    `
    UPDATE availability_watches
    SET active = FALSE
    WHERE id = $1 AND user_id = $2;
    `,
    [watchId, userId]
  );
}

// ------- Worker helpers --------

export async function getAllActiveWatches() {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM availability_watches
    WHERE active = TRUE;
    `
  );
  return rows;
}

export async function getSentTeeTimesForWatch(watchId) {
  const { rows } = await pool.query(
    `
    SELECT tee_time
    FROM notifications_sent
    WHERE watch_id = $1;
    `,
    [watchId]
  );
  // Return array of ISO strings
  return rows.map((r) => r.tee_time.toISOString());
}

export async function recordNotificationSent({ watchId, teeTime }) {
  // teeTime should be an ISO string or Date
  const teeTimeValue =
    teeTime instanceof Date ? teeTime.toISOString() : teeTime;

  await pool.query(
    `
    INSERT INTO notifications_sent (watch_id, tee_time)
    VALUES ($1, $2);
    `,
    [watchId, teeTimeValue]
  );
}
