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

// ======================================
//        SEARCH CACHE (BY DATE / HOLES / PLAYERS)
// ======================================

// Cache keyed by { date, holes, partySize } → *broad* time window.
// Actual time window is applied in-memory at query time.
const searchCache = new Map();

// 10 minutes TTL (in ms)
const CACHE_TTL_MS = 10 * 60 * 1000;

// How many days ahead to pre-scrape
const PRE_SCRAPE_DAYS = 8;

// Canonical time window we scrape for (covers the day)
const CANONICAL_EARLIEST = "05:00";
const CANONICAL_LATEST = "19:30";

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

// Normalise incoming criteria
function normalizeCriteria(raw) {
  const {
    date,
    earliest = "06:00",
    latest = "17:00",
    holes = "",
    partySize = 1,
  } = raw || {};

  if (!date) {
    throw new Error("date is required");
  }

  const holesValue =
    holes === "" || holes === null || typeof holes === "undefined"
      ? ""
      : Number(holes);

  return {
    date,
    earliest,
    latest,
    holes: holesValue,
    partySize: Number(partySize) || 1,
  };
}

// Build a stable cache key from date + holes + partySize
function cacheKeyFromCriteria(c) {
  return JSON.stringify({
    date: c.date,
    holes: c.holes === "" ? "" : Number(c.holes),
    partySize: Number(c.partySize) || 1,
  });
}

// Convert "HH:MM" → minutes from midnight
function timeToMinutes(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Get a slot's time (best-effort across different field names)
function slotTimeToMinutes(slot) {
  const t =
    slot.time ||
    slot.teeTime ||
    slot.tee_time ||
    slot.startTime ||
    slot.start_time ||
    "";

  return timeToMinutes(t);
}

// Filter slots by time + players (we assume holes already handled by scrapers)
function filterSlotsForCriteria(slots, criteria) {
  const earliestM = timeToMinutes(criteria.earliest);
  const latestM = timeToMinutes(criteria.latest);
  const neededPlayers = Number(criteria.partySize) || 1;

  return slots.filter((slot) => {
    // Time filter
    const sm = slotTimeToMinutes(slot);
    if (
      sm != null &&
      earliestM != null &&
      latestM != null &&
      (sm < earliestM || sm > latestM)
    ) {
      return false;
    }

    // Capacity filter (best-effort; if we can't read a capacity, we keep it)
    const capRaw =
      slot.availableSpots ??
      slot.available_spots ??
      slot.spots ??
      slot.remainingPlayers ??
      slot.capacity ??
      slot.remaining ??
      null;

    if (capRaw != null) {
      const cap = Number(capRaw);
      if (!Number.isNaN(cap) && cap < neededPlayers) {
        return false;
      }
    }

    return true;
  });
}

// Core scraping function for a given criteria
async function scrapeForCriteria(criteria) {
  console.log("doSearch() with criteria:", criteria);

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
    const holesOptions = ["", 9, 18]; // "" = "any" courses where scraper doesn't care
    const partySizes = [1, 2, 3, 4];

    console.log(
      "[pre-scrape] starting for dates:",
      dates.join(", "),
      "with holes options",
      holesOptions,
      "and party sizes",
      partySizes
    );

    for (const date of dates) {
      for (const holes of holesOptions) {
        for (const partySize of partySizes) {
          try {
            const baseCriteria = {
              date,
              earliest: CANONICAL_EARLIEST,
              latest: CANONICAL_LATEST,
              holes,
              partySize,
            };

            const criteria = normalizeCriteria(baseCriteria);
            const key = cacheKeyFromCriteria(criteria);

            // If we have fresh cache, skip
            const existing = searchCache.get(key);
            if (existing && Date.now() - existing.fetchedAt <= CACHE_TTL_MS) {
              console.log(`[pre-scrape] cache fresh, skipping ${key}`);
              continue;
            }

            console.log(
              `[pre-scrape] scraping date=${date}, holes=${holes}, partySize=${partySize}`
            );

            const slots = await scrapeForCriteria(criteria);

            searchCache.set(key, {
              slots,
              fetchedAt: Date.now(),
            });

            console.log(
              `[pre-scrape] stored ${slots.length} slots under key ${key}`
            );
          } catch (err) {
            console.error(
              `[pre-scrape] error for date=${date}, holes=${holes}, partySize=${partySize}:`,
              err.message
            );
          }
        }
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

// Tee time search using cache (date+holes+players) + in-memory time filter
app.post("/api/search", async (req, res) => {
  try {
    let criteria;
    try {
      criteria = normalizeCriteria(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: err.message || "bad request" });
    }

    const cacheKey = cacheKeyFromCriteria(criteria);
    const now = Date.now();
    const cached = searchCache.get(cacheKey);

    if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) {
      console.log(
        `[cache] Serving /api/search from cache for key ${cacheKey} (date=${criteria.date})`
      );
      const filtered = filterSlotsForCriteria(cached.slots, criteria);
      return res.json({ slots: filtered });
    }

    console.log(
      `[cache] No fresh cache for key ${cacheKey} (date=${criteria.date}), running live scrape`
    );

    // Use canonical time window when scraping; we'll filter by the actual
    // earliest/latest the user picked afterwards.
    const scrapeCriteria = {
      ...criteria,
      earliest: CANONICAL_EARLIEST,
      latest: CANONICAL_LATEST,
    };

    const slots = await scrapeForCriteria(scrapeCriteria);

    searchCache.set(cacheKey, { slots, fetchedAt: Date.now() });

    const filtered = filterSlotsForCriteria(slots, criteria);

    res.json({ slots: filtered });
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

// 2) Explicit summary endpoint used earlier
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
// For any non-API route, serve the main index.html (SPA routing)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});