// backend/migrations.js
import db from "./db.js";

function columnExists(table, col) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === col);
  } catch (e) {
    console.error("PRAGMA table_info failed:", table, e);
    return false;
  }
}

export function runMigrations() {
  try {
    // 1) Pending courses submitted by users
    db.prepare(`
      CREATE TABLE IF NOT EXISTS courses_pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        holes INTEGER NOT NULL CHECK (holes IN (9,18)),
        pars_json TEXT,
        dists_json TEXT,
        submitted_by_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT
      )
    `).run();

    // 2) Approved scorecard course templates (global)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS scorecard_courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        holes INTEGER NOT NULL CHECK (holes IN (9,18)),
        pars_json TEXT,
        dists_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, state, holes)
      )
    `).run();

    // 3) Reward tracking columns on users (only add if missing)
    // NOTE: SQLite supports ADD COLUMN, but not IF NOT EXISTS, so we check first.
    if (!columnExists("users", "course_bonus_used")) {
      db.prepare(`ALTER TABLE users ADD COLUMN course_bonus_used INTEGER NOT NULL DEFAULT 0`).run();
    }

    if (!columnExists("users", "basic_free_until")) {
      db.prepare(`ALTER TABLE users ADD COLUMN basic_free_until TEXT`).run();
    }

    console.log("✅ migrations: ok");
  } catch (e) {
    console.error("❌ migrations failed:", e);
  }
}