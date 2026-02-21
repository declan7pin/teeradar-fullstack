// backend/scorecardCourseMigrate.js
export async function ensureScorecardCoursesSchema(db) {
  // 1) pending submissions
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

  // 2) approved global templates
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

  // 3) reward fields on users
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS course_bonus_used INTEGER NOT NULL DEFAULT 0;
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS basic_free_until TIMESTAMPTZ;
  `);
}
