// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

// ---------- LOAD COURSE DATA ----------
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

// ---------- SIMPLE USER STORE (JSON FILE) ----------

const usersPath = path.join(__dirname, "data", "users.json");
let users = {};

// Load existing users (if any)
try {
  if (fs.existsSync(usersPath)) {
    const raw = fs.readFileSync(usersPath, "utf8");
    users = JSON.parse(raw || "{}");
  }
} catch (err) {
  console.error("Failed to load users.json, starting empty:", err.message);
  users = {};
}

function saveUsers() {
  try {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save users.json:", err.message);
  }
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

// ---- USER PROFILE API ----

// GET /api/user/profile?email=...
app.get("/api/user/profile", (req, res) => {
  const emailRaw = req.query.email || "";
  const email = String(emailRaw).toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const user = users[email];
  if (!user) {
    return res.json({ exists: false });
  }

  res.json({
    exists: true,
    email: user.email,
    homeCourse: user.homeCourse || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
});

// POST /api/user/profile
// body: { email, homeCourse }
app.post("/api/user/profile", (req, res) => {
  try {
    const { email, homeCourse } = req.body || {};
    const normalized = String(email || "").toLowerCase().trim();

    if (!normalized) {
      return res.status(400).json({ error: "email is required" });
    }

    const now = new Date().toISOString();
    const existing = users[normalized] || {
      email: normalized,
      createdAt: now,
    };

    const updated = {
      ...existing,
      homeCourse:
        typeof homeCourse === "string" && homeCourse.trim()
          ? homeCourse.trim()
          : existing.homeCourse || null,
      updatedAt: now,
    };

    users[normalized] = updated;
    saveUsers();

    console.log("[users] upsert", updated);

    res.json({ ok: true, user: updated });
  } catch (err) {
    console.error("user profile error:", err);
    res.status(500).json({ error: "user profile error", detail: err.message });
  }
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

    // make holes numeric (9 or 18) if provided
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

// Simple analytics logger (still console-only)
app.post("/api/analytics/event", (req, res) => {
  try {
    const { type, payload, at, userId, courseName } = req.body || {};
    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName,
      payload,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
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
// For any non-API route, serve the main index.html (SPA-ish)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});