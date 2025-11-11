// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // if your scrapers use it
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------------------
// 1) simple in-memory users (TEMP for testing)
// add more later or swap to DB
// ------------------------------------------------------------------
const users = [
  {
    email: "declan7pin@gmail.com",
    password: "Kelmscott1",
    role: "admin",
    adFree: true
  }
];

// ------------------------------------------------------------------
// 2) load courses (your existing logic)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 3) app + middleware
// ------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// serve frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// ------------------------------------------------------------------
// 4) healthcheck
// ------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// ------------------------------------------------------------------
// 5) AUTH ROUTES
// ------------------------------------------------------------------

// POST /api/signup
// body: { email, password, name? }
app.post("/api/signup", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  const exists = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (exists) {
    return res.status(409).json({ error: "user already exists" });
  }

  const newUser = {
    email,
    password, // NOTE: in prod, hash this!
    name: name || "",
    role: "user",
    adFree: false
  };
  users.push(newUser);

  return res.json({
    ok: true,
    user: {
      email: newUser.email,
      role: newUser.role,
      adFree: newUser.adFree
    }
  });
});

// POST /api/login
// body: { email, password }
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  const user = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (!user) {
    return res.status(401).json({ error: "user not found" });
  }
  if (user.password !== password) {
    return res.status(401).json({ error: "invalid password" });
  }

  return res.json({
    ok: true,
    user: {
      email: user.email,
      role: user.role,
      adFree: user.adFree
    }
  });
});

// optional: who am I
app.get("/api/me", (req, res) => {
  // later you can read from a token/cookie
  res.json({ ok: true, user: null });
});

// ------------------------------------------------------------------
// 6) SEARCH (your existing route)
// ------------------------------------------------------------------
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

    // scrape all courses in parallel
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

// ------------------------------------------------------------------
// 7) start server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
});

