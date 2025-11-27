// backend/analyticsRoutes.js
import express from "express";
import analyticsDb from "./db/analyticsDb.js";
import db from "./db.js";

const router = express.Router();

/* ============================================================
   GET — Summary used by analytics.html
   ============================================================ */
router.get("/", (req, res) => {
  try {
    const summary = analyticsDb.getAnalyticsSummary();

    res.json({
      homeViews: summary.home_page_views,
      homePageViews: summary.home_page_views,
      bookingClicks: summary.booking_clicks,
      courseBookingClicks: summary.booking_clicks,
      searches: summary.searches,
      newUsers: summary.new_users,
      usersAllTime: summary.unique_users,
      // You can customise these later if you want true "today" / "week"
      usersToday: summary.unique_users,
      usersWeek: summary.unique_users,
      topCourses: summary.top_courses
    });
  } catch (err) {
    console.error("Error loading analytics summary:", err);
    res.status(500).json({ error: "Failed to load analytics summary" });
  }
});

/* ============================================================
   POST — Log a new analytics event
   ============================================================ */
router.post("/event", (req, res) => {
  try {
    const { type, at, payload } = req.body || {};
    analyticsDb.logAnalyticsEvent({ type, at, payload });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error logging analytics event:", err);
    res.status(500).json({ error: "Failed to log event" });
  }
});

/* ============================================================
   NEW — GET Registered users (from main users table)
   Used by analytics.html to display emails
   ============================================================ */
router.get("/users", async (req, res) => {
  try {
    const result = await db.query(
      `
        SELECT id, email, home_course, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT 500;
      `
    );

    const users = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      created_at: row.created_at,
      last_seen_at: null,          // optional – we don't track this yet
      home_course: row.home_course // not used in UI now but handy later
    }));

    res.json({ users });
  } catch (err) {
    console.error("Error loading registered users:", err);
    res.status(500).json({ error: "Failed to load registered users" });
  }
});

/* ============================================================
   STILL THERE — POST Register / update a user by email
   (Safe to keep; you can call this separately if you want)
   ============================================================ */
router.post("/register-user", (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    analyticsDb.recordRegisteredUser(email);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error recording registered user:", err);
    res.status(500).json({ error: "Failed to record user" });
  }
});

/* ============================================================
   OPTIONAL — Debug route: list events
   ============================================================ */
router.get("/events", (req, res) => {
  try {
    const events = analyticsDb.getAllEvents(200);
    res.json({ events });
  } catch (err) {
    console.error("Error loading events:", err);
    res.status(500).json({ error: "Failed to load events" });
  }
});

export default router;