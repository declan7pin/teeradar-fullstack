// backend/db.js
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "slots.db");

// Ensure data directory exists
import fs from "fs";
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Open SQLite DB
const db = new Database(dbPath);

// Make writes safer
db.pragma("journal_mode = WAL");

// Create table + index if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id   TEXT NOT NULL,
    course_name TEXT NOT NULL,
    provider    TEXT,
    date        TEXT NOT NULL,
    holes       INTEGER,
    party_size  INTEGER,
    earliest    TEXT,
    latest      TEXT,
    scraped_at  INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_slots_key
    ON slots (course_id, date, holes, party_size);
`);

export default db;