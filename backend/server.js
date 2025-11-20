// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics helpers (SQLite behind the scenes)
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

// ======================================
//        SIMPLE SEARCH CACHE (8 DAYS)
// ======================================

// Cache keyed by date: "YYYY-MM-DD" → { slots, fetchedAt }
const searchCache = new Map();

// 10 minutes TTL (in ms)
const CACHE_TTL_MS = 10 * 60 * 1000;

// How many days ahead to pre-scrape
const PRE_SCRAPE_DAYS = 8;

// Helper: format Date → "YYYY-MM-DD"
function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Returns an array of date strings for today + next 7 days
function getNext8Dates() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < PRE_SCRAPE_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    out.push(toISODate(d));
  }
  return out;
}

// Core search function used by both /api/search and pre-scraper
async function doSearch(criteria) {
  const {
    date,
    earliest = "06:00",
    latest = "17:00",
    holes = "",
    partySize = 1,
  } = criteria || {};

  if (!date) {
    throw new Error("date is required");
  }

  // Normalise holes → number or "" (like original)
  const holesValue =
    holes === "" || holes === null || typeof holes === "undefined"
      ? ""
      : Number(holes);

  const normalizedCriteria = {
    date,
    earliest,
    latest,
    holes: holesValue,
    partySize: Number(partySize) || 1,
  };

  console.log("doSearch() with criteria:", normalizedCriteria);

  const jobs = courses.map(async (c) => {
    try {
      const result = await scrapeCourse(c, normalizedCriteria, feeGroups);
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

  console.log(`🔎 doSearch() finished → total slots: ${slots.length}`);
  return slots;
}

// Flag so we don’t overlap pre-scrape runs
let isPreScraping = false;

// Background job: scrape ALL courses for next 8 days every 10 minutes
async function runPreScrape() {
  if (isPreScraping) {
    console.log("[pre-scrape] already running, skipping this cycle");
    return;
  }
  isPreScraping = true;

  try {
    const dates = getNext8Dates();
    console.log("[pre-scrape] starting for dates:", dates.join(", "));

    for (const date of dates) {
      try {
        const slots = await doSearch({
          date,
          earliest: "06:00",
          latest: "17:00",
          holes: "",
          partySize: 4, // broad search
        });

        searchCache.set(date, {
          slots,
          fetchedAt: Date.now(),
        });

        console.log(
          `[pre-scrape] stored ${slots.length} slots for ${date} in cache`
        );
      } catch (err) {
        console.error(`[pre-scrape] error for ${date}:`, err.message);
      }
    }

    console.log("[pre-scrape] finished cycle");
  } catch (err) {
    console.error("[pre-scrape] fatal error:", err);
  } finally {
    isPreScraping = false;
  }
}

// Kick off immediately on startup
runPreScrape();

// Then repeat every 10 minutes
setInterval(runPreScrape, CACHE_TTL_MS);

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Return full course list (used by frontend map + UI)
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Tee time search with cache + live fallback
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

    const now = Date.now();
    const cached = searchCache.get(date);

    if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) {
      console.log(`[cache] Serving /api/search for ${date} from cache`);
      return res.json({ slots: cached.slots });
    }

    console.log(`[cache] No fresh cache for ${date}, running live search`);
    const slots = await doSearch({
      date,
      earliest,
      latest,
      holes,
      partySize,
    });

    // Store in cache (even if user searched an odd time window)
    searchCache.set(date, { slots, fetchedAt: Date.now() });

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

    // Derive a userId:
    //  - Prefer payload.userId (future)
    //  - Fallback to IP, so a single device counts as one user
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
  // Summary coming from analytics.js:
  // {
  //   homeViews, searches, bookingClicks,
  //   usersAllTime, usersToday, usersWeek, newUsers7d
  // }

  const homeViews = summary.homeViews ?? 0;
  const searches = summary.searches ?? 0;
  const bookingClicks = summary.bookingClicks ?? 0;
  const newUsers7d = summary.newUsers7d ?? 0;

  return {
    // Names your Admin UI is probably using:
    homePageViews: homeViews,
    courseBookingClicks: bookingClicks,
    searches,
    newUsers: newUsers7d,

    // Also keep the alternative names we already used:
    homeViews,
    bookingClicks,

    // Extra stats if we want them later:
    usersAllTime: summary.usersAllTime ?? 0,
    usersToday: summary.usersToday ?? 0,
    usersWeek: summary.usersWeek ?? 0,

    // Top courses by booking clicks
    topCourses: topCourses || [],
  };
}

// ---------- ANALYTICS SUMMARY ENDPOINTS ----------

// 1) Legacy-style endpoint (in case Admin UI calls /api/analytics)
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

// 2) Explicit summary endpoint
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

// 3) Admin endpoint (if Admin UI points here)
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
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});