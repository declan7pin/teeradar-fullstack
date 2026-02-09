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
// Normalizers (keeps cache keys consistent)
// -------------------------------
function normInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normPartySize(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function normHHMM(t, fallback) {
  const s = String(t || "").trim();
  if (!s) return fallback;
  const parts = s.split(":");
  if (parts.length < 2) return fallback;
  const hh = String(parts[0] || "").padStart(2, "0");
  const mm = String(parts[1] || "").padStart(2, "0");
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mm)) return fallback;
  return `${hh}:${mm}`;
}

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
  const h = Number.isFinite(Number(holes)) ? Number(holes) : null;
  const ps = normPartySize(partySize);
  const e = normHHMM(earliest, "06:00");
  const l = normHHMM(latest, "17:00");

  const row = db
    .prepare(
      `SELECT slots, updatedAt FROM slot_cache
       WHERE courseId=? AND date=? AND holes IS ? AND partySize=? AND earliest=? AND latest=?`
    )
    .get(courseId, date, h, ps, e, l);

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
  const h = Number.isFinite(Number(holes)) ? Number(holes) : null;
  const ps = normPartySize(partySize);
  const e = normHHMM(earliest, "06:00");
  const l = normHHMM(latest, "17:00");

  db.prepare(
    `INSERT OR REPLACE INTO slot_cache
    (courseId, date, holes, partySize, earliest, latest, provider, slots, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    courseId,
    date,
    h,
    ps,
    e,
    l,
    provider,
    JSON.stringify(slots || []),
    Date.now()
  );
}

export default db;