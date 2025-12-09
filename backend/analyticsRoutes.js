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
    const events =
      typeof analyticsDb.getAllEvents === "function"
        ? analyticsDb.getAllEvents(5000)
        : [];

    // Support both snake_case and camelCase from analyticsDb
    const homeViews =
      summary.home_page_views ?? summary.homeViews ?? 0;

    const bookingClicks =
      summary.booking_clicks ?? summary.bookingClicks ?? 0;

    const searches =
      summary.searches ?? 0;

    const newUsers =
      summary.new_users ?? summary.newUsers ?? 0;

    const usersAllTime =
      summary.unique_users ?? summary.usersAllTime ?? 0;

    const usersToday =
      summary.users_today ?? summary.usersToday ?? usersAllTime;

    const usersWeek =
      summary.users_week ?? summary.usersWeek ?? usersAllTime;

    const users30d =
      summary.users30d ?? summary.users_30d ?? 0;

    const returningUsers7d =
      summary.returning_users_7d ?? summary.returningUsers7d ?? 0;

    const topCourses =
      summary.top_courses ?? summary.topCourses ?? [];

    // These may be empty from the DB summary — we'll fill from events
    let topSearchedCourses =
      summary.top_searched_courses ?? summary.topSearchedCourses ?? [];

    let demandRank =
      summary.demand_rank ?? summary.demandRank ?? [];

    let repeatBookers =
      summary.repeat_bookers ?? summary.repeatBookers ?? 0;

    let peakBookingHour =
      summary.peak_booking_hour ?? summary.peakBookingHour ?? null;

    /* --------------------------------------------------------
       Fallback: derive search-based stats from raw events
       -------------------------------------------------------- */
    if (events && events.length > 0) {
      const courseStats = {};
      const bookingByHour = {};
      const bookingByUser = {};

      for (const ev of events) {
        const type = ev.type;
        const courseName = ev.course_name || null;
        const userId = ev.user_id || null;
        const at = ev.at;

        // Per-course stats
        if (courseName) {
          if (!courseStats[courseName]) {
            courseStats[courseName] = { searches: 0, clicks: 0 };
          }
          if (type === "search_course" || type === "search") {
            courseStats[courseName].searches += 1;
          }
          if (type === "booking_click" || type === "course_booking_click") {
            courseStats[courseName].clicks += 1;
          }
        }

        // Peak booking hour
        if (type === "booking_click" || type === "course_booking_click") {
          if (at) {
            const d = new Date(at);
            if (!Number.isNaN(d.getTime())) {
              const hour = String(d.getHours()).padStart(2, "0");
              bookingByHour[hour] = (bookingByHour[hour] || 0) + 1;
            }
          }
        }

        // Repeat bookers
        if (
          (type === "booking_click" || type === "course_booking_click") &&
          userId
        ) {
          bookingByUser[userId] = (bookingByUser[userId] || 0) + 1;
        }
      }

      // If DB didn't return topSearchedCourses, compute it
      if (!topSearchedCourses || topSearchedCourses.length === 0) {
        topSearchedCourses = Object.entries(courseStats)
          .map(([courseName, s]) => ({ courseName, searches: s.searches }))
          .filter((row) => row.searches > 0)
          .sort((a, b) => b.searches - a.searches)
          .slice(0, 5);
      }

      // If DB didn't return demandRank, compute it
      if (!demandRank || demandRank.length === 0) {
        demandRank = Object.entries(courseStats)
          .map(([courseName, s]) => ({
            courseName,
            searches: s.searches,
            clicks: s.clicks,
            score: s.searches * 2 + s.clicks,
          }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
      }

      // Repeat bookers fallback
      if (!repeatBookers) {
        repeatBookers = Object.values(bookingByUser).filter(
          (count) => count > 1
        ).length;
      }

      // Peak booking hour fallback
      if (!peakBookingHour && Object.keys(bookingByHour).length > 0) {
        const [hour, clicks] = Object.entries(bookingByHour).sort(
          (a, b) => b[1] - a[1]
        )[0];
        peakBookingHour = { hour, clicks };
      }

      // Helpful debug in your Render logs
      console.log(
        "Analytics summary derived from events:",
        {
          eventsCount: events.length,
          topSearchedCount: topSearchedCourses.length,
          demandRankCount: demandRank.length,
        }
      );
    }

    // Conversion metrics
    const conversionHomeToBooking =
      homeViews > 0 ? bookingClicks / homeViews : 0;

    const conversionSearchToBooking =
      searches > 0 ? bookingClicks / searches : 0;

    res.json({
      homeViews,
      homePageViews: homeViews,
      bookingClicks,
      courseBookingClicks: bookingClicks,
      searches,
      newUsers,
      usersAllTime,
      usersToday,
      usersWeek,
      users30d,
      returningUsers7d,
      topCourses,
      topSearchedCourses,
      demandRank,
      repeatBookers,
      peakBookingHour,
      conversionHomeToBooking,
      conversionSearchToBooking,
    });
  } catch (err) {
    console.error("Error loading analytics summary:", err);
    res.status(500).json({ error: "Failed to load analytics summary" });
  }
});

/* ============================================================
   POST — Log a new analytics event
   Accepts BOTH:
   - { type, at, payload: {...} }
   - { type, at, userId, courseName, ... }
   ============================================================ */
router.post("/event", (req, res) => {
  try {
    const body = req.body || {};
    const { type, at } = body;

    let payload = body.payload;

    // If no nested payload, treat top-level fields (except type/at) as payload
    if (!payload || typeof payload !== "object") {
      const { type: _t, at: _a, ...rest } = body;
      payload = rest;
    }

    analyticsDb.logAnalyticsEvent({
      type,
      at,
      payload,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error logging analytics event:", err);
    res.status(500).json({ error: "Failed to log event" });
  }
});

/* ============================================================
   GET Registered users (from main users table)
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
      last_seen_at: null,
      home_course: row.home_course,
    }));

    res.json({ users });
  } catch (err) {
    console.error("Error loading registered users:", err);
    res.status(500).json({ error: "Failed to load registered users" });
  }
});

/* ============================================================
   OPTIONAL — Debug route: list recent events
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