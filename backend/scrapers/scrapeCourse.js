// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";

/**
 * Main entry point used by server.js
 * @param {object} course - course object from courses.json
 * @param {object} criteria - { date, earliest, latest, holes, partySize }
 * @param {object} feeGroups - feeGroups mapping (currently unused, but kept for future)
 */
export async function scrapeCourse(course, criteria, feeGroups = {}) {
  // If user selected holes (9 or 18), skip courses that don't match
  if (criteria.holes && Number(course.holes) !== Number(criteria.holes)) {
    return [];
  }

  // Phone-only / "Other" providers don't have live times
  if (course.provider === "Phone" || course.provider === "Other") {
    return [];
  }

  try {
    if (course.provider === "MiClub") {
      return await scrapeMiClub(course, criteria);
    }

    if (course.provider === "Quick18") {
      return await scrapeQuick18(course, criteria);
    }

    // Unknown provider
    return [];
  } catch (err) {
    console.error(`scrapeCourse failed for ${course.name}:`, err.message);
    return [];
  }
}

/* ----------------- Helpers ------------------- */

function timeToMinutes(t) {
  // t like "06:00" or "6:00"
  const [h, m] = String(t).split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function parseTimeStringTo24h(str) {
  // Matches "7:00 am", "10:30PM" etc.
  const match = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3].toLowerCase();

  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

function filterTimesByWindow(times, earliest, latest) {
  const earliestMin = timeToMinutes(earliest);
  const latestMin = timeToMinutes(latest);
  if (earliestMin == null || latestMin == null) return times;

  return times.filter((t) => {
    const mins = timeToMinutes(t);
    if (mins == null) return false;
    return mins >= earliestMin && mins <= latestMin;
  });
}

/* ----------------- MiClub ------------------- */

async function scrapeMiClub(course, criteria) {
  // Build URL with selectedDate from user input
  const urlObj = new URL(course.url);
  urlObj.searchParams.set("selectedDate", criteria.date);
  const url = urlObj.toString();

  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) {
    console.error(
      `MiClub fetch failed for ${course.name}: ${res.status} ${res.statusText}`
    );
    return [];
  }

  const html = await res.text();

  // Very generic regex for tee times like "7:00 am", "10:15 PM"
  const timeRegex = /(\d{1,2}:\d{2}\s*(?:am|pm))/gi;
  const rawTimes = new Set();
  let match;
  while ((match = timeRegex.exec(html)) !== null) {
    const time24 = parseTimeStringTo24h(match[0]);
    if (time24) rawTimes.add(time24);
  }

  const allTimes = Array.from(rawTimes).sort();
  const timesInWindow = filterTimesByWindow(
    allTimes,
    criteria.earliest,
    criteria.latest
  );

  // Build slot objects
  const slots = timesInWindow.map((t) => ({
    courseName: course.name,
    provider: "MiClub",
    date: criteria.date,
    time: t,
    holes: course.holes,
    players: criteria.partySize,
    bookingUrl: url, // takes user to correct date on MiClub
  }));

  return slots;
}

/* ----------------- Quick18 ------------------- */

async function scrapeQuick18(course, criteria) {
  // Quick18 uses "teedate=YYYYMMDD"
  const quick18Date = criteria.date.replace(/-/g, ""); // "2025-11-21" -> "20251121"
  const urlObj = new URL(course.url);
  urlObj.searchParams.set("teedate", quick18Date);
  const url = urlObj.toString();

  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) {
    console.error(
      `Quick18 fetch failed for ${course.name}: ${res.status} ${res.statusText}`
    );
    return [];
  }

  const html = await res.text();

  // Quick18 pages also display tee times as "7:00 AM", etc.
  const timeRegex = /(\d{1,2}:\d{2}\s*(?:am|pm))/gi;
  const rawTimes = new Set();
  let match;
  while ((match = timeRegex.exec(html)) !== null) {
    const time24 = parseTimeStringTo24h(match[0]);
    if (time24) rawTimes.add(time24);
  }

  const allTimes = Array.from(rawTimes).sort();
  const timesInWindow = filterTimesByWindow(
    allTimes,
    criteria.earliest,
    criteria.latest
  );

  const slots = timesInWindow.map((t) => ({
    courseName: course.name,
    provider: "Quick18",
    date: criteria.date,
    time: t,
    holes: course.holes,
    players: criteria.partySize,
    bookingUrl: url, // goes to Quick18 matrix on that date
  }));

  return slots;
}