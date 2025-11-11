// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// TEMP in-memory users (for testing)
// you already wanted this one:
const users = [
  {
    email: "declan7pin@gmail.com",
    password: "Kelmscott1",
    role: "admin",
    adFree: true
  }
];

// store reset tokens in memory too
const resetTokens = new Map(); // token -> email

// -------------------------------------------------------------
// load courses (your existing logic)
const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;
const courses = rawCourses.map((c) => ({
  ...c,
  lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
  lng: typeof c.lng === "number" ? c.lng : PERTH_LNG
}));

// -------------------------------------------------------------
// app setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// serve frontend from /public
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// -------------------------------------------------------------
// AUTH: signup
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
    password, // in real life: hash
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

// AUTH: login
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

// -------------------------------------------------------------
// FORGOT PASSWORD
function generateToken() {
  return Math.random().toString(36).substring(2, 15);
}

app.post("/api/forgot-password", (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }

  const user = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (!user) {
    return res.status(404).json({ error: "No account found with that email." });
  }

  const token = generateToken();
  resetTokens.set(token, email);

  const resetLink = `${req.protocol}://${req.get("host")}/reset-password.html?token=${token}`;
  console.log(`🪄 Password reset link for ${email}: ${resetLink}`);

  // later: send by email instead of console
  res.json({ ok: true, message: "Reset link created.", link: resetLink });
});

// RESET PASSWORD
app.post("/api/reset-password", (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: "token and newPassword required" });
  }

  const email = resetTokens.get(token);
  if (!email) {
    return res.status(400).json({ error: "invalid or expired token" });
  }

  const user = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }

  user.password = newPassword;
  resetTokens.delete(token);

  res.json({ ok: true, message: "Password updated." });
});

// -------------------------------------------------------------
// SEARCH (your existing route)
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

// -------------------------------------------------------------
app.listen(PORT, () => {
  console.log("✅ TeeRadar backend running on", PORT);
});


