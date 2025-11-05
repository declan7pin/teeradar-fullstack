// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";               // if you're on Node < 18
import { scrapeCourse } from "./backend/scrapers/scrapeCourse.js";
import courses from "./backend/data/courses.json" assert { type: "json" };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serve your book.html, etc.

// POST /api/search
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

    // build one criteria object we’ll feed to every course
    const criteria = {
      date,
      earliest,
      latest,
      holes: holes === "" ? "" : String(holes),
      partySize: Number(partySize) || 1
    };

    // scrape all courses in parallel
    const promises = courses.map((course) => scrapeCourse(course, criteria));
    const resultsNested = await Promise.all(promises);
    // resultsNested is array of arrays (because scrapeCourse returns [ ... ])
    const slots = resultsNested.flat();

    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log("TeeRadar backend listening on", PORT);
});



