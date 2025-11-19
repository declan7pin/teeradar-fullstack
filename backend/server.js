// backend/server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

import scrapeCourse from "./scrapers/scrapeCourse.js";

const require = createRequire(import.meta.url);
const courses = require("./data/courses.json");
const feeGroups = require("./data/fee_groups.json");

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------
// In-memory analytics
// --------------------------------------------------------
const analytics = {
  homeViews: 0,
  searches: 0,
  courseClicks: 0,
  newUsers: 0,
  events: [], // rolling log for debugging
};

function logAnalytics(type, payload = {}) {
  const event = {
    type,
    at: new Date().toISOString(),
    payload,
  };

  analytics.events.push(event);
  if (analytics.events.length > 5000) {
    analytics.events.shift();
  }

  switch (type) {
    case "home_view":
      analytics.homeViews += 1;
      break;
    case "search":
      analytics.searches += 1;
      break;
    case "course_click":
      analytics.courseClicks += 1;
      break;
    case "signup":
      analytics.newUsers += 1;
      break;
    default:
      break;
  }

  console.log("Incoming analytics event:", event);
}

// --------------------------------------------------------
// Express app
// --------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Serve static frontend (index.html, book.html, admin.html, etc.)
app.use(express.static(path.join(__dirname, "..")));

// --------------------------------------------------------
// API: courses list
// --------------------------------------------------------
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// --------------------------------------------------------
// API: search tee times
// body: { date, earliest, latest, holes, partySize }
// --------------------------------------------------------
app.post("/api/search", async (req, res) => {
  const criteria = req.body || {};
  console.log("Incoming /api/search", criteria);

  // Track search analytics
  logAnalytics("search", {
    date: criteria.date,
    earliest: criteria.earliest,
    latest: criteria.latest,
    holes: criteria.holes,
    partySize: criteria.partySize,
  });

  try {
    const promises = courses.map((course) =>
      scrapeCourse(course, criteria, feeGroups)
    );

    const results = await Promise.all(promises);
    const slots = results.flat();

    console.log(
      `🔎 /api/search finished → total slots: ${slots.length}`
    );

    res.json({ slots });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// --------------------------------------------------------
// API: analytics event sink
// frontend sends: { type: "home_view" | "search" | "course_click" | "signup", payload? }
// --------------------------------------------------------
app.post("/api/analytics/event", (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: "Analytics event 'type' is required" });
  }

  logAnalytics(type, payload || {});
  return res.json({ ok: true });
});

// --------------------------------------------------------
// API: analytics summary for admin dashboard
// --------------------------------------------------------
app.get("/api/analytics", (req, res) => {
  res.json({
    homeViews: analytics.homeViews,
    searches: analytics.searches,
    courseClicks: analytics.courseClicks,
    newUsers: analytics.newUsers,
  });
});

// --------------------------------------------------------
// Catch-all → let frontend handle routing (if needed)
// --------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

// --------------------------------------------------------
app.listen(PORT, () => {
  console.log(`TeeRadar backend listening on port ${PORT}`);
});