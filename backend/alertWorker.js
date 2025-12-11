// backend/alertWorker.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import db from "./db.js";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Load course + fee group data (same as server.js) ---
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

console.log(
  `🔔 Alert worker loaded ${courses.length} courses & ${Object.keys(
    feeGroups
  ).length} fee group entries.`
);

// ---------------------------------------------------------
// DB: ensure alert hits table exists
// ---------------------------------------------------------
async function ensureUserAlertHitsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_hits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT NOT NULL,
        provider TEXT,
        date TEXT NOT NULL,              -- 'YYYY-MM-DD'
        holes INTEGER,
        party_size INTEGER,
        earliest TEXT,
        latest TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);
    console.log("✅ user_alert_hits table ready");
  } catch (err) {
    console.error("❌ error ensuring user_alert_hits table:", err);
  }
}
ensureUserAlertHitsTable();

// ---------------------------------------------------------
// 🔹 ADDED: alert frequency helper
// ---------------------------------------------------------
function shouldRunBasedOnFrequency(freq, lastRunIso) {
  if (!freq) return true;
  if (!lastRunIso) return true;

  const last = new Date(lastRunIso).getTime();
  if (!Number.isFinite(last)) return true;

  const now = Date.now();
  const diff = now - last;

  const HOUR = 1000 * 60 * 60;

  switch (freq.toLowerCase()) {
    case "6hrs":
      return diff >= 6 * HOUR;
    case "daily":
      return diff >= 24 * HOUR;
    case "2days":
      return diff >= 48 * HOUR;
    case "3days":
      return diff >= 72 * HOUR;
    case "popup":
      return true; // still run normally, user just gets popups instead of email
    default:
      return true;
  }
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

function normaliseDayToken(token) {
  if (!token) return null;
  const t = token.toString().trim().toLowerCase();
  if (!t) return null;

  const short = t.slice(0, 3);
  switch (short) {
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    case "sun":
      return 0;
    default:
      return null;
  }
}

// Next date matching target DOW
function nextDateForDow(targetDow) {
  const now = new Date();
  const todayDow = now.getDay();
  let delta = (targetDow - todayDow + 7) % 7;
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + delta
  );
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysToIso(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map((x) => parseInt(x, 10));
  const base = new Date(y, m - 1, d + days);
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveDatesFromPreferredDays(preferredDays) {
  const todayDow = new Date().getDay();

  if (!Array.isArray(preferredDays) || preferredDays.length === 0) {
    const thisDate = nextDateForDow(todayDow);
    const nextDate = addDaysToIso(thisDate, 7);
    return [thisDate, nextDate];
  }

  const dows = new Set();
  for (const d of preferredDays) {
    const dow = normaliseDayToken(d);
    if (dow !== null) dows.add(dow);
  }

  if (!dows.size) {
    const thisDate = nextDateForDow(todayDow);
    const nextDate = addDaysToIso(thisDate, 7);
    return [thisDate, nextDate];
  }

  const thisWindow = Array.from(dows).map((dow) => nextDateForDow(dow));
  const nextWindow = thisWindow.map((iso) => addDaysToIso(iso, 7));
  const combined = [...thisWindow, ...nextWindow];

  const seen = new Set();
  const out = [];
  for (const d of combined) {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function findCourseByFavourite(fav) {
  if (!fav) return null;
  const name = fav.name || fav.courseName || fav.course || null;
  if (!name) return null;

  let course = courses.find((c) => c.name === name);
  if (course) return course;

  const lower = name.toLowerCase();
  course = courses.find((c) => c.name.toLowerCase().includes(lower));
  return course || null;
}

// ---------------------------------------------------------
// Core alert tick
// ---------------------------------------------------------

async function runAlertTick() {
  console.log("🔔 Alert tick starting…");

  try {
    // Pull users + preferences
    const { rows } = await db.query(`
      SELECT
        u.email,
        u.home_course,
        p.home_state,
        p.favourites,
        p.preferred_days,
        p.preferred_earliest,
        p.preferred_latest,
        p.preferred_holes,
        p.preferred_party_size,

        p.alert_frequency,   -- 🔹 ADDED
        p.alert_last_run     -- 🔹 ADDED

      FROM users u
      JOIN user_preferences p
        ON p.email = u.email
      WHERE p.favourites IS NOT NULL
    `);

    if (!rows.length) {
      console.log("🔔 Alert tick: no users with preferences yet.");
      return;
    }

    console.log(`🔔 Alert tick: found ${rows.length} user(s) with alerts.`);

    for (const row of rows) {
      const email = (row.email || "").toLowerCase();

      const alertFrequency = row.alert_frequency || null; // 🔹 ADDED
      const alertLastRun = row.alert_last_run || null;     // 🔹 ADDED

      // 🔹 ADDED: Frequency gate
      if (!shouldRunBasedOnFrequency(alertFrequency, alertLastRun)) {
        console.log(`⏳ Skipping ${email} — not due yet (freq=${alertFrequency})`);
        continue;
      }

      const favourites = row.favourites || [];
      const preferredDays = row.preferred_days || [];
      const earliest = row.preferred_earliest || "06:00";
      const latest = row.preferred_latest || "17:00";
      const holes = row.preferred_holes || "";
      const partySize = row.preferred_party_size || 1;

      if (!Array.isArray(favourites) || favourites.length === 0) {
        continue;
      }

      const datesToScan = resolveDatesFromPreferredDays(preferredDays);

      console.log(
        `👤 ${email}: ${favourites.length} favourite(s), days=${JSON.stringify(
          preferredDays
        )}, dates=${datesToScan.join(",")}`
      );

      const userHoles = holes ? Number(holes) : null;

      for (const fav of favourites) {
        const course = findCourseByFavourite(fav);
        if (!course) {
          console.log(`  ⚠️ Could not match favourite to course.json:`, fav);
          continue;
        }

        const courseHoles =
          course.holes != null ? Number(course.holes) : null;

        if (userHoles && courseHoles && courseHoles !== userHoles) {
          console.log(
            `Skipping ${course.name} – course is ${courseHoles} holes, user requested ${userHoles}`
          );
          continue;
        }

        const providerLabel = course.provider || "Course";

        for (const date of datesToScan) {
          const criteria = {
            date,
            earliest,
            latest,
            holes: userHoles || "",
            partySize: partySize || 1,
            state: (course.state || "").toUpperCase() || null,
          };

          try {
            const result = await scrapeCourse(course, criteria, feeGroups);
            const count = Array.isArray(result) ? result.length : 0;

            console.log(
              `${providerLabel} → ${course.name} → ${count} slots (after partySize filter)`
            );

            if (count > 0) {
              console.log(
                `  ✅ ${email} – ${course.name} on ${date}: ${count} slot(s) found.`
              );

              try {
                await db.query(
                  `
                  INSERT INTO user_alert_hits (
                    email,
                    course_name,
                    provider,
                    date,
                    holes,
                    party_size,
                    earliest,
                    latest,
                    slots
                  )
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                  `,
                  [
                    email,
                    course.name,
                    course.provider || null,
                    date,
                    userHoles || null,
                    partySize || null,
                    earliest || null,
                    latest || null,
                    JSON.stringify(result || []),
                  ]
                );
              } catch (err) {
                console.error(
                  `  ⚠️ failed to insert alert hit for ${email} / ${course.name} / ${date}:`,
                  err.message
                );
              }
            } else {
              console.log(
                `  ⛔ ${email} – ${course.name} on ${date}: no slots.`
              );
            }
          } catch (err) {
            console.error(
              `  ❌ Alert scrape error for ${email} / ${course.name} / ${date}:`,
              err.message
            );
          }
        }
      }

      // 🔹 ADDED: Update last run timestamp
      try {
        await db.query(
          `UPDATE user_preferences SET alert_last_run = now() WHERE email = $1`,
          [email]
        );
      } catch (err) {
        console.error(`⚠️ Failed to update alert_last_run for ${email}:`, err);
      }
    }

    console.log("🔔 Alert tick finished.");
  } catch (err) {
    console.error("❌ Alert worker tick failed:", err);
  }
}

// ---------------------------------------------------------
export function startAlertWorker() {
  const disabled = (process.env.ALERT_WORKER_ENABLED || "").toLowerCase();
  if (disabled === "0" || disabled === "false" || disabled === "off") {
    console.log("🔕 Alert worker disabled via ALERT_WORKER_ENABLED.");
    return;
  }

  console.log("🔔 Starting alert worker…");

  setTimeout(runAlertTick, 15000);
  setInterval(runAlertTick, 15 * 60 * 1000);
}

export async function runAlertTickOnce() {
  await runAlertTick();
}