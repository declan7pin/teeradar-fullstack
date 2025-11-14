// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio"; // Cheerio v2+ has no default export

/**
 * Build a date-specific URL for the course.
 *
 * We assume courses.json stores a working example link,
 * and we only adjust the date parameter:
 *   - MiClub:  selectedDate=YYYY-MM-DD
 *   - Quick18: teedate=YYYYMMDD
 */
function buildCourseUrl(course, date) {
  if (!course.url) return null;
  if (!date) return course.url;

  const ymd = date.replace(/-/g, "");
  let url = course.url;

  // MiClub style
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

  // Quick18 style
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
 * Normalise something like "12:33 pm" -> "12:33" (24h).
 */
function normaliseTimeTo24h(label) {
  if (!label) return null;

  // Try to catch "06:30", "6:30 am", "6:30pm"
  const m = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;

  let [, hh, mm, ampm] = m;
  let hour = parseInt(hh, 10);

  if (ampm) {
    const isPM = ampm.toLowerCase() === "pm";
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0; // 12am -> 00:xx
  }

  return `${hour.toString().padStart(2, "0")}:${mm}`;
}

/**
 * SCRAPE: MiClub timesheet (Whaleback, Collier, Wembley, Araluen, etc.).
 *
 * Uses .row-time blocks from the HTML:
 *  - time from .time-wrapper h3
 *  - count occurrences of "Taken" in that block
 *  - group size = 4 → available = max(0, 4 - taken)
 *  - only return rows with available >= partySize, and time in window
 *
 * Holes come from course.holes in courses.json (manual, reliable).
 */
function scrapeMiClubTimesheet(html, course, criteria, bookingUrlForDate) {
  const { earliest, latest, partySize } = criteria;
  const maxGroupSize = 4;

  const $ = cheerio.load(html);
  const slots = [];

  $(".row-time").each((_, rowEl) => {
    const $row = $(rowEl);

    const timeLabel = $row.find(".time-wrapper h3").first().text().trim();
    const time24 = normaliseTimeTo24h(timeLabel);
    if (!time24) return;

    if (time24 < earliest || time24 > latest) return;

    const rowText = $row.text();
    const takenCount = (rowText.match(/Taken/gi) || []).length;
    const availableSpots = Math.max(0, maxGroupSize - takenCount);

    if (availableSpots < partySize) return;

    let price = null;
    const priceMatch = rowText.match(/\$\s*\d+(\.\d+)?/);
    if (priceMatch) {
      price = priceMatch[0].replace(/\s+/g, "");
    }

    slots.push({
      name: course.name,
      provider: course.provider || "miclub",
      holes: course.holes || null,
      time: time24,
      spots: availableSpots,
      price,
      // Date-specific URL, not the static example
      url: bookingUrlForDate || course.url,
      lat: course.lat,
      lng: course.lng
    });
  });

  return slots;
}

/**
 * SCRAPE: Quick18 matrix (Hamersley, The Springs / Armadale).
 *
 * This implementation assumes the /searchmatrix endpoint returns JSON or
 * JSON-like text. If parsing fails or the structure is unknown, we
 * return [] so the course shows as “Tap to check times” but we don't
 * claim any availability.
 */
function scrapeQuick18Matrix(body, course, criteria, bookingUrlForDate) {
  const { earliest, latest, partySize } = criteria;
  const maxGroupSize = 4;
  const slots = [];

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    console.warn(`Quick18: response for ${course.name} is not valid JSON yet.`, err.message);
    return [];
  }

  // Quick18 can come back in different shapes. We try a couple of common ones.

  let teeTimesArray = null;

  // Case 1: data is already an array
  if (Array.isArray(data)) {
    teeTimesArray = data;
  }

  // Case 2: object with a "teeTimes" or "matrix" array
  if (!teeTimesArray && data && typeof data === "object") {
    if (Array.isArray(data.teeTimes)) teeTimesArray = data.teeTimes;
    else if (Array.isArray(data.matrix)) teeTimesArray = data.matrix;
    else if (Array.isArray(data.rows)) teeTimesArray = data.rows;
  }

  if (!teeTimesArray) {
    console.warn(`Quick18: unrecognised JSON structure for ${course.name}`);
    return [];
  }

  teeTimesArray.forEach((row) => {
    if (!row) return;

    // Try to extract a time string from a likely field
    const rawTime =
      row.time ||
      row.Time ||
      row.StartTime ||
      row.startTime ||
      row.teeTime ||
      row.tee_time;

    const time24 = normaliseTimeTo24h(String(rawTime || ""));
    if (!time24) return;

    if (time24 < earliest || time24 > latest) return;

    // Try to get available spots from a likely field
    const rawSpots =
      row.availableSpots ??
      row.AvailableSpots ??
      row.spots ??
      row.Spots ??
      row.openSpots ??
      row.OpenSpots;

    let availableSpots = Number(rawSpots);
    if (!Number.isFinite(availableSpots)) {
      // If no explicit field, we fall back to a simple heuristic:
      // Quick18 often uses groupSize (4) minus bookedCount.
      const booked =
        row.bookedCount ??
        row.BookedCount ??
        row.booked ??
        row.Booked ??
        0;
      const used = Number(booked) || 0;
      availableSpots = Math.max(0, maxGroupSize - used);
    }

    if (availableSpots < partySize) return;

    slots.push({
      name: course.name,
      provider: course.provider || "quick18",
      holes: course.holes || null,
      time: time24,
      spots: availableSpots,
      price: null, // most Quick18 JSON doesn't carry a clean price here
      url: bookingUrlForDate || course.url,
      lat: course.lat,
      lng: course.lng
    });
  });

  return slots;
}

/**
 * Phone/info-only courses: no scraping; just show them on map/list.
 */
function scrapeInfoOnly(_course, _criteria) {
  return [];
}

/**
 * Main exported function used by server.js
 */
export async function scrapeCourse(course, criteria) {
  const { date } = criteria;
  const provider = (course.provider || "").toLowerCase();

  // Phone / info courses never have live availability
  if (provider === "phone" || provider === "info") {
    return scrapeInfoOnly(course, criteria);
  }

  const bookingUrlForDate = buildCourseUrl(course, date);
  if (!bookingUrlForDate) {
    console.warn(`No URL for course "${course.name}"`);
    return [];
  }

  let res;
  try {
    res = await fetch(bookingUrlForDate, { timeout: 15000 });
  } catch (err) {
    console.warn(`Error fetching ${course.name}:`, err.message);
    return [];
  }

  if (!res.ok) {
    console.warn(`Fetch failed for ${course.name}:`, res.status);
    return [];
  }

  const body = await res.text();

  if (provider.includes("miclub")) {
    return scrapeMiClubTimesheet(body, course, criteria, bookingUrlForDate);
  }

  if (provider.includes("quick18")) {
    return scrapeQuick18Matrix(body, course, criteria, bookingUrlForDate);
  }

  // default: treat unknown provider as MiClub-like HTML
  return scrapeMiClubTimesheet(body, course, criteria, bookingUrlForDate);
}

