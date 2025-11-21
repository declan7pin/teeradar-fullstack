// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics helpers (SQLite)
import {
  recordEvent,
  getAnalyticsSummary,
  getTopCourses,
} from "./analytics.js";

// Slot cache helpers
import db from "./db.js";
import { getCachedSlots, saveSlotsToCache } from "./slotCache.js";

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

// -----------------------------------------------------
//   CAPACITY HELPER: safest possible interpretation
//   → look at ALL numeric availability-ish fields
//   → use the SMALLEST positive value as "spots left"
// -----------------------------------------------------
function getRemainingCapacity(slot) {
  if (!slot || typeof slot !== "object") return 0;

  const candidates = [];

  // Raw "remaining / available" style fields
  if (typeof slot.remaining === "number") candidates.push(slot.remaining);
  if (typeof slot.available === "number") candidates.push(slot.available);
  if (typeof slot.availableSpots === "number")
    candidates.push(slot.availableSpots);
  if (typeof slot.openSpots === "number") candidates.push(slot.openSpots);
  if (typeof slot.slotsRemaining === "number")
    candidates.push(slot.slotsRemaining);
  if (typeof slot.spots === "number") candidates.push(slot.spots);

  // Capacity-oriented fields (we treat these *conservatively*)
  if (typeof slot.size === "number") candidates.push(slot.size);
  if (typeof slot.partySize === "number") candidates.push(slot.partySize);
  if (typeof slot.maxParty === "number") candidates.push(slot.maxParty);
  if (typeof slot.capacity === "number") candidates.push(slot.capacity);

  // Derived from maxPlayers - bookedPlayers / players
  if (typeof slot.maxPlayers === "number") {
    if (typeof slot.bookedPlayers === "number") {
      candidates.push(slot.maxPlayers - slot.bookedPlayers);
    } else if (typeof slot.players === "number") {
      candidates.push(slot.maxPlayers - slot.players);
    } else {
      // If we *only* know maxPlayers, treat it as an upper bound
      candidates.push(slot.maxPlayers);
    }
  }

  // Filter to positive numbers
  const positives = candidates
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (positives.length === 0) {
    // We truly don't know – safest is "1 seat"
    return 1;
  }

  // SAFEST rule: don't over-estimate available capacity
  //   → use the smallest positive numeric field
  const min = Math.min(...positives);
  return min;
}

// ---------- ROUTES ----------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// Return full course list (used by frontend map + UI)
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// Tee time search with cache layer + capacity filter
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

    // make holes a NUMBER (9 or 18), not a string
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
      const courseId = c.id || c.name;
      const provider = c.provider || "Other";

      // 1) Try cache first
      const cached = getCachedSlots({
        courseId,
        date,
        holes: holesValue || null,
        partySize: criteria.partySize,
      });

      if (cached) {
        const filteredCached = cached.filter(
          (slot) => getRemainingCapacity(slot) >= criteria.partySize
        );

        console.log(
          `⚡ cache hit → ${c.name} → raw=${cached.length}, ` +
            `after capacity filter=${filteredCached.length}`
        );

        return filteredCached;
      }

      // 2) Fallback: scrape live, then save to cache
      try {
        const scraped = (await scrapeCourse(c, criteria, feeGroups)) || [];
        const filteredScraped = scraped.filter(
          (slot) => getRemainingCapacity(slot) >= criteria.partySize
        );

        console.log(
          `✅ scraped ${c.name} → raw=${scraped.length}, ` +
            `after capacity filter=${filteredScraped.length}`
        );

        // Save raw slots into cache
        saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: scraped,
        });

        return filteredScraped;
      } catch (err) {
        console.error(`❌ scrapeCourse error for ${c.name}:`, err.message);

        // cache an empty result so subsequent lookups are fast
        saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: [],
        });
        return [];
      }
    });

    const allResults = await Promise.all(jobs);
    const slots = allResults.flat();

    console.log(
      `🔎 /api/search finished for ${date} ` +
        `size=${criteria.partySize} → total slots: ${slots.length}`
    );

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

// ---------- ANALYTICS SUMMARY ENDPOINTS ----------

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