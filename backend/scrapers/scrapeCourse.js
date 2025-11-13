// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import cheerio from "cheerio";

/**
 * Build a date-specific URL for the course.
 * We assume courses.json stores a working example link and we just
 * replace the date part.
 *
 * Supports:
 *   - MiClub:  ?selectedDate=YYYY-MM-DD
 *   - Quick18: ?teedate=YYYYMMDD
 */
function buildCourseUrl(course, date) {
  if (!course.url) return null;
  if (!date) return course.url;

  const ymd = date.replace(/-/g, "");

  let url = course.url;

  // MiClub style: ...selectedDate=2025-11-05...
  if (url.includes("selectedDate=")) {
    if (/selectedDate=\d{4}-\d{2}-\d{2}/.test(url)) {
      url = url.replace(/selectedDate=\d{4}-\d{2}-\d{2}/, "selectedDate=" + date);
    } else {
      const sep = url.includes("?") ? "&" : "?";
      url = url + sep + "selectedDate=" + date;
    }
  }

  // Quick18 style: ...teedate=20251105...
  if (url.includes("teedate=")) {
    if (/teedate=\d{8}/.test(url)) {
      url = url.replace(/teedate=\d{8}/, "teedate=" + ymd);
    } else {
      const sep = url.includes("?") ? "&" : "?";
      url = url + sep + "teedate=" + ymd;
    }
  }

  return url;
}

/**
 * Convert "12:33 pm" → "12:33" (24-hour HH:MM)
 */
function normaliseTimeTo24h(label) {
  if (!label) return null;
  const m = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;

  let [, hh, mm, ampm] = m;
  let hour = parseInt(hh, 10);

  if (ampm) {
    const isPM = ampm.toLowerCase() === "pm";
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
  }

  return `${hour.toString().padStart(2, "0")}:${mm}`;
}

/**
 * Parse a MiClub timesheet and return available slots.
 *
 * Logic:
 *  - Each `.row-time` = one tee time / playing group (max 4 players).
 *  - We read the full text of the row and count occurrences of "Taken".
 *  - availableSpots = max(0, 4 - takenCount).
 *  - Only return rows where availableSpots >= requested party size AND
 *    time is inside the requested window.
 */
function scrapeMiClubTimesheet(html, course, criteria) {
  const { earliest, latest, partySize } = criteria;
  const maxGroupSize = 4;

  const $ = cheerio.load(html);
  const slots = [];

  $(".row-time").each((_, rowEl) => {
    const $row = $(rowEl);

    // 1) Time text (e.g. "12:33 pm")
    const timeLabel = $row.find(".time-wrapper h3").first().text().trim();
    const time24 = normaliseTimeTo24h(timeLabel);
    if (!time24) return;

    // 2) Filter by time window (HH:MM string compare is fine)
    if (time24 < earliest || time24 > latest) return;

    // 3) Count how many players are already taken in this group
    const rowText = $row.text();
    const takenCount = (rowText.match(/Taken/gi) || []).length;
    const availableSpots = Math.max(0, maxGroupSize - takenCount);

    if (availableSpots < partySize) return;

    // 4) Try to grab a price (first "$xx.xx" we see)
    let price = null;
    const priceMatch = rowText.match(/\$\s*\d+(\.\d+)?/);
    if (priceMatch) {
      price = priceMatch[0].replace(/\s+/g, "");
    }

    slots.push({
      name: course.name,
      provider: course.provider || "MiClub",
      holes: course.holes || null,
      time: time24,
      spots: availableSpots,
      price,
      url: course.url, // front-end still uses this to send user to booking
      lat: course.lat,
      lng: course.lng
    });
  });

  return slots;
}

/**
 * Placeholder Quick18 scraper.
 *
 * Right now this returns an empty list so Quick18 courses (Hamersley)
 * always appear as "Unavailable" in the UI. This is safer than giving
 * incorrect availability. We can wire proper Quick18 parsing later.
 */
function scrapeQuick18Matrix(_html, _course, _criteria) {
  return [];
}

/**
 * For "info/phone" type providers we don't scrape at all:
 * they never report live availability.
 */
function scrapeInfoOnly(_course, _criteria) {
  return [];
}

/**
 * Main exported function used by the backend.
 *
 * course:  one entry from backend/data/courses.json
 * criteria: { date, earliest, latest, holes, partySize }
 */
export async function scrapeCourse(course, criteria) {
  const { date } = criteria;

  // phone/info courses never have live availability
  if (course.provider === "phone" || course.provider === "info") {
    return scrapeInfoOnly(course, criteria);
  }

  const url = buildCourseUrl(course, date);
  if (!url) {
    console.warn(`No URL for course "${course.name}"`);
    return [];
  }

  let res;
  try {
    res = await fetch(url, {
      // 15 second timeout is usually enough for MiClub
      // (Render/node-fetch doesn’t support timeout natively in all versions,
      // but leaving this here doesn't hurt.)
      timeout: 15000
    });
  } catch (err) {
    console.warn(`Error fetching ${course.name}:`, err.message);
    return [];
  }

  if (!res.ok) {
    console.warn(`Failed fetch for ${course.name}: ${res.status}`);
    return [];
  }

  const html = await res.text();

  if ((course.provider || "").toLowerCase() === "miclub") {
    return scrapeMiClubTimesheet(html, course, criteria);
  }

  if ((course.provider || "").toLowerCase() === "quick18") {
    return scrapeQuick18Matrix(html, course, criteria);
  }

  // Default: treat like MiClub (safe fallback for other similar sites)
  return scrapeMiClubTimesheet(html, course, criteria);
}




