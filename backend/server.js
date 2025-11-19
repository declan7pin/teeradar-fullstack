// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";
import { logAnalyticsEvent } from "./db/analyticsDb.js";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());

// Serve static frontend from /public at project root
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- LOAD DATA ----------
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

// ---------- SQLITE SETUP ----------
const dbPath = path.join(__dirname, "data", "analytics.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    at TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

console.log(`SQLite analytics database loaded at ${dbPath}`);

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Course list
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Search tee times
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

    const holesValue =
      holes === "" || holes === null || typeof holes === "undefined"
        ? ""
        : Number(holes);

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,
      partySize: Number(partySize) || 1
    };

    console.log("Incoming /api/search", criteria);

    const jobs = courses.map(async (c) => {
      try {
        const result = await scrapeCourse(c, criteria, feeGroups);
        return result || [];
      } catch (err) {
        console.error(`scrapeCourse error for ${c.name}:`, err.message);
        return [];
      }
    });

    const allResults = await Promise.all(jobs);
    const slots = allResults.flat();

    console.log(`Search complete → ${slots.length} total slots`);

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// ---------- ANALYTICS LOGGING ----------
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, payload, at } = req.body || {};

    console.log("Analytics event:", { type, at, payload });

    logAnalyticsEvent({ type, at, payload });

    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// ---------- ANALYTICS SUMMARY ----------
app.get("/api/analytics/summary", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT type, COUNT(*) as count
      FROM analytics_events
      GROUP BY type
    `).all();

    const summary = {
      home_page_views: 0,
      booking_clicks: 0,
      searches: 0,
      new_users: 0,
      total_events: 0
    };

    rows.forEach((r) => {
      if (r.type === "home_page_view") summary.home_page_views = r.count;
      if (r.type === "booking_click") summary.booking_clicks = r.count;
      if (r.type === "search") summary.searches = r.count;
      if (r.type === "new_user") summary.new_users = r.count;
      summary.total_events += r.count;
    });

    res.json(summary);
  } catch (err) {
    console.error("summary error:", err.message);
    res.status(500).json({ error: "summary failed" });
  }
});

// DEBUG: list all events
app.get("/api/analytics/events", (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM analytics_events ORDER BY id DESC LIMIT 200`).all();
    res.json({ events: rows });
  } catch (err) {
    res.status(500).json({ error: "failed to load events" });
  }
});

// Map fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`TeeRadar backend running on port ${PORT}`);
});
