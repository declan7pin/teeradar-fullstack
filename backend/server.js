// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

import { scrapeCourse } from "./scrapers/scrapeCourse.js";

// Analytics (Postgres)
import {
  recordEvent,
  getAnalyticsSummary,
  getTopCourses,
} from "./analytics.js";

// Cache + DB
import db from "./db.js";
import { getCachedSlots, saveSlotsToCache } from "./slotCache.js";

// Auth router
import authRouter from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRouter);

// -------------------------------------------------
// Load course data
// -------------------------------------------------
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

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

// -------------------------------------------------
// Health Check
// -------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", courses: courses.length });
});

// -------------------------------------------------
// Course List
// -------------------------------------------------
app.get("/api/courses", (req, res) => {
  res.json(courses);
});

// -------------------------------------------------
// Search
// -------------------------------------------------
app.post("/api/search", async (req, res) => {
  try {
    const {
      date,
      earliest = "06:00",
      latest = "17:00",
      holes = "",
      partySize = 1,
    } = req.body || {};

    if (!date) return res.status(400).json({ error: "date is required" });

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
      const courseId = c.id || c.name;
      const provider = c.provider || "Other";

      const cached = getCachedSlots({
        courseId,
        date,
        holes: holesValue || null,
        partySize: criteria.partySize,
      });

      if (cached) {
        console.log(`⚡ cache hit → ${c.name} (${cached.length} slots)`);
        return cached;
      }

      try {
        const result = await scrapeCourse(c, criteria, feeGroups);
        const count = Array.isArray(result) ? result.length : 0;

        console.log(`✅ scraped ${c.name} → ${count} slots`);

        await saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: result || [],
        });

        return result || [];
      } catch (err) {
        console.error(`❌ scrape error for ${c.name}:`, err.message);

        await saveSlotsToCache({
          courseId,
          courseName: c.name,
          provider,
          date,
          holes: holesValue || null,
          partySize: criteria.partySize,
          earliest,
          latest,
          slots: [],
        });

        return [];
      }
    });

    const allResults = await Promise.all(jobs);
    const slots = allResults.flat();

    console.log(`🔎 /api/search complete → ${slots.length} total slots`);
    res.json({ slots });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// -------------------------------------------------
// Analytics Event Ingest
// -------------------------------------------------
app.post("/api/analytics/event", async (req, res) => {
  try {
    const { type, payload = {}, at } = req.body || {};

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const userId = payload.userId || ip || null;

    const courseName =
      payload.course ||
      payload.courseName ||
      payload.course_name ||
      payload.courseTitle ||
      null;

    console.log("Incoming analytics event:", {
      type,
      at,
      userId,
      courseName,
    });

    await recordEvent({ type, userId, courseName, at });
    res.json({ ok: true });
  } catch (err) {
    console.error("analytics error", err);
    res.status(500).json({ error: "analytics error", detail: err.message });
  }
});

// -------------------------------------------------
// Analytics Summary
// -------------------------------------------------
function buildFlatSummary(summary, topCourses) {
  return {
    homePageViews: summary.homeViews ?? 0,
    courseBookingClicks: summary.bookingClicks ?? 0,
    searches: summary.searches ?? 0,
    newUsers: summary.newUsers7d ?? 0,
    homeViews: summary.homeViews ?? 0,
    bookingClicks: summary.bookingClicks ?? 0,
    usersAllTime: summary.usersAllTime ?? 0,
    usersToday: summary.usersToday ?? 0,
    usersWeek: summary.usersWeek ?? 0,
    topCourses: topCourses || [],
  };
}

app.get("/api/analytics", async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    const topCourses = await getTopCourses(10);
    res.json(buildFlatSummary(summary, topCourses));
  } catch (err) {
    console.error("analytics summary error", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------
// Registered Users for Admin Dashboard
// -------------------------------------------------
app.get("/api/analytics/users", async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        id,
        email,
        home_course,
        created_at,
        last_login
      FROM users
      ORDER BY id DESC
      LIMIT 200;
    `);

    const users = rows.map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_seen_at: u.last_login || u.created_at || null,
      home_course: u.home_course || null,
    }));

    res.json({ users });
  } catch (err) {
    console.error("analytics users error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// -------------------------------------------------
// ✅ NEW: Delete user (used by admin dashboard)
// -------------------------------------------------
app.delete("/api/analytics/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid user id" });
    }

    const result = await db.query(
      `DELETE FROM users WHERE id = $1`,
      [id]
    );

    console.log("🗑 deleted user id =", id, "rows:", result.rowCount);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "user not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("delete user error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// -------------------------------------------------
// Contact Form Email System
// -------------------------------------------------
app.post("/api/contact", async (req, res) => {
  const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = process.env.SMTP_PORT;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;

  console.log("[contact env] email:", CONTACT_EMAIL);
  console.log("[contact env] host:", SMTP_HOST);
  console.log("[contact env] port:", SMTP_PORT);
  console.log("[contact env] user:", SMTP_USER);
  console.log("[contact env] pass present:", !!SMTP_PASS);

  if (!CONTACT_EMAIL || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_PORT) {
    return res
      .status(500)
      .json({ ok: false, error: "Email service not configured" });
  }

  const { email, question, details } = req.body;

  if (!email || !question || !details) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing required fields" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: false,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"TeeRadar Contact" <${SMTP_USER}>`,
      to: CONTACT_EMAIL,
      subject: `New TeeRadar Question: ${question}`,
      text: `
From: ${email}

Question:
${question}

Details:
${details}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).json({ ok: false, error: "Email failed to send" });
  }
});

// -------------------------------------------------
// Frontend fallback
// -------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// -------------------------------------------------
// Start Server
// -------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ TeeRadar backend running on port ${PORT}`);
});