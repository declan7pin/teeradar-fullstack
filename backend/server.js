// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { scrapeCourse } from "./scrapers/scrapeCourse.js";
import authRouter from "./auth.js";

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

// ---------- IN-MEMORY ANALYTICS STORE ----------
// This is enough to power your current analytics UI.
// (We can move this to SQLite later if you want.)
const analyticsEvents = [];

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Return full course list (used by frontend map + UI)
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Tee time search
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

    // 🔑 IMPORTANT: make holes a NUMBER (9 or 18), not a string
    const holesValue =
      holes === "" || holes === null || typeof holes === "undefined"
        ? ""
        : Number(holes);

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,                 // numeric 9 or 18, or ""
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

    // optional: track a "search" analytics event
    analyticsEvents.push({
      type: "search",
      createdAt: new Date(),
      payload: { criteria },
    });

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// Simple analytics logger
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, payload = {}, at, userId, courseName } = req.body || {};

    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName,
      payload,
    });

    const createdAt = at ? new Date(at) : new Date();

    const evt = {
      type: type || "unknown",
      userId: userId || null,
      courseName: courseName || null,
      payload,
      createdAt,
    };

    analyticsEvents.push(evt);

    console.log("[analytics] recorded", evt);
    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// Analytics summary for /analytics.html
app.get("/api/analytics/summary", (req, res) => {
  try {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;

    let homeViews = 0;
    let searches = 0;
    let bookingClicks = 0;

    const usersAll = new Set();
    const usersToday = new Set();
    const usersWeek = new Set();

    const firstSeen = new Map(); // userId -> earliest date
    const courseClicks = new Map(); // courseName -> count

    for (const evt of analyticsEvents) {
      const { type, userId, courseName, createdAt } = evt;
      const ts = createdAt instanceof Date ? createdAt : new Date(createdAt);
      const ageMs = now - ts;

      if (type === "home_view") homeViews++;
      if (type === "search") searches++;
      if (type === "booking_click") {
        bookingClicks++;
        if (courseName) {
          courseClicks.set(courseName, (courseClicks.get(courseName) || 0) + 1);
        }
      }

      if (userId) {
        usersAll.add(userId);
        if (ageMs <= dayMs) usersToday.add(userId);
        if (ageMs <= weekMs) usersWeek.add(userId);

        const prev = firstSeen.get(userId);
        if (!prev || ts < prev) firstSeen.set(userId, ts);
      }
    }

    const newUsers7d = new Set();
    for (const [uid, firstDate] of firstSeen.entries()) {
      const ageMs = now - firstDate;
      if (ageMs <= weekMs) newUsers7d.add(uid);
    }

    const topCourses = Array.from(courseClicks.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, clicks]) => ({ courseName: name, clicks }));

    const summary = {
      homePageViews: homeViews,
      courseBookingClicks: bookingClicks,
      searches,
      newUsers: newUsers7d.size,

      // extra fields your logger was printing
      homeViews,
      bookingClicks,
      usersAllTime: usersAll.size,
      usersToday: usersToday.size,
      usersWeek: usersWeek.size,
      newUsers7d: newUsers7d.size,
      topCourses,
    };

    console.log("[analytics] summary", summary);
    res.json(summary);
  } catch (err) {
    console.error("analytics summary error", err);
    res.status(500).json({ error: "analytics summary error", detail: err.message });
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

// ---------- AUTH ROUTES ----------
// Expects backend/auth.js to `export default router;`
app.use("/api/auth", authRouter);

// ---------- FRONTEND FALLBACK ----------
// For any non-API route, serve the main index.html (SPA-style routing)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});