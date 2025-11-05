// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load courses
const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

// fill missing coords (Perth CBD default)
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;
const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// main search
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

    console.log("🔍 search criteria:", criteria);

    const jobs = courses.map((course) => scrapeCourse(course, criteria));
    const settled = await Promise.allSettled(jobs);
    const slots = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);

    res.json({ slots });
  } catch (err) {
    console.error("❌ /api/search error:", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
});

