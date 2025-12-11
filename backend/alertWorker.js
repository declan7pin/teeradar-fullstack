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
// Helpers
// ---------------------------------------------------------

function normaliseDayToken(token) {
  if (!token) return null;
  const t = token.toString().trim().toLowerCase();
  if (!t) return null;

  // allow things like "monday", "Mon", "MON"
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

// Next date (YYYY-MM-DD) matching target DOW (0=Sun..6=Sat)
function nextDateForDow(targetDow) {
  const now = new Date();
  const todayDow = now.getDay();
  let delta = (targetDow - todayDow + 7) % 7;
  // allow "today" if delta === 0
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

// Fallback: if user didn't pick any days, just use today
function resolveDatesFromPreferredDays(preferredDays) {
  if (!Array.isArray(preferredDays) || preferredDays.length === 0) {
    return [nextDateForDow(new Date().getDay())];
  }

  const dows = new Set();
  for (const d of preferredDays) {
    const dow = normaliseDayToken(d);
    if (dow !== null) dows.add(dow);
  }
  if (!dows.size) {
    return [nextDateForDow(new Date().getDay())];
  }

  return Array.from(dows).map((dow) => nextDateForDow(dow));
}

function findCourseByFavourite(fav) {
  if (!fav) return null;
  // UI usually stores { name, id, provider, ... }
  const name = fav.name || fav.courseName || fav.course || null;
  if (!name) return null;

  // Strict name match first
  let course = courses.find((c) => c.name === name);
  if (course) return course;

  // Loose includes match as fallback
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
        p.preferred_party_size
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

      for (const fav of favourites) {
        const course = findCourseByFavourite(fav);
        if (!course) {
          console.log(
            `  ⚠️ Could not match favourite to course.json:`,
            fav
          );
          continue;
        }

        for (const date of datesToScan) {
          const criteria = {
            date,
            earliest,
            latest,
            holes: holes === 0 ? "" : holes,
            partySize: partySize || 1,
            state: (course.state || "").toUpperCase() || null,
          };

          try {
            const result = await scrapeCourse(course, criteria, feeGroups);
            const count = Array.isArray(result) ? result.length : 0;

            if (count > 0) {
              console.log(
                `  ✅ ${email} – ${course.name} on ${date}: ${count} slot(s) found.`
              );
              // NEXT STEP: send email / push notification here.
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
    }

    console.log("🔔 Alert tick finished.");
  } catch (err) {
    console.error("❌ Alert worker tick failed:", err);
  }
}

// ---------------------------------------------------------
// Public entrypoint used by server.js
// ---------------------------------------------------------

export function startAlertWorker() {
  const disabled = (process.env.ALERT_WORKER_ENABLED || "").toLowerCase();
  if (disabled === "0" || disabled === "false" || disabled === "off") {
    console.log("🔕 Alert worker disabled via ALERT_WORKER_ENABLED.");
    return;
  }

  console.log("🔔 Starting alert worker…");

  // run once shortly after boot, then every 15 minutes
  setTimeout(runAlertTick, 15000);
  setInterval(runAlertTick, 15 * 60 * 1000);
}

// Optional: allow manual trigger when importing directly in scripts
export async function runAlertTickOnce() {
  await runAlertTick();
}