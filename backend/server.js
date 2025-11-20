// =========================
//  TeeRadar Full Server.js
// =========================

const express = require("express");
const path = require("path");
const cors = require("cors");

// Analytics storage (in-memory)
let analytics = {
  homeViews: 0,
  bookingClicks: 0,
  searches: 0,
  newUsers: 0,
  userDevices: new Set(),
  courseClicks: {}
};

// AUTH ROUTER
const { authRouter } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Mount AUTH API
app.use("/api/auth", authRouter);

// Serve frontend
app.use(express.static(path.join(__dirname, "..", "public")));


// =========================
//       ANALYTICS API
// =========================

// Receive events
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, userId, courseName } = req.body;

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
    console.error("Analytics error:", err);
    res.status(500).json({ ok: false });
  }
});

// Dashboard fetch
app.get("/api/analytics/stats", (req, res) => {
  try {
    res.json({
      homeViews: analytics.homeViews,
      bookingClicks: analytics.bookingClicks,
      searches: analytics.searches,
      newUsers: analytics.newUsers,
      uniqueUsers: analytics.userDevices.size,
      courseClicks: analytics.courseClicks
    });
  } catch (err) {
    res.status(500).json({ error: "Failed loading analytics" });
  }
});


// =========================
//      SEARCH / COURSES
// =========================

// (You can replace this with your actual DB or JSON list)
app.get("/api/courses", (req, res) => {
  res.json({
    ok: true,
    courses: [
      // Just sample — your actual course list should be here.
    ]
  });
});

app.post("/api/search", (req, res) => {
  analytics.searches++;

  // Basic mock search so frontend doesn't break
  res.json({
    ok: true,
    results: []
  });
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

app.listen(PORT, () =>
  console.log(`TeeRadar server running on port ${PORT}`)
);