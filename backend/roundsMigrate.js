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
      player_names JSONB NOT NULL DEFAULT '[]'::jsonb,

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

    -- Safe upgrades
    ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS players_count INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS player_names JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS distance_m INTEGER;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS strokes_by_player JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE round_holes
      ADD COLUMN IF NOT EXISTS putts_by_player JSONB NOT NULL DEFAULT '{}'::jsonb;
  `;

  await db.query(sql);
  console.log("✅ Rounds tables ready (rounds, round_holes)");
}

/**
 * Scorecard template + pending + contribution history tables
 */
export async function ensureScorecardTemplatesTables() {
  const LOCK_KEY = 246813579;

  const lockRes = await db.query(
    "SELECT pg_try_advisory_lock($1) AS locked;",
    [LOCK_KEY]
  );
  if (!lockRes.rows?.[0]?.locked) {
    console.log("ℹ️ scorecard template migration already running elsewhere");
    return;
  }

  try {
    const sql = `
      -- Approved templates (global)
      CREATE TABLE IF NOT EXISTS scorecard_courses (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        holes INTEGER NOT NULL,
        pars_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        dists_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (name, state, holes)
      );

      CREATE INDEX IF NOT EXISTS scorecard_courses_state_idx
        ON scorecard_courses (state);

      CREATE UNIQUE INDEX IF NOT EXISTS scorecard_courses_uq_lower
        ON scorecard_courses (LOWER(name), state, holes);

      -- Pending submissions
      CREATE TABLE IF NOT EXISTS courses_pending (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        holes INTEGER NOT NULL,
        pars_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        dists_json JSONB NOT NULL DEFAULT '[]'::jsonb,

        submitted_by_user_id INTEGER,
        submitted_by_email TEXT,

        created_at TIMESTAMPTZ DEFAULT now(),
        approved_at TIMESTAMPTZ,
        approved_by_user_id INTEGER,
        approved_by_email TEXT,
        rejected_at TIMESTAMPTZ,
        rejected_by_user_id INTEGER,
        rejected_by_email TEXT,
        reject_reason TEXT
      );

      -- ✅ Safe upgrades (if courses_pending existed before these columns)
      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS submitted_by_user_id INTEGER;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS submitted_by_email TEXT;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS approved_by_email TEXT;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS rejected_by_email TEXT;

      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS reject_reason TEXT;

      CREATE INDEX IF NOT EXISTS courses_pending_state_idx
        ON courses_pending (state);

      CREATE INDEX IF NOT EXISTS courses_pending_created_idx
        ON courses_pending (created_at DESC);

      -- 🔑 ONLY create this AFTER rejected_at exists
      CREATE UNIQUE INDEX IF NOT EXISTS courses_pending_uq_open
        ON courses_pending (name, state, holes)
        WHERE approved_at IS NULL AND rejected_at IS NULL;

      -- Contributor history
      CREATE TABLE IF NOT EXISTS scorecard_course_contributions (
        id BIGSERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        holes INTEGER NOT NULL,

        pending_id BIGINT,
        approved_course_id BIGINT,

        actor_user_id INTEGER,
        actor_email TEXT,

        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS scorecard_contrib_lookup_idx
        ON scorecard_course_contributions (LOWER(name), state, holes, created_at DESC);
    `;

    await db.query(sql);
    console.log("✅ scorecard templates tables ready");
  } finally {
    await db.query("SELECT pg_advisory_unlock($1);", [LOCK_KEY]);
  }
}