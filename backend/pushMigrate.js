// backend/pushMigrate.js
import db from "./db.js";

export async function ensurePushSubscriptionsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS push_subscriptions_email_idx
      ON push_subscriptions (LOWER(email));
    `);

    console.log("✅ push_subscriptions table ready");
  } catch (err) {
    console.error("❌ error ensuring push_subscriptions table:", err);
  }
}
