// =========================
//  TeeRadar WA - server.js
// =========================

const express = require("express");
const path = require("path");
const cors = require("cors");

// ---------- Routers / modules ----------
const authModule = require("./auth");
const analyticsModule = require("./analytics");
const scrapeCourse = require("./scrapers/scrapeCourse");
const courses = require("./data/courses.json");

// Make this work no matter how auth/analytics are exported
const authRouter =
  authModule.router || authModule.authRouter || authModule;

const analyticsRouter =
  analyticsModule.router || analyticsModule.analyticsRouter || analyticsModule;

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve the frontend files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- Mount existing feature routers ----------

// Auth API (signup / login / verify / etc.)
app.use("/api/auth", authRouter);

// Analytics API (already working – we just mount it)
app.use("/api/analytics", analyticsRouter);

// ---------- Courses API (for map + filters) ----------

app.get("/api/courses", (req, res) => {
  try {
    res.json({
      ok: true,
      courses
    });
  } catch (err) {
    console.error("Error loading courses.json:", err);
    res.status(500).json({ ok: false, error: "Failed to load courses" });
  }
});

// ---------- Live tee-time search API ----------
// Uses your existing scrapers:
//   backend/scrapers/scrapeCourse.js
//   backend/scrapers/parseMiClub.js
//   backend/scrapers/parseQuick18.js

app.post("/api/search", async (req, res) => {
  try {
    const { date, earliest, latest, holes, players } = req.body;

    const results = await scrapeCourse({
      date,
      earliest,
      latest,
      holes,
      players
    });

    res.json({
      ok: true,
      results
    });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "Search failed"
    });
  }
});

// ---------- Fallback: send SPA index ----------
// Anything not starting with /api/* should serve the main app

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`TeeRadar server running on port ${PORT}`);
});