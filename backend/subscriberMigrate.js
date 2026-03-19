// backend/subscriberMigrate.js
import db from "./db.js";

export async function ensureSubscriberStatusSchema() {
  // Main subscriber entitlement table
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriber_status (
      email TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      subscription_id TEXT,

      -- Stripe subscription state
      status TEXT NOT NULL DEFAULT 'inactive',
      plan TEXT NOT NULL DEFAULT 'FREE',
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      canceled_at TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,

      -- App entitlement state
      entitlement_active BOOLEAN NOT NULL DEFAULT FALSE,

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Backfill / evolve older tables safely
  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS subscription_id TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'inactive';
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'FREE';
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS entitlement_active BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_status_idx
      ON subscriber_status(status);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_entitlement_idx
      ON subscriber_status(entitlement_active);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_customer_idx
      ON subscriber_status(stripe_customer_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_subscription_idx
      ON subscriber_status(subscription_id);
  `);

  // Normalize any older rows so expired/cancelled users do not keep access
  await db.query(`
    UPDATE subscriber_status
    SET
      entitlement_active = CASE
        WHEN LOWER(COALESCE(status, '')) IN ('active', 'trialing')
         AND current_period_end IS NOT NULL
         AND current_period_end > NOW()
        THEN TRUE
        ELSE FALSE
      END,
      plan = CASE
        WHEN LOWER(COALESCE(status, '')) IN ('active', 'trialing')
         AND current_period_end IS NOT NULL
         AND current_period_end > NOW()
         AND UPPER(COALESCE(plan, 'FREE')) IN ('BASIC', 'PRO')
        THEN UPPER(plan)
        ELSE 'FREE'
      END,
      updated_at = NOW();
  `);
}