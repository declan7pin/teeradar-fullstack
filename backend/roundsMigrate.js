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

    -- ✅ MIGRATIONS / SAFE UPGRADES
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

  try {
    await db.query(sql);
    console.log("✅ Rounds tables ready (rounds, round_holes)");
  } catch (err) {
    console.error("❌ Failed creating rounds tables:", err);
    throw err;
  }
}

/**
 * ✅ NEW: Scorecard template + pending + contribution history tables
 * - No duplicates (pending + approved)
 * - Contributor history auto-linked
 */
export async function ensureScorecardTemplatesTables() {
  // prevent two instances racing on boot
  const LOCK_KEY = 246813579;

  try {
    const lockRes = await db.query("SELECT pg_try_advisory_lock($1) AS locked;", [LOCK_KEY]);
    if (!lockRes.rows?.[0]?.locked) {
      console.log("ℹ️ scorecard template migration: another instance is running it");
      return;
    }

    const sql = `
      -- Approved templates (global)
      CREATE TABLE IF NOT EXISTS scorecard_courses (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,        -- normalized lower-case name stored by app
        state TEXT NOT NULL,       -- e.g. 'WA'
        holes INTEGER NOT NULL,    -- 9 or 18
        pars_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        dists_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (name, state, holes)
      );

      CREATE INDEX IF NOT EXISTS scorecard_courses_state_idx
        ON scorecard_courses (state);

      -- ✅ enforce case-insensitive uniqueness too (belt + braces)
      CREATE UNIQUE INDEX IF NOT EXISTS scorecard_courses_uq_lower
        ON scorecard_courses (LOWER(name), state, holes);

      -- Pending submissions awaiting approval
      CREATE TABLE IF NOT EXISTS courses_pending (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,        -- normalized lower-case name stored by app
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

      CREATE INDEX IF NOT EXISTS courses_pending_state_idx
        ON courses_pending (state);

      CREATE INDEX IF NOT EXISTS courses_pending_created_idx
        ON courses_pending (created_at DESC);

      -- ✅ No duplicate *open* pending records for same course/state/holes
      CREATE UNIQUE INDEX IF NOT EXISTS courses_pending_uq_open
        ON courses_pending (name, state, holes)
        WHERE approved_at IS NULL AND rejected_at IS NULL;

      -- Contributor history (submission/approval/rejection audit log)
      CREATE TABLE IF NOT EXISTS scorecard_course_contributions (
        id BIGSERIAL PRIMARY KEY,

        action TEXT NOT NULL, -- 'SUBMITTED' | 'APPROVED' | 'REJECTED'
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
        ON scorecard_course_contributions (state, name, holes, created_at DESC);

      -- ✅ helps auto-link contributor history lookups (case-insensitive)
      CREATE INDEX IF NOT EXISTS scorecard_contrib_course_idx
        ON scorecard_course_contributions (LOWER(name), state, holes);

      -- ✅ Safe upgrades if you already had older versions
      ALTER TABLE courses_pending
        ADD COLUMN IF NOT EXISTS submitted_by_email TEXT;

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

      ALTER TABLE scorecard_courses
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

      ALTER TABLE scorecard_courses
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    `;

    await db.query(sql);
    console.log("✅ scorecard templates tables ready (scorecard_courses, courses_pending, contributions)");
  } catch (err) {
    console.error("❌ Failed creating scorecard template tables:", err);
    throw err;
  } finally {
    try { await db.query("SELECT pg_advisory_unlock($1);", [LOCK_KEY]); } catch {}
  }
}