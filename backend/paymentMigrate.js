// backend/paymentMigrate.js
import db from "./db.js";

export async function ensureCoursePaymentModeSchema() {
  // ✅ Adjust this if your courses table name differs
  const COURSES_TABLE = "booking_courses";

  // 1) Add column (safe if already exists)
  await db.query(`
    ALTER TABLE ${COURSES_TABLE}
    ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'pay_at_course'
  `);

  // 2) Add CHECK constraint (only if it doesn't exist)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'booking_courses_payment_mode_check'
      ) THEN
        ALTER TABLE ${COURSES_TABLE}
        ADD CONSTRAINT booking_courses_payment_mode_check
        CHECK (payment_mode IN ('pay_at_course','pay_now'));
      END IF;
    END $$;
  `);

  console.log("✅ ensureCoursePaymentModeSchema ok");
}