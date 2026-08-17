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

      rating NUMERIC(4,1),
      slope INTEGER,
      tee TEXT DEFAULT 'White',

      submitted_by_user_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      approved_at TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS courses_pending_approved_idx
    ON courses_pending (approved_at);
  `);

  // Add newer fields to existing installs
  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS rating NUMERIC(4,1);
  `);

  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS slope INTEGER;
  `);

  await db.query(`
    ALTER TABLE courses_pending
    ADD COLUMN IF NOT EXISTS tee TEXT DEFAULT 'White';
  `);


  // =========================================================
  // 2) Approved global scorecard templates
  // =========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS scorecard_courses (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      holes INTEGER NOT NULL CHECK (holes IN (9,18)),

      pars_json JSONB,
      dists_json JSONB,

      rating NUMERIC(4,1),
      slope INTEGER,
      tee TEXT DEFAULT 'White',

      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),

      UNIQUE(name, state, holes)
    );
  `);

  // Add fields safely to existing database
  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS rating NUMERIC(4,1);
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS slope INTEGER;
  `);

  await db.query(`
    ALTER TABLE scorecard_courses
    ADD COLUMN IF NOT EXISTS tee TEXT DEFAULT 'White';
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
  // 4) Reward fields on users
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