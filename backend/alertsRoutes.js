// backend/alertsRoutes.js
import express from "express";
import db from "./db.js";

const router = express.Router();

// ---------------------------------------------------------
// Ensure table exists (same schema as alertWorker.js)
// ---------------------------------------------------------
async function ensureUserAlertHitsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_hits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT NOT NULL,
        provider TEXT,
        date TEXT NOT NULL,              -- 'YYYY-MM-DD'
        holes INTEGER,
        party_size INTEGER,
        earliest TEXT,
        latest TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);
    console.log("✅ user_alert_hits table ready (alertsRoutes)");
  } catch (err) {
    console.error("❌ error ensuring user_alert_hits table (alertsRoutes):", err);
  }
}
ensureUserAlertHitsTable();

// ---------------------------------------------------------
// helper: pull a direct booking URL from slots array (if present)
// ---------------------------------------------------------
function pickBookingUrlFromSlots(slots) {
  try {
    if (!Array.isArray(slots) || !slots.length) return null;
    const s0 = slots[0] || {};
    return (
      s0.url ||
      s0.bookingUrl ||
      s0.bookUrl ||
      s0.link ||
      s0.booking_link ||
      null
    );
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------
// GET /api/alerts/unread?email=...
// Returns unread alert hits (read_at IS NULL) for that user
// ---------------------------------------------------------
router.get("/unread", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    // Return most recent unread hits first (cap to keep payload small)
    const { rows } = await db.query(
      `
      SELECT
        id,
        email,
        course_name,
        provider,
        date,
        holes,
        party_size,
        earliest,
        latest,
        slots,
        created_at
      FROM user_alert_hits
      WHERE email = $1
        AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100;
      `,
      [email]
    );

    // Shape the response to what your index expects
    const hits = rows.map((r) => {
      const slots = r.slots || [];
      const bookingUrl = pickBookingUrlFromSlots(slots);

      return {
        id: r.id,
        email: r.email,
        course_name: r.course_name,
        provider: r.provider,
        date: r.date,
        holes: r.holes,
        party_size: r.party_size,
        earliest: r.earliest,
        latest: r.latest,
        slots,
        bookingUrl, // ✅ NEW: direct booking link for popup button
        created_at: r.created_at,
      };
    });

    res.json({ ok: true, hits });
  } catch (err) {
    console.error("alerts/unread error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ---------------------------------------------------------
// POST /api/alerts/mark-read
// Body: { email, ids: [1,2,3] }
// Marks those hits as read (sets read_at=now())
// ---------------------------------------------------------
router.post("/mark-read", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim().toLowerCase();
    const idsRaw = req.body?.ids;

    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const ids = Array.isArray(idsRaw)
      ? idsRaw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    if (!ids.length) {
      return res.json({ ok: true, updated: 0 });
    }

    const result = await db.query(
      `
      UPDATE user_alert_hits
      SET read_at = now()
      WHERE email = $1
        AND id = ANY($2::int[])
      `,
      [email, ids]
    );

    res.json({ ok: true, updated: result.rowCount || 0 });
  } catch (err) {
    console.error("alerts/mark-read error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;