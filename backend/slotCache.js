// backend/slotCache.js
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

// Create NEW cache file (forces reset)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 💥 IMPORTANT: NEW CACHE FILE (forces a clean rebuild)
const DB_FILE = path.join(__dirname, "slotCache_v3.db");

const db = new Database(DB_FILE);

// NOTE: courseId is already state-aware (e.g. "WA::123" or "QLD::CourseName")
// This is handled in server.js when building the courseId.

// Create tables if missing
db.exec(`
  CREATE TABLE IF NOT EXISTS slot_cache (
    courseId TEXT,
    date TEXT,
    holes INTEGER,
    partySize INTEGER,
    earliest TEXT,
    latest TEXT,
    provider TEXT,
    slots TEXT,
    updatedAt INTEGER,
    PRIMARY KEY(courseId, date, holes, partySize, earliest, latest)
  );
`);

// Cached slot lifetime: 10 minutes
const CACHE_TTL_MS = 10 * 60 * 1000;

// -------------------------------
// GET cached result
// -------------------------------
export function getCachedSlots({
  courseId,
  date,
  holes,
  partySize,
  earliest,
  latest,
}) {
  const row = db
    .prepare(
      `SELECT slots, updatedAt FROM slot_cache
       WHERE courseId=? AND date=? AND holes IS ? AND partySize=? AND earliest=? AND latest=?`
    )
    .get(courseId, date, holes, partySize, earliest, latest);

  if (!row) return null;

  const age = Date.now() - row.updatedAt;
  if (age > CACHE_TTL_MS) {
    return null; // expired
  }

  try {
    return JSON.parse(row.slots);
  } catch {
    return null;
  }
}

// -------------------------------
// SAVE scraped result to cache
// -------------------------------
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
  db.prepare(
    `INSERT OR REPLACE INTO slot_cache
    (courseId, date, holes, partySize, earliest, latest, provider, slots, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    courseId,
    date,
    holes,
    partySize,
    earliest,
    latest,
    provider,
    JSON.stringify(slots || []),
    Date.now()
  );
}

export default db;