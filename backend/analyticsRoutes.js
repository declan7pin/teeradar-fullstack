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

    // Support both snake_case (existing analyticsDb)
    // and camelCase (if you ever swap implementations)
    const homeViews =
      summary.home_page_views ?? summary.homeViews ?? 0;

    const bookingClicks =
      summary.booking_clicks ?? summary.bookingClicks ?? 0;

    const searches =
      summary.searches ?? summary.searches ?? 0;

    const newUsers =
      summary.new_users ?? summary.newUsers ?? 0;

    const usersAllTime =
      summary.unique_users ?? summary.usersAllTime ?? 0;

    const usersToday =
      summary.users_today ?? summary.usersToday ?? usersAllTime;

    const usersWeek =
      summary.users_week ?? summary.usersWeek ?? usersAllTime;

    const topCourses =
      summary.top_courses ?? summary.topCourses ?? [];

    // Optional extra metrics if your DB layer starts providing them
    const users30d =
      summary.users30d ?? summary.users_30d ?? null;

    const returningUsers7d =
      summary.returningUsers7d ?? summary.returning_users_7d ?? null;

    // Derived conversion metrics (0–1 ratios)
    const conversionHomeToBooking =
      homeViews > 0 ? bookingClicks / homeViews : 0;

    const conversionSearchToBooking =
      searches > 0 ? bookingClicks / searches : 0;

    res.json({
      // existing fields (kept the same)
      homeViews: homeViews,
      homePageViews: homeViews,
      bookingClicks: bookingClicks,
      courseBookingClicks: bookingClicks,
      searches: searches,
      newUsers: newUsers,
      usersAllTime: usersAllTime,
      // You can customise these later if you want true "today" / "week"
      usersToday: usersToday,
      usersWeek: usersWeek,
      topCourses: topCourses,

      // new fields – safe to ignore on the front end until you use them
      users30d,
      returningUsers7d,
      conversionHomeToBooking,
      conversionSearchToBooking
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