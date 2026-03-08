// backend/subscriberMigrate.js
import db from "./db.js";

export async function ensureSubscriberStatusSchema() {
  // Creates the subscriber_status table used to power automatic 5% discounts
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriber_status (
      email TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      subscription_id TEXT,
      status TEXT NOT NULL,
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS subscriber_status_status_idx
      ON subscriber_status(status);
  `);
}
