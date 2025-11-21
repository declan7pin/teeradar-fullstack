// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics helpers (in-memory / SQLite behind the scenes)
import {
  recordEvent,
  getAnalyticsSummary,
  getTopCourses,
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
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG,
}));

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

console.log(`Loaded ${courses.length} courses.`);
console.log(`Loaded ${Object.keys(feeGroups).length} fee group entries.`);

/* =========================================================
   METRO vs REGIONAL GROUPING (for pre-scraping only)
   ========================================================= */

// These names must match entries in data/courses.json
const METRO_COURSE_NAMES = new Set([
  "Wembley Golf Course",
  "Point Walter Golf Course",
  "Maylands Peninsula Public Golf Course",
  "Collier Park Golf Course",
  "Whaleback Golf Course",
  "Araluen Estate",
  "Sun City Country Club",
  "Marangaroo Golf Course",
  "Joondalup Resort",
  "The Vines Resort & Country Club",
  "Secret Harbour Golf Links",
  "Meadow Springs Golf & Country Club",
  "Kwinana Golf Club",
  "The Cut Golf Course",
  "Fremantle Public Golf Course",
  "Armadale Golf Course (The Springs)",
  "Hamersley Public Golf Course",
  "Lake Claremont Golf Course",
  "Carramar Golf Course",
  "Hillview Golf Course",
  "Marri Park Golf Course",
  "Altone Park Golf Course",
]);

function isMetroCourse(course) {
  const name = String(course.name || "").trim();
  return METRO_COURSE_NAMES.has(name);
}

/* =========================================================
   BACKGROUND PRE-SCRAPING (ONLY WARMS PROVIDER SITES)
   - Does NOT change UI, filters, or booking behaviour
   ========================================================= */

const HOLES_OPTIONS = [9, 18];
const METRO_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const REGIONAL_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

function getNext8Days() {
  const days = [];
  const today = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    days.push(`${yyyy}-${mm}-${dd}`);
  }
  return days;
}

async function preScrapeCourses(coursesSubset, label) {
  try {
    const days = getNext8Days();

    console.log(
      `[pre-scrape] Running batch for ${label}: ${coursesSubset.length} courses, days=${days.join(
        ","
      )}`
    );

    for (const date of days) {
      for (const holes of HOLES_OPTIONS) {
        const criteria = {
          date,
          earliest: "06:00",
          latest: "18:00",
          holes,
          partySize: 4, // maximum group, your normal filters still apply in real /api/search
        };

        // Scrape each course in parallel for this (date, holes)
        const jobs = coursesSubset.map(async (course) => {
          try {
            const slots = (await scrapeCourse(course, criteria, feeGroups)) || [];
            const count = Array.isArray(slots) ? slots.length : 0;

            if (count > 0) {
              console.log(
                `  [pre-scrape:${label}] ${course.name} ${date} holes=${holes} → ${count} slots`
              );
            }
          } catch (err) {
            console.error(
              `  [pre-scrape:${label}] Error for ${course.name} on ${date} holes=${holes}:`,
              err.message
            );
          }
        });

        await Promise.all(jobs);
      }
    }

    console.log(`[pre-scrape] Finished batch for ${label}`);
  } catch (err) {
    console.error(`[pre-scrape] Fatal error for ${label}:`, err);
  }
}

// Split courses into metro + regional once at startup
const metroCourses = courses.filter(isMetroCourse);
const regionalCourses = courses.filter((c) => !isMetroCourse(c));

console.log(
  `[pre-scrape] Metro courses: ${metroCourses.length}, Regional courses: ${regionalCourses.length}`
);

// Kick off initial warmup on startup
preScrapeCourses(metroCourses, "metro-initial");
preScrapeCourses(regionalCourses, "regional-initial");

// Metro courses: every 10 minutes
setInterval(() => {
  preScrapeCourses(metroCourses, "metro-10min");
}, METRO_INTERVAL_MS);

// Regional courses: every 60 minutes
setInterval(() => {
  preScrapeCourses(regionalCourses, "regional-60min");
}, REGIONAL_INTERVAL_MS);

/* =========================================================
   ROUTES (unchanged behaviour)
   ========================================================= */

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Return full course list (used by frontend map + UI)
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Tee time search (live scrape, same behaviour as before)
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

    const holesValue =
      holes === "" || holes === null || typeof holes === "undefined"
        ? ""
        : Number(holes);

    const criteria = {
      date,
      earliest,
      latest,
      holes: holesValue,
      partySize: Number(partySize) || 1,
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

// ---------- ANALYTICS INGEST ----------

app.post("/api/analytics/event", async (req, res) => {
  try {
    const { type, payload = {}, at } = req.body || {};

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const userId = payload.userId || ip || null;

    const courseName =
      payload.course ||
      payload.courseName ||
      payload.course_name ||
      payload.courseTitle ||
      null;

    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName,
    });

    await recordEvent({ type, userId, courseName, at });
    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// ---------- ANALYTICS SUMMARY HELPERS ----------

function buildFlatSummary(summary, topCourses) {
  const homeViews = summary.homeViews ?? 0;
  const searches = summary.searches ?? 0;
  const bookingClicks = summary.bookingClicks ?? 0;
  const newUsers7d = summary.newUsers7d ?? 0;

  return {
    homePageViews: homeViews,
    courseBookingClicks: bookingClicks,
    searches,
    newUsers: newUsers7d,

    homeViews,
    bookingClicks,

    usersAllTime: summary.usersAllTime ?? 0,
    usersToday: summary.usersToday ?? 0,
    usersWeek: summary.usersWeek ?? 0,

    topCourses: topCourses || [],
  };
}

// Legacy-style endpoint
app.get("/api/analytics", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    const topCourses = await getTopCourses(10);
    const body = buildFlatSummary(summary, topCourses);

    console.log("[analytics] /api/analytics →", body);
    res.json(body);
  } catch (err) {
    console.error("analytics summary error (/api/analytics)", err);
    res
      .status(500)
      .json({ error: "analytics summary error", detail: err.message });
  }
});

// Explicit summary endpoint
app.get("/api/analytics/summary", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    const topCourses = await getTopCourses(10);
    const body = buildFlatSummary(summary, topCourses);

    console.log("[analytics] /api/analytics/summary →", body);
    res.json(body);
  } catch (err) {
    console.error("analytics summary error (/api/analytics/summary)", err);
    res
      .status(500)
      .json({ error: "analytics summary error", detail: err.message });
  }
});

// Admin endpoint
app.get("/api/admin/summary", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    const topCourses = await getTopCourses(10);
    const body = buildFlatSummary(summary, topCourses);

    console.log("[analytics] /api/admin/summary →", body);
    res.json(body);
  } catch (err) {
    console.error("admin summary error (/api/admin/summary)", err);
    res
      .status(500)
      .json({ error: "admin summary error", detail: err.message });
  }
});

// DEBUG: list of courses with coords + basic flags
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
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});