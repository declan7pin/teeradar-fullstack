// ========================
//  TeeRadar WA — SERVER
// ========================

const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Load auth router
const { authRouter, verifyToken } = require("./auth");

// In-memory stores (replace with DB later)
let ANALYTICS = [];
let USERS = {};        // email → { hash, homeCourse }
let COURSES = [];      // loaded once at start

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves index.html, book.html, etc.

// ========================
//  AUTH ROUTES
// ========================
app.use("/api/auth", authRouter);

// ========================
//  LOAD COURSES (from local JSON file)
// ========================
const fs = require("fs");
const coursesPath = path.join(__dirname, "courses.json");

try {
  const raw = fs.readFileSync(coursesPath, "utf8");
  COURSES = JSON.parse(raw);
  console.log("Loaded courses.json:", COURSES.length, "courses");
} catch (err) {
  console.error("Failed loading courses.json", err);
  COURSES = [];
}

// ========================
//  COURSES ENDPOINT
// ========================
app.get("/api/courses", (req, res) => {
  res.json(COURSES);
});

// ========================
//  SEARCH ENDPOINT
// ========================
app.post("/api/search", async (req, res) => {
  const { date, earliest, latest, holes, partySize } = req.body;

  console.log("\nIncoming /api/search", req.body);

  const slots = [];

  for (const c of COURSES) {
    if (!c.provider) continue;

    // PHONE BOOKING
    if (c.provider === "Phone") {
      slots.push({
        course: c.name,
        provider: "Phone",
        date,
        time: null,
        url: null,
        phone: c.phone || null,
      });
      continue;
    }

    // QUICK18
    if (c.provider === "Quick18" && c.quick18Url) {
      try {
        const yyyymmdd = date.replace(/-/g, "");
        const r = await fetch(`${c.quick18Url}?teedate=${yyyymmdd}`);
        const html = await r.text();

        const count = (html.match(/class="timecell"/g) || []).length;
        for (let i = 0; i < count; i++) {
          slots.push({
            course: c.name,
            provider: "Quick18",
            date,
            time: "Unknown",
            url: c.url,
          });
        }
      } catch (e) {
        console.warn("Quick18 error:", c.name);
      }
      continue;
    }

    // MiClub UNIVERSITY (the safe one)
    if (c.provider === "MiClub" && c.url) {
      try {
        const u = new URL(c.url);
        u.searchParams.set("selectedDate", date);

        const r = await fetch(u.toString());
        const html = await r.text();

        // Very soft availability check
        const count =
          (html.match(/class="timeslot"/g) ||
            html.match(/tee-time/g) ||
            []).length;

        for (let i = 0; i < count; i++) {
          slots.push({
            course: c.name,
            provider: "MiClub",
            date,
            time: "Unknown",
            url: c.url,
          });
        }
      } catch (e) {
        console.warn("MiClub error:", c.name);
      }
      continue;
    }
  }

  console.log(
    `Search complete — ${slots.length} slots across courses`
  );

  res.json({ ok: true, slots });
});

// ========================
//  ANALYTICS ENDPOINTS
// ========================

// Record event
app.post("/api/analytics/event", (req, res) => {
  const event = {
    type: req.body.type,
    userId: req.body.userId || "unknown",
    courseName: req.body.courseName || null,
    payload: req.body.payload || {},
    at: new Date().toISOString(),
  };

  ANALYTICS.push(event);

  console.log("\n[analytics] recorded", event);

  res.json({ ok: true });
});

// Summary
app.get("/api/analytics/summary", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const homeViews = ANALYTICS.filter((e) => e.type === "home_view").length;
  const bookingClicks = ANALYTICS.filter(
    (e) => e.type === "booking_click"
  ).length;
  const searches = ANALYTICS.filter((e) => e.type === "search").length;

  const usersToday = new Set(
    ANALYTICS.filter((e) => e.at.startsWith(today)).map((e) => e.userId)
  ).size;

  const usersAllTime = new Set(ANALYTICS.map((e) => e.userId)).size;

  console.log("\n[analytics] summary", {
    homeViews,
    bookingClicks,
    searches,
    usersToday,
    usersAllTime,
  });

  res.json({
    homeViews,
    bookingClicks,
    searches,
    usersToday,
    usersAllTime,
  });
});

// ========================
//  FALLBACK → index.html
// ========================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ========================
//  START SERVER
// ========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`TeeRadar backend running on port ${PORT}`)
);