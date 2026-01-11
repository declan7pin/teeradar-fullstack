// backend/bookingMigrate.js
export async function ensureBookingAddonsSchema(db) {
  const sql = `
    -- ===== Courses (inventory + pricing) =====
    ALTER TABLE booking_courses
      ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0;

    -- ===== Online bookings =====
    ALTER TABLE booking_bookings
      ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cart_fee_cents INTEGER NOT NULL DEFAULT 0,

      ADD COLUMN IF NOT EXISTS has_hire_clubs BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hire_clubs_fee_cents INTEGER NOT NULL DEFAULT 0,

      ADD COLUMN IF NOT EXISTS total_cents INTEGER NOT NULL DEFAULT 0;

    -- ===== Manual slots (already mostly exist, but safe) =====
    ALTER TABLE booking_manual_slots
      ADD COLUMN IF NOT EXISTS cart_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hire_clubs_qty INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS has_cart BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS has_hire_clubs BOOLEAN NOT NULL DEFAULT false;
  `;

  await db.query(sql);
}