// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------
// Load courses (WA + others)
// ----------------------------
const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

// ----------------------------
// Simple file-based analytics
// ----------------------------
const analyticsPath = path.join(__dirname, "data", "analytics.json");

function loadAnalytics() {
  try {
    const txt = fs.readFileSync(analyticsPath, "utf8");
    return JSON.parse(txt);
  } catch {
    return { events: [] };
  }
}

function saveAnalytics(data) {
  try {
    fs.writeFileSync(analyticsPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Error writing analytics file:", err.message);
  }
}

function recordEvent(evt) {
  const data = loadAnalytics();
  data.events.push({
    ...evt,
    at: evt.at || new Date().toISOString()
  });
  saveAnalytics(data);
}

// ----------------------------
// Express app
// ----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// serve static site
app.use(express.static(path.join(__dirname, "..", "public")));

// health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// list of courses for map + cards
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// ----------------------------
// Analytics API
// ----------------------------
app.post("/api/analytics/event", (req, res) => {
  const { type, payload, at } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }

  // you could add IP/user agent if you want, but we keep it simple
  recordEvent({
    type,
    payload: payload || {},
    at: at || new Date().toISOString()
  });

  res.json({ ok: true });
});

app.get("/api/analytics/summary", (req, res) => {
  const data = loadAnalytics();
  const events = data.events || [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  function inLastDays(evt, days) {
    const t = new Date(evt.at).getTime();
    return !isNaN(t) && now - t <= days * dayMs;
  }

  const counters = {
    visitors: { d1: 0, d7: 0, d30: 0 },
    newUsers: { d1: 0, d7: 0, d30: 0 },
    searches: { d1: 0, d7: 0, d30: 0 },
    bookClicks: { d1: 0, d7: 0, d30: 0 },
    adViews: { d1: 0, d7: 0, d30: 0 },
    adClicks: { d1: 0, d7: 0, d30: 0 }
  };

  const courseClicks = {};
  const recentEvents = [];

  for (const evt of events) {
    const t = new Date(evt.at).getTime();
    if (isNaN(t)) continue;

    const d1 = inLastDays(evt, 1);
    const d7 = inLastDays(evt, 7);
    const d30 = inLastDays(evt, 30);

    const bump = (metric) => {
      if (d1) counters[metric].d1++;
      if (d7) counters[metric].d7++;
      if (d30) counters[metric].d30++;
    };

    switch (evt.type) {
      case "home_view":
        bump("visitors");
        break;
      case "new_user":
        bump("newUsers");
        break;
      case "search":
        bump("searches");
        break;
      case "course_click": {
        bump("bookClicks");
        const name = evt.payload?.course;
        if (name) {
          courseClicks[name] = (courseClicks[name] || 0) + 1;
        }
        break;
      }
      case "ad_view":
        bump("adViews");
        break;
      case "ad_click":
        bump("adClicks");
        break;
      default:
        break;
    }
  }

  // top courses by clicks (7-day window implicitly via counters)
  const topCourses = Object.entries(courseClicks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, clicks]) => {
      const course = courses.find(
        (c) => (c.name || "").toLowerCase() === name.toLowerCase()
      );
      return {
        name,
        provider: course?.provider || "Course",
        clicks
      };
    });

  // recent 20 events, newest first
  for (let i = events.length - 1; i >= 0 && recentEvents.length < 20; i--) {
    const e = events[i];
    recentEvents.push({
      at: e.at,
      type: e.type,
      payload: e.payload || {}
    });
  }

  res.json({
    rangeLabel: "Last 7 days",
    visitors: { value: counters.visitors.d7 },
    newUsers: { value: counters.newUsers.d7 },
    searches: { value: counters.searches.d7 },
    bookClicks: { value: counters.bookClicks.d7 },
    adViews: { value: counters.adViews.d7 },
    adClicks: { value: counters.adClicks.d7 },
    countsByRange: {
      visitors: counters.visitors,
      newUsers: counters.newUsers,
      searches: counters.searches,
      bookClicks: counters.bookClicks
    },
    topCourses,
    recentEvents
  });
});

// ----------------------------
// Main tee time search
// ----------------------------
app.post("/api/search", async (req, res) => {
  try {
    const {
      date,
      earliest = "06:00",
      latest = "17:00",
      holes = "",
      partySize = 1
    } = req.body || {};

    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }

    const criteria = {
      date,
      earliest,
      latest,
      holes: holes === "" ? "" : String(holes),
      partySize: Number(partySize) || 1
    };

    console.log("🔍 search criteria:", criteria);

    // log search for analytics
    try {
      recordEvent({
        type: "search",
        payload: criteria
      });
    } catch (err) {
      console.warn("analytics search log failed:", err.message);
    }

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

app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
});