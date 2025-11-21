// backend/slotCache.js
import db from "./db.js";

const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function getCachedSlots({
  courseId,
  date,
  holes,
  partySize,
}) {
  const stmt = db.prepare(`
    SELECT payload_json, scraped_at
    FROM slots
    WHERE course_id = ?
      AND date = ?
      AND (holes IS NULL OR holes = ?)
      AND (party_size IS NULL OR party_size = ?)
    ORDER BY scraped_at DESC
    LIMIT 1
  `);

  const row = stmt.get(
    String(courseId),
    date,
    holes || null,
    partySize || null
  );

  if (!row) return null;

  const age = Date.now() - row.scraped_at;
  if (age > MAX_AGE_MS) return null;

  try {
    return JSON.parse(row.payload_json);
  } catch (err) {
    console.error("Failed to parse cached payload_json", err);
    return null;
  }
}

export function saveSlotsToCache({
  courseId,
  courseName,
  provider,
  date,
  holes,
  partySize,
  earliest,
  latest,
  slots,
}) {
  const stmt = db.prepare(`
    INSERT INTO slots
      (course_id, course_name, provider,
       date, holes, party_size,
       earliest, latest,
       scraped_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    String(courseId),
    courseName,
    provider || null,
    date,
    holes || null,
    partySize || null,
    earliest || null,
    latest || null,
    Date.now(),
    JSON.stringify(slots || [])
  );
}
