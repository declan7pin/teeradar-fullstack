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
const PORT = process.env.PORT || 10000;  // Render port

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// SERVE FRONTEND FROM /public (ROOT LEVEL)
// ----------------------------------------------------
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ----------------------------------------------------
// LOAD COURSES (backend/data/courses.json)
// ----------------------------------------------------
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

// Ensure lat/lng always exist
const courses = rawCourses.map(c => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

// ----------------------------------------------------
// LOAD FEE GROUPS (if exists)
// ----------------------------------------------------
const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};

if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

// ----------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// ----------------------------------------------------
// RETURN COURSE LIST
// ----------------------------------------------------
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// ----------------------------------------------------
// FULL WORKING SEARCH ENDPOINT
// ----------------------------------------------------
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

    const criteria = {
      date,
      earliest,
      latest,
      holes: holes === "" ? "" : String(holes),
      partySize: Number(partySize) || 1
    };

    const jobs = courses.map(c => scrapeCourse(c, criteria, feeGroups));
    const settled = await Promise.allSettled(jobs);

    const slots = settled
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value || []);

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
});