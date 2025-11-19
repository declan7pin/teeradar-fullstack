// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";
import {
  recordEvent,
  getAnalyticsSummary,
  getTopCourses
} from "./analytics.js";

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
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

console.log(`Loaded ${courses.length} courses.`);
console.log(`Loaded ${Object.keys(feeGroups).length} fee group entries.`);

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
      partySize = 1
    } = req.body || {};

    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }

    // Make holes a NUMBER (9 or 18), not a string
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

// ---------- ANALYTICS ----------

// Receive events from the frontend and store them in SQLite
app.post("/api/analytics/event", async (req, res) => {
  try {
    const { type, payload = {}, at } = req.body || {};

    if (!type) {
      return res.status(400).json({ error: "type is required" });
    }

    const courseName =
      payload.courseName ||
      payload.course ||
      payload.course_name ||
      null;

    const explicitUserId = payload.userId || payload.user_id || null;

    // Fallback: approximate unique user by IP if userId not supplied
    const forwardedFor = req.headers["x-forwarded-for"];
    const ip =
      (typeof forwardedFor === "string" &&
        forwardedFor.split(",")[0].trim()) ||
      req.socket.remoteAddress ||
      null;

    const userId = explicitUserId || ip || null;

    await recordEvent({ type, userId, courseName, at });

    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// Summary numbers for the dashboard
app.get("/api/analytics/summary", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    res.json(summary);
  } catch (err) {
    console.error("summary analytics error", err);
    res
      .status(500)
      .json({ error: "analytics summary error", detail: err.message });
  }
});

// Top courses by booking clicks
app.get("/api/analytics/top-courses", async (req, res) => {
  try {
    const top = await getTopCourses(5);
    res.json({ top });
  } catch (err) {
    console.error("top-courses analytics error", err);
    res.status(500).json({
      error: "analytics top-courses error",
      detail: err.message
    });
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
    hasPhone: !!c.phone
  }));

  res.json({
    count: debugList.length,
    courses: debugList
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
});