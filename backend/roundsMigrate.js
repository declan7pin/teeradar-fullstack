// backend/roundsMigrate.js
import db from "./db.js";

// Creates tables if they don't exist (safe to run every boot)
export async function ensureRoundsTables() {
  // If your db.js exposes `db.query`, this will work.
  // If it exposes something different, tell me what `db.js` exports and I’ll adapt.
  const sql = `
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,

      course TEXT NOT NULL,
      layout TEXT,
      state TEXT,

      holes INTEGER NOT NULL,
      par_mode TEXT NOT NULL,
      players_count INTEGER NOT NULL DEFAULT 1,

      created_at TIMESTAMP DEFAULT NOW(),

      CONSTRAINT fk_round_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS round_holes (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL,

      hole_number INTEGER NOT NULL,
      par INTEGER,
      distance_m INTEGER,
      strokes INTEGER,
      putts INTEGER,
      strokes_by_player JSONB NOT NULL DEFAULT '{}'::jsonb,
      putts_by_player JSONB NOT NULL DEFAULT '{}'::jsonb,

      CONSTRAINT fk_round
        FOREIGN KEY (round_id)
        REFERENCES rounds(id)
        ON DELETE CASCADE,

      CONSTRAINT unique_round_hole
        UNIQUE (round_id, hole_number)
    );

    CREATE INDEX IF NOT EXISTS idx_rounds_user
      ON rounds(user_id);

    CREATE INDEX IF NOT EXISTS idx_round_holes_round
      ON round_holes(round_id);

    -- ✅ MIGRATIONS / SAFE UPGRADES (won’t fail if column already exists)
    ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS players_count INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS distance_m INTEGER;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS strokes_by_player JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS putts_by_player JSONB NOT NULL DEFAULT '{}'::jsonb;
  `;

  try {
    await db.query(sql);
    console.log("✅ Rounds tables ready (rounds, round_holes)");
  } catch (err) {
    console.error("❌ Failed creating rounds tables:", err);
    throw err;
  }
}