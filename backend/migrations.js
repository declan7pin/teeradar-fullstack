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

    // 3) Friend requests / friends system
    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        requester_user_id INTEGER NOT NULL,
        addressee_user_id INTEGER NOT NULL,

        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'blocked')),

        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_at TEXT,

        CHECK (requester_user_id <> addressee_user_id),
        UNIQUE(requester_user_id, addressee_user_id)
      )
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_requester
      ON user_friends (requester_user_id)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_addressee
      ON user_friends (addressee_user_id)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_friends_status
      ON user_friends (status)
    `).run();

    // 4) Reward tracking columns on users (only add if missing)
    // NOTE: SQLite supports ADD COLUMN, but not IF NOT EXISTS, so we check first.
    if (!columnExists("users", "course_bonus_used")) {
      db.prepare(`ALTER TABLE users ADD COLUMN course_bonus_used INTEGER NOT NULL DEFAULT 0`).run();
    }

    if (!columnExists("users", "basic_free_until")) {
      db.prepare(`ALTER TABLE users ADD COLUMN basic_free_until TEXT`).run();
    }

    // 5) TeeRadar Handicap columns on users
    if (!columnExists("users", "teeradar_handicap")) {
      db.prepare(`ALTER TABLE users ADD COLUMN teeradar_handicap REAL`).run();
    }

    if (!columnExists("users", "teeradar_handicap_status")) {
      db.prepare(`
        ALTER TABLE users
        ADD COLUMN teeradar_handicap_status TEXT NOT NULL DEFAULT 'provisional'
      `).run();
    }

    if (!columnExists("users", "teeradar_handicap_rounds")) {
      db.prepare(`
        ALTER TABLE users
        ADD COLUMN teeradar_handicap_rounds INTEGER NOT NULL DEFAULT 0
      `).run();
    }

    if (!columnExists("users", "teeradar_handicap_trend")) {
      db.prepare(`ALTER TABLE users ADD COLUMN teeradar_handicap_trend REAL`).run();
    }

    if (!columnExists("users", "teeradar_handicap_updated_at")) {
      db.prepare(`ALTER TABLE users ADD COLUMN teeradar_handicap_updated_at TEXT`).run();
    }

    // 6) Mobile push notification tokens
    db.prepare(`
      CREATE TABLE IF NOT EXISTS mobile_push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_mobile_push_email
      ON mobile_push_tokens (email)
    `).run();

    console.log("✅ migrations: ok");
  } catch (e) {
    console.error("❌ migrations failed:", e);
  }
}
