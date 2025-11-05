// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // For Node < 18 compatibility
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Get the current file and directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the courses.json file
const coursesPath = path.join(__dirname, "data", "courses.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"))); // serve the frontend (book.html, index.html, etc.)

// --- API ENDPOINTS ---

// Health check endpoint (useful for debugging on Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "TeeRadar backend is running" });
});

// Main booking search endpoint
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

    // Normalize and log filters for debugging
    const criteria = {
      date,
      earliest,
      latest,
      holes: holes === "" ? "" : String(holes),
      partySize: Number(partySize) || 1,
    };

    console.log("Running search with filters:", criteria);

    // Scrape all courses in parallel
    const promises = courses.map((course) => scrapeCourse(course, criteria));
    const results = await Promise.allSettled(promises);

    // Flatten successful results and ignore failed scrapes
    const slots = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);

    res.json({ slots });
  } catch (err) {
    console.error("❌ Search error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});



