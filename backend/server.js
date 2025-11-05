// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // keep for node < 18
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load courses.json from backend/data/courses.json
const coursesPath = path.join(__dirname, "data", "courses.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// serve the frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// health
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
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

    console.log("🟦 search criteria:", criteria);

    // scrape all courses
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




