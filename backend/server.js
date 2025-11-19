// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";          // <-- NEW: SQLite
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

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

// Ensure every course has lat/lng, fallback to Perth CBD if missing
const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG,
}));

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

console.log(`Loaded ${courses.length} courses.`);
console.log(`Loaded ${Object.keys(feeGroups).length} fee group entries.`);

// ---------- ANALYTICS DB (SQLite) ----------

// DB file lives in backend/data/analytics.db (same folder as courses.json)
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "analytics.db");
const db = new Database(dbPath);

// Simple events table: one row per analytics event
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL,
    at      TEXT NOT NULL,      -- ISO timestamp
    payload TEXT                -- JSON string
  );
`);

const insertEventStmt = db.prepare(
  "INSERT INTO analytics_events (type, at, payload) VALUES (?, ?, ?)"
);

const summaryStmt = db.prepare(`
  SELECT type, COUNT(*) AS count
  FROM analytics_events
  WHERE at >= ?
  GROUP BY type
`);

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Return full course list (used by frontend map + UI)
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Tee time search with extra debug logging
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

    // 🔑 Make holes a NUMBER (9 or 18), not a string
    const holesValue =
      holes === "" || holes === null || typeof holes === "undefined"
        ? ""
        : Number(holes);

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,                 // numeric 9 or 18
      partySize: Number(partySize) || 1, // numeric party size
    };

    console.log("Incoming /api/search", criteria);

    const jobs = courses.map(async (c) => {
      try {
        const result = await scrapeCourse(c, criteria, feeGroups);
        const count = Array.isArray(result) ? result.length : 0;

        if (count > 0) {
          console.log(`✅ ${c.name} → ${count} slots`);
        } else {
          console.log(`⚪ ${c.name} → 0 slots`);
        }

        return result || [];
      } catch (err) {
        console.error(`❌ scrapeCourse error for ${c.name}:`, err.message);
        return [];
      }
    });

    const allResults = await Promise.all(jobs);
    const slots = allResults.flat();

    console.log(`🔎 /api/search finished → total slots: ${slots.length}`);

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// ---------- ANALYTICS ENDPOINTS ----------

// Ingest an analytics event (from home, search, course click, etc.)
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, payload, at } = req.body || {};
    const eventType = type || "unknown";
    const timestamp = at || new Date().toISOString();
    const payloadJson =
      typeof payload === "undefined" ? null : JSON.stringify(payload);

    console.log("Incoming analytics event:", {
      type: eventType,
      at: timestamp,
      payload,
    });

    // Persist to SQLite
    insertEventStmt.run(eventType, timestamp, payloadJson);

    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// Aggregate analytics for the dashboard
// GET /api/analytics/summary?windowDays=7
app.get("/api/analytics/summary", (req, res) => {
  try {
    const windowDays = Number(req.query.windowDays || 7);
    const now = new Date();
    const fromDate = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const fromIso = fromDate.toISOString();

    const rows = summaryStmt.all(fromIso);

    // Default counts
    const counts = {
      home_view: 0,
      course_click: 0,
      search: 0,
      new_user: 0,
    };

    rows.forEach((row) => {
      if (counts.hasOwnProperty(row.type)) {
        counts[row.type] = row.count;
      }
    });

    res.json({
      windowDays,
      from: fromIso,
      to: now.toISOString(),
      homeViews: counts.home_view,
      courseClicks: counts.course_click,
      searches: counts.search,
      newUsers: counts.new_user,
    });
  } catch (err) {
    console.error("analytics summary error", err);
    res.status(500).json({ error: "summary error", detail: err.message });
  }
});

// DEBUG: return list of courses with coords + basic flags
app.get("/api/debug/courses", (req, res) => {
  const debugList = courses.map((c) => ({
    name: c.name,
    provider: c.provider,
    holes: c.holes,
    lat: c.lat,
    lng: c.lng,
    hasUrl: !!c.url,
    hasPhone: !!c.phone,
  }));

  res.json({
    count: debugList.length,
    courses: debugList,
  });
});

// ---------- FRONTEND FALLBACK ----------
// For any non-API route, serve the main index.html (SPA routing)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
  console.log(`📊 Analytics DB at: ${dbPath}`);
});