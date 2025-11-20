// =========================
//  TeeRadar Full Server.js
// =========================

const express = require("express");
const path = require("path");
const cors = require("cors");

// -------- AUTH ROUTER (Postgres-backed) --------
const { authRouter } = require("./auth");

// -------- COURSES DATA (static WA list) --------
// Support both module.exports = [...]  OR  module.exports = { courses: [...] }
const coursesModule = require("./courses");
const COURSES = Array.isArray(coursesModule)
  ? coursesModule
  : Array.isArray(coursesModule.courses)
  ? coursesModule.courses
  : [];

// -------- SEARCH LOGIC (live availability) --------
// This should be your existing scraper/aggregator that already works.
const { runSearch } = require("./search");

const app = express();
const PORT = process.env.PORT || 3001;

// -------- MIDDLEWARE --------
app.use(cors());
app.use(express.json());

// Mount AUTH API
app.use("/api/auth", authRouter);

// Serve frontend (public folder)
app.use(express.static(path.join(__dirname, "..", "public")));

// =========================
//       ANALYTICS API
// =========================

// In-memory counters (Render will reset on redeploy)
let analytics = {
  homeViews: 0,
  bookingClicks: 0,
  searches: 0,
  newUsers: 0,
  userDevices: new Set(),
  courseClicks: {},
};

// Receive events from frontend
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, userId, courseName } = req.body || {};

    if (type === "home_view") {
      analytics.homeViews++;
      if (userId) analytics.userDevices.add(userId);
    }

    if (type === "booking_click") {
      analytics.bookingClicks++;
      if (courseName) {
        analytics.courseClicks[courseName] =
          (analytics.courseClicks[courseName] || 0) + 1;
      }
    }

    if (type === "search") {
      analytics.searches++;
    }

    if (type === "new_user") {
      analytics.newUsers++;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Analytics event error:", err);
    res.status(500).json({ ok: false });
  }
});

// Analytics dashboard fetch
// (your analytics.html should already be pointed at this)
app.get("/api/analytics/stats", (req, res) => {
  try {
    res.json({
      homeViews: analytics.homeViews,
      bookingClicks: analytics.bookingClicks,
      searches: analytics.searches,
      newUsers: analytics.newUsers,
      uniqueUsers: analytics.userDevices.size,
      courseClicks: analytics.courseClicks,
    });
  } catch (err) {
    console.error("Analytics stats error:", err);
    res.status(500).json({ error: "Failed loading analytics" });
  }
});

// =========================
//      COURSES / SEARCH
// =========================

// 👉 Courses endpoint: used by the map to render markers
// book.html expects this to be a *plain array* of course objects.
app.get("/api/courses", (req, res) => {
  try {
    res.json(COURSES);
  } catch (err) {
    console.error("/api/courses error:", err);
    res.status(500).json([]);
  }
});

// 👉 Search endpoint: delegates to your existing live search logic
// Frontend expects: { slots: [...] }
app.post("/api/search", async (req, res) => {
  try {
    analytics.searches++;

    const criteria = req.body || {};
    // runSearch should return an array of slot objects:
    // [{ course, time, provider, bookingUrl, ... }, ...]
    const slots = await runSearch(criteria);

    res.json({ slots });
  } catch (err) {
    console.error("/api/search error:", err);
    res.status(500).json({ slots: [] });
  }
});

// =========================
//   FALLBACK → FRONTEND
// =========================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// =========================
//        START SERVER
// =========================

app.listen(PORT, () => {
  console.log(`TeeRadar server running on port ${PORT}`);
});