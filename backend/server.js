// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // kept for scrapers or future use
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// Load courses
// --------------------------------------------------
const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

// Fallback coordinates (Perth CBD) if missing
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG,
}));

// --------------------------------------------------
// In-memory analytics store
// (resets when server restarts / redeploys)
// --------------------------------------------------
const analytics = {
  totals: {
    homeViews: 0,
    courseClicks: 0,
    searches: 0,
    newUsers: 0,
  },
  // byDay["YYYY-MM-DD"] = { homeViews, courseClicks, searches, newUsers }
  byDay: {},
  // byCourse["Course Name"] = { name, clicks }
  byCourse: {},
  // recent events: [{ type, payload, at }]
  recent: [],
};

function getTodayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureDayBucket(dayKey) {
  if (!analytics.byDay[dayKey]) {
    analytics.byDay[dayKey] = {
      homeViews: 0,
      courseClicks: 0,
      searches: 0,
      newUsers: 0,
    };
  }
  return analytics.byDay[dayKey];
}

function trackEvent(type, payload = {}) {
  const now = new Date();
  const dayKey = getTodayKey();
  const bucket = ensureDayBucket(dayKey);

  switch (type) {
    case "home_view":
      analytics.totals.homeViews += 1;
      bucket.homeViews += 1;
      break;
    case "search":
      analytics.totals.searches += 1;
      bucket.searches += 1;
      break;
    case "course_click":
      analytics.totals.courseClicks += 1;
      bucket.courseClicks += 1;

      // Track by course
      {
        const courseName =
          payload.course ||
          payload.courseName ||
          payload.name ||
          "Unknown course";
        if (!analytics.byCourse[courseName]) {
          analytics.byCourse[courseName] = {
            name: courseName,
            clicks: 0,
          };
        }
        analytics.byCourse[courseName].clicks += 1;
      }
      break;
    case "new_user":
      analytics.totals.newUsers += 1;
      bucket.newUsers += 1;
      break;
    default:
      // Unknown event type – still keep as recent, but no counters
      break;
  }

  // Push into recent list (most recent first)
  analytics.recent.unshift({
    type,
    payload,
    at: now.toISOString(),
  });

  if (analytics.recent.length > 100) {
    analytics.recent.length = 100;
  }
}

// --------------------------------------------------
// Express app setup
// --------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// --------------------------------------------------
// Health check
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    courses: courses.length,
    analyticsTotals: analytics.totals,
  });
});

// --------------------------------------------------
// MAIN SEARCH ENDPOINT
// --------------------------------------------------
app.post("/api/search", async (req, res) => {
  try {
    const {
      date,
      earliest = "06:00",
      latest = "17:00",
      holes = "",
      partySize = 1,
    } = req.body || {};

    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }

    const criteria = {
      date,
      earliest,
      latest,
      holes: holes === "" ? "" : String(holes),
      partySize: Number(partySize) || 1,
    };

    console.log("🔍 search criteria:", criteria);

    // Track search as an analytics event
    trackEvent("search", {
      date,
      earliest,
      latest,
      holes: criteria.holes || "any",
      partySize: criteria.partySize,
    });

    // For each course, run scrapeCourse
    const jobs = courses.map((course) => scrapeCourse(course, criteria));

    const settled = await Promise.allSettled(jobs);
    const slots = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);

    res.json({ slots });
  } catch (err) {
    console.error("❌ /api/search error:", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// --------------------------------------------------
// ANALYTICS: record event
// called from frontend on:
//  - home page load (home_view)
//  - new users (new_user)
//  - course booking button clicks (course_click)
//  - searches (already tracked in /api/search above)
// --------------------------------------------------
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, payload } = req.body || {};
    if (!type) {
      return res.status(400).json({ error: "type is required" });
    }

    trackEvent(type, payload || {});
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/analytics/event error:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------------------------------------
// ANALYTICS: summary for dashboard
// Used by analytics.html
// --------------------------------------------------
app.get("/api/analytics/summary", (req, res) => {
  try {
    // byDay → convert to array sorted by date
    const dayKeys = Object.keys(analytics.byDay).sort();
    const byDayArray = dayKeys.map((k) => ({
      date: k,
      ...analytics.byDay[k],
    }));

    // byCourse → array
    const byCourseArray = Object.values(analytics.byCourse);

    // previousTotals: for now, set to zeros
    // (you can later compute previous period totals from byDay if you like)
    const previousTotals = {
      homeViews: 0,
      courseClicks: 0,
      searches: 0,
      newUsers: 0,
    };

    res.json({
      totals: analytics.totals,
      previousTotals,
      byDay: byDayArray,
      byCourse: byCourseArray,
      recent: analytics.recent,
    });
  } catch (err) {
    console.error("❌ /api/analytics/summary error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------
app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
  console.log("   Courses loaded:", courses.length);
});