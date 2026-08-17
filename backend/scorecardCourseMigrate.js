// backend/scorecardCourseMigrate.js

export async function ensureScorecardCoursesSchema(db) {
  // =========================================================
  // 1) Pending course submissions
  // =========================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS courses_pending (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      holes INTEGER NOT NULL CHECK (holes IN (9,18)),
      pars_json JSONB,
      dists_json JSONB,
      submitted_by_user_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      approved_at TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS courses_pending_approved_idx
    ON courses_pending (approved_at);
  `);

  // Keep the SAME field names already used by roundsRoutes.js
  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS course_rating NUMERIC(4,1);
  `);

  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS slope_rating INTEGER;
  `);

  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS tee_colour TEXT;
  `);

  // =========================================================
  // 2) Approved scorecard templates
  // =========================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS scorecard_courses (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      holes INTEGER NOT NULL CHECK (holes IN (9,18)),
      pars_json JSONB,
      dists_json JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(name, state, holes)
    );
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS course_rating NUMERIC(4,1);
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS slope_rating INTEGER;
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS tee_colour TEXT;
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS green_points_json JSONB DEFAULT '[]'::jsonb;
  `);

  // =========================================================
  // 3) Helpful indexes
  // =========================================================
  await db.query(`
    CREATE INDEX IF NOT EXISTS scorecard_courses_state_idx
    ON scorecard_courses (state);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS scorecard_courses_name_idx
    ON scorecard_courses (name);
  `);

  // =========================================================
  // 4) Reward fields
  // =========================================================
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS course_bonus_used INTEGER NOT NULL DEFAULT 0;
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS basic_free_until TIMESTAMPTZ;
  `);
}