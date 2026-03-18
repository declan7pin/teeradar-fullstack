// backend/groupVotesMigrate.js
export async function ensureGroupVotesTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS group_votes (
      id BIGSERIAL PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      creator_user_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active | closed | booked | cancelled
      expires_at TIMESTAMPTZ,
      selected_option_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS group_vote_options (
      id BIGSERIAL PRIMARY KEY,
      vote_id BIGINT NOT NULL REFERENCES group_votes(id) ON DELETE CASCADE,
      course_id BIGINT,
      course_name TEXT NOT NULL,
      course_slug TEXT,
      display_name TEXT,
      option_label TEXT,
      play_date DATE NOT NULL,
      tee_time TEXT NOT NULL,
      holes INTEGER NOT NULL DEFAULT 18,
      players INTEGER NOT NULL DEFAULT 4,
      booking_url TEXT,
      option_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ✅ Safe adds for existing DBs
  await db.query(`
    ALTER TABLE group_vote_options
    ADD COLUMN IF NOT EXISTS display_name TEXT;
  `);

  await db.query(`
    ALTER TABLE group_vote_options
    ADD COLUMN IF NOT EXISTS option_label TEXT;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS group_vote_responses (
      id BIGSERIAL PRIMARY KEY,
      vote_id BIGINT NOT NULL REFERENCES group_votes(id) ON DELETE CASCADE,
      option_id BIGINT NOT NULL REFERENCES group_vote_options(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (vote_id, option_id, user_id)
    );
  `);

  // ✅ Migrate old single-vote uniqueness to multi-vote uniqueness
  await db.query(`
    DO $$
    DECLARE constraint_name text;
    BEGIN
      SELECT tc.constraint_name
      INTO constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'group_vote_responses'
        AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name
      HAVING array_agg(kcu.column_name ORDER BY kcu.column_name) = ARRAY['user_id','vote_id'];

      IF constraint_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE group_vote_responses DROP CONSTRAINT ' || quote_ident(constraint_name);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_vote_responses_vote_option_user_unique
    ON group_vote_responses(vote_id, option_id, user_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_votes_creator
    ON group_votes(creator_user_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_votes_public_id
    ON group_votes(public_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_options_vote_id
    ON group_vote_options(vote_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_options_display_name
    ON group_vote_options(display_name);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_options_option_label
    ON group_vote_options(option_label);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_responses_vote_id
    ON group_vote_responses(vote_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_responses_option_id
    ON group_vote_responses(option_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_group_vote_responses_user_id
    ON group_vote_responses(user_id);
  `);

  // add FK after both tables exist
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_group_votes_selected_option'
      ) THEN
        ALTER TABLE group_votes
        ADD CONSTRAINT fk_group_votes_selected_option
        FOREIGN KEY (selected_option_id)
        REFERENCES group_vote_options(id)
        ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  // keep updated_at fresh
  await db.query(`
    CREATE OR REPLACE FUNCTION set_group_votes_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.query(`
    DROP TRIGGER IF EXISTS trg_group_votes_updated_at ON group_votes;
    CREATE TRIGGER trg_group_votes_updated_at
    BEFORE UPDATE ON group_votes
    FOR EACH ROW
    EXECUTE FUNCTION set_group_votes_updated_at();
  `);

  await db.query(`
    DROP TRIGGER IF EXISTS trg_group_vote_responses_updated_at ON group_vote_responses;
    CREATE TRIGGER trg_group_vote_responses_updated_at
    BEFORE UPDATE ON group_vote_responses
    FOR EACH ROW
    EXECUTE FUNCTION set_group_votes_updated_at();
  `);

  console.log("✅ group vote tables ready");
}