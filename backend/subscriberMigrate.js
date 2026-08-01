// backend/subscriberMigrate.js
import db from "./db.js";

export async function ensureSubscriberStatusSchema() {
  // Main subscriber entitlement table
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriber_status (
      email TEXT PRIMARY KEY,

      -- Stripe identifiers
      stripe_customer_id TEXT,
      subscription_id TEXT,

      -- Shared subscription state
      status TEXT NOT NULL DEFAULT 'inactive',
      plan TEXT NOT NULL DEFAULT 'FREE',
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      canceled_at TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,

      -- App entitlement state
      entitlement_active BOOLEAN NOT NULL DEFAULT FALSE,

      -- Payment provider
      payment_provider TEXT NOT NULL DEFAULT 'stripe',

      -- Apple subscription identifiers
      apple_original_transaction_id TEXT,
      apple_transaction_id TEXT,
      apple_product_id TEXT,
      apple_environment TEXT,

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

  // Apple / Stripe payment provider support
  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'stripe';
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS apple_transaction_id TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS apple_product_id TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS apple_environment TEXT;
  `);

  await db.query(`
    ALTER TABLE subscriber_status
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Existing indexes
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

  // Apple subscription indexes
  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_payment_provider_idx
      ON subscriber_status(payment_provider);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_apple_original_transaction_idx
      ON subscriber_status(apple_original_transaction_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_apple_transaction_idx
      ON subscriber_status(apple_transaction_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_apple_product_idx
      ON subscriber_status(apple_product_id);
  `);

  // Upcoming rounds timezone support
  await db.query(`
    ALTER TABLE upcoming_rounds
    ADD COLUMN IF NOT EXISTS timezone TEXT;
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

      payment_provider = CASE
        WHEN apple_original_transaction_id IS NOT NULL
          OR apple_transaction_id IS NOT NULL
        THEN 'apple'
        ELSE COALESCE(NULLIF(payment_provider, ''), 'stripe')
      END,

      updated_at = NOW();
  `);
}
