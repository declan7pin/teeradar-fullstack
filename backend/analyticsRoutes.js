const express = require("express");
const router = express.Router();

// Temporary in-memory storage
const events = [];

// POST /api/analytics/event
router.post("/event", (req, res) => {
  const { type, meta } = req.body || {};

  if (!type) {
    return res.status(400).json({ error: "Missing 'type'" });
  }

  events.push({
    type,
    meta: meta || {},
    createdAt: new Date().toISOString(),
  });

  return res.json({ ok: true });
});

// GET /api/analytics/summary
router.get("/summary", (req, res) => {
  const summary = {
    totalPageViews: 0,
    totalBookingClicks: 0,
    bookingClicksByCourse: {},
  };

  for (const evt of events) {
    if (evt.type === "page_view") summary.totalPageViews++;
    if (evt.type === "booking_click") {
      summary.totalBookingClicks++;
      const c = evt.meta?.courseName || "Unknown course";
      summary.bookingClicksByCourse[c] =
        (summary.bookingClicksByCourse[c] || 0) + 1;
    }
  }

  return res.json(summary);
});

module.exports = router;
