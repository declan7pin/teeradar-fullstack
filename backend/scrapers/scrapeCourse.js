// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio"; // Cheerio v2+ has no default export

/**
 * Build a date-specific URL for the course.
 *
 * We assume courses.json stores a working example link for that course
 * and we just adjust the date part each time.
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

  // MiClub style: selectedDate=YYYY-MM-DD
  if (url.includes("selectedDate=")) {
    if (/selectedDate=\d{4}-\d{2}-\d{2}/.test(url)) {
      url = url.replace(
        /selectedDate=\d{4}-\d{2}-\d{2}/,
        "selectedDate=" + date
      );
    } else {
      const sep = url.includes("?") ? "&" : "?";
      url = url + sep + "selectedDate=" + date;
    }
  }

  // Quick18 style: teedate=YYYYMMDD
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
 * Normalise something like "12:33 pm" -> "12:33" in 24h.
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
    if (!isPM && hour === 12) hour = 0; // 12am -> 00
  }

  return `${hour.toString().padStart(2, "0")}:${mm}`;
}

/**
 * SCRAPE: MiClub sheet (Whaleback, Collier, Wembley, Araluen, etc.)
 *
 * Logic (relying on your page source):
 *  - Each tee group is rendered as a `.row-time` block.
 *  - We read its time from `.time-wrapper h3`.
 *  - We count how many times "Taken" appears in that block.
 *  - Group size = 4, so available spots = max(0, 4 - takenCount).
 *  - Only return rows where availableSpots >= partySize AND time in window.
 *
 * Holes are taken from `course.holes` in courses.json (manual mapping).
 */
function scrapeMiClubTimesheet(html, course, criteria) {
  const { earliest, latest, partySize } = criteria;
  const maxGroupSize = 4;

  const $ = cheerio.load(html);
  const slots = [];

  $(".row-time").each((_, rowEl) => {
    const $row = $(rowEl);

    // 1) Time like "12:33 pm"
    const timeLabel = $row.find(".time-wrapper h3").first().text().trim();
    const time24 = normaliseTimeTo24h(timeLabel);
    if (!time24) return;

    // 2) Filter by user's time window
    if (time24 < earliest || time24 > latest) return;

    // 3) Count "Taken" in the row to estimate used spots
    const rowText = $row.text();
    const takenCount = (rowText.match(/Taken/gi) || []).length;
    const availableSpots = Math.max(0, maxGroupSize - takenCount);

    if (availableSpots < partySize) return;

    // 4) Optional: grab a price
    let price = null;
    const priceMatch = rowText.match(/\$\s*\d+(\.\d+)?/);
    if (priceMatch) {
      price = priceMatch[0].replace(/\s+/g, "");
    }

    slots.push({
      name: course.name,
      provider: course.provider || "MiClub",
      holes: course.holes || null,      // ✅ reliable: manual mapping in courses.json
      time: time24,
      spots: availableSpots,
      price,
      url: course.url,
      lat: course.lat,
      lng: course.lng
    });
  });

  return slots;
}

/**
 * SCRAPE: Quick18 matrix (Hamersley, Armadale / The Springs).
 *
 * For now we leave this as a placeholder that returns no structured slots,
 * so they show on the map / list with "Tap to check times", but we don't
 * try to infer live availability incorrectly.
 *
 * You can wire this later once we inspect a Quick18 JSON payload.
 */
function scrapeQuick18Matrix(_html, _course, _criteria) {
  // TODO: implement when we have a captured Quick18 response
  return [];
}

/**
 * Phone-only / info-only courses: we do NOT scrape.
 * Hillview & Marri Park just show a phone number and "Phone to book".
 */
function scrapeInfoOnly(_course, _criteria) {
  return [];
}

/**
 * Main export used by backend/server.js
 *
 * course:   one entry from backend/data/courses.json
 * criteria: { date, earliest, latest, holes, partySize }
 */
export async function scrapeCourse(course, criteria) {
  const { date } = criteria;

  const provider = (course.provider || "").toLowerCase();

  // Phone / info courses never have live availability
  if (provider === "phone" || provider === "info") {
    return scrapeInfoOnly(course, criteria);
  }

  const url = buildCourseUrl(course, date);
  if (!url) {
    console.warn(`No URL for course "${course.name}"`);
    return [];
  }

  let res;
  try {
    res = await fetch(url, { timeout: 15000 });
  } catch (err) {
    console.warn(`Error fetching ${course.name}:`, err.message);
    return [];
  }

  if (!res.ok) {
    console.warn(`Fetch failed for ${course.name}:`, res.status);
    return [];
  }

  const html = await res.text();

  if (provider.includes("miclub")) {
    return scrapeMiClubTimesheet(html, course, criteria);
  }

  if (provider.includes("quick18")) {
    return scrapeQuick18Matrix(html, course, criteria);
  }

  // Default: treat unknown providers as MiClub-like HTML
  return scrapeMiClubTimesheet(html, course, criteria);
}
