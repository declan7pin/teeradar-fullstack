// backend/analyticsRoutes.js
import express from "express";
import {
  logAnalyticsEvent,
  getAnalyticsSummary,
  getAllEvents,
  getRegisteredUsers,
  recordRegisteredUser,
  deleteRegisteredUser,
} from "./db/analyticsDb.js";

const router = express.Router();

/**
 * POST /api/analytics/event
 * Body: { type, at?, payload? }
 */
router.post("/event", (req, res) => {
  try {
    const { type, at, payload } = req.body || {};

    if (!type) {
      return res.status(400).json({ error: "Missing event type" });
    }

    logAnalyticsEvent({ type, at, payload });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error logging analytics event", err);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

// shared handler for summary so we can serve both "/" and "/summary"
function handleSummary(req, res) {
  try {
    const s = getAnalyticsSummary();

    const response = {
      // backwards-compatible fields you already use
      homePageViews: s.home_page_views,
      courseBookingClicks: s.booking_clicks,
      searches: s.searches,
      newUsers: s.new_users,
      homeViews: s.home_page_views,
      bookingClicks: s.booking_clicks,
      usersAllTime: s.unique_users,
      usersToday: s.users_today,
      usersWeek: s.users_week,

      // extra fields for new cards/metrics
      users30d: s.users30d,
      returningUsers7d: s.returning_users_7d,
      repeatBookers: s.repeat_bookers,
      peakBookingHour: s.peak_booking_hour,

      topCourses: s.top_courses,
      topSearchedCourses: s.top_searched_courses,
      demandRank: s.demand_rank,
    };

    return res.json(response);
  } catch (err) {
    console.error("Error building analytics summary", err);
    return res.status(500).json({ error: "Failed to load analytics summary" });
  }
}

/**
 * GET /api/analytics
 * Main endpoint used by analytics.html
 */
router.get("/", handleSummary);

/**
 * GET /api/analytics/summary
 * Backwards-compatible alias
 */
router.get("/summary", handleSummary);

/**
 * GET /api/analytics/events
 * For debugging – recent raw events.
 */
router.get("/events", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;
    const events = getAllEvents(limit);
    return res.json({ events });
  } catch (err) {
    console.error("Error fetching analytics events", err);
    return res.status(500).json({ error: "Failed to fetch events" });
  }
});

/**
 * PUT /api/analytics/register-user
 * Call this from your auth flow when someone signs up / logs in.
 * Body: { email }
 */
router.put("/register-user", (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }
    recordRegisteredUser(email);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error recording registered user", err);
    return res.status(500).json({ error: "Failed to record user" });
  }
});

/**
 * GET /api/analytics/users
 * Used by the admin dashboard table (analytics.html).
 */
router.get("/users", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 500;
    const users = getRegisteredUsers(limit);
    return res.json({ users });
  } catch (err) {
    console.error("Error fetching registered users", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

/**
 * DELETE /api/analytics/users/:id
 * Used by the "Delete" button in the admin UI.
 */
router.delete("/users/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid id" });
    }
    deleteRegisteredUser(id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting registered user", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;