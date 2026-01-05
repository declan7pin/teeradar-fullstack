// backend/bookingTemplateMigrate.js
export async function ensureBookingTemplateSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_time_templates (
      course_id INTEGER PRIMARY KEY
        REFERENCES booking_courses(id)
        ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Australia/Perth',
      template JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // helpful index if you ever query by updated time
  await db.query(`
    CREATE INDEX IF NOT EXISTS booking_time_templates_updated_idx
    ON booking_time_templates (updated_at DESC);
  `);
}