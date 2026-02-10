// backend/roundsMigrate.js
import db from "./db.js";

// Creates tables if they don't exist (safe to run every boot)
export async function ensureRoundsTables() {
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

    -- -----------------------------
    -- SAFE UPGRADES (idempotent)
    -- -----------------------------
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

// -------------------------------------------------
// ✅ NEW: Scorecard templates (approved + pending)
// Enforced at DB level – no bad data can enter
// -------------------------------------------------
export async function ensureScorecardTemplatesTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS scorecard_courses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      holes INTEGER NOT NULL CHECK (holes IN (9,18)),
      pars_json JSONB NOT NULL,
      dists_json JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT now(),
      UNIQUE (name, state, holes)
    );

    CREATE TABLE IF NOT EXISTS courses_pending (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      holes INTEGER NOT NULL CHECK (holes IN (9,18)),
      pars_json JSONB NOT NULL,
      dists_json JSONB NOT NULL,
      submitted_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT now(),
      approved_at TIMESTAMP,
      UNIQUE (name, state, holes)
    );

    -- -----------------------------
    -- HARD VALIDATION CONSTRAINTS
    -- -----------------------------

    -- Arrays only
    ALTER TABLE scorecard_courses
      ADD CONSTRAINT IF NOT EXISTS scorecard_pars_array
      CHECK (jsonb_typeof(pars_json) = 'array'),
      ADD CONSTRAINT IF NOT EXISTS scorecard_dists_array
      CHECK (jsonb_typeof(dists_json) = 'array');

    ALTER TABLE courses_pending
      ADD CONSTRAINT IF NOT EXISTS pending_pars_array
      CHECK (jsonb_typeof(pars_json) = 'array'),
      ADD CONSTRAINT IF NOT EXISTS pending_dists_array
      CHECK (jsonb_typeof(dists_json) = 'array');

    -- Length must match holes
    ALTER TABLE scorecard_courses
      ADD CONSTRAINT IF NOT EXISTS scorecard_length_match
      CHECK (
        jsonb_array_length(pars_json) = holes AND
        jsonb_array_length(dists_json) = holes
      );

    ALTER TABLE courses_pending
      ADD CONSTRAINT IF NOT EXISTS pending_length_match
      CHECK (
        jsonb_array_length(pars_json) = holes AND
        jsonb_array_length(dists_json) = holes
      );
  `;

  try {
    await db.query(sql);
    console.log("✅ Scorecard template tables ready (approved + pending)");
  } catch (err) {
    console.error("❌ Failed creating scorecard template tables:", err);
    throw err;
  }
}