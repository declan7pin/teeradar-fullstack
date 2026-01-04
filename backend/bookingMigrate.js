// backend/bookingMigrate.js
export async function ensureBookingAddonsSchema(db) {
  // db must expose db.query(sql, params)
  const sql = `
    ALTER TABLE booking_courses
      ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS clubs_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS clubs_qty INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS add_cart BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS add_clubs BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS clubs_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS addons_total_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0;
  `;
  await db.query(sql);
}