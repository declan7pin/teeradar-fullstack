// backend/server.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load course list
const coursesPath = path.join(__dirname, "data", "courses.json");
const courses = JSON.parse(fs.readFileSync(coursesPath, "utf-8"));

const app = express();
app.use(express.json());

// Serve frontend
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- TeeRadar API ----------

// Main search endpoint
app.post("/api/search", async (req, res) => {
  const { date, earliest = "06:00", latest = "17:00", partySize = 1 } = req.body || {};

  const tasks = courses.map((course) =>
    scrapeCourse(course, { date, earliest, latest, partySize })
  );
  let all = (await Promise.all(tasks)).flat();

  // Attach coordinates and metadata
  const byName = Object.fromEntries(courses.map((c) => [c.name, c]));
  all = all.map((slot) => {
    const base = byName[slot.course] || {};
    return {
      ...slot,
      lat: slot.lat ?? base.lat ?? null,
      lng: slot.lng ?? base.lng ?? null,
      city: slot.city ?? base.city ?? null,
      state: slot.state ?? base.state ?? null,
    };
  });

  res.json({ date, slots: all });
});

// ---------- Subscription + Discount Access ----------

// In-memory discount email list — you can update this anytime
const discountedEmails = new Set([
  "declan@example.com",
  "friend@example.com",
  "freepass@proshop.com"
]);

// Subscription checker endpoint
app.post("/api/check-subscription", (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, reason: "Missing email" });

  let priceNow = 5; // intro monthly price
  let priceLater = 10;
  const hasDiscount = discountedEmails.has(email.toLowerCase());

  if (hasDiscount) {
    priceNow = 0; // or adjust to e.g. 3 for partial discount
  }

  res.json({
    ok: true,
    email,
    priceNow,
    priceLater,
    hasDiscount,
    message: hasDiscount
      ? "You have been granted a discount — enjoy free access!"
      : "Standard subscription pricing applies.",
  });
});

// ---------- Server Listen ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TeeRadar WA backend running on port ${PORT}`);
});


