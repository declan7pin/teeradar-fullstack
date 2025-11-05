// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // keep if you're on Render with this template
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// figure out __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load courses.json from ./data/courses.json (because we're already in /backend)
const coursesPath = path.join(__dirname, "data", "courses.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// serve frontend from /public (go up one level)
app.use(express.static(path.join(__dirname, "..", "public")));

// main search route
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

    // scrape all courses in parallel
    const promises = courses.map((course) => scrapeCourse(course, criteria));
    const nested = await Promise.all(promises);
    const slots = nested.flat();

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// start server
app.listen(PORT, () => {
  console.log("TeeRadar backend listening on", PORT);
});



