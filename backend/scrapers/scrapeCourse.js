// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";   // Cheerio 2+ has no default export

/**
 * Build a date-specific URL for the course.
 */
function buildCourseUrl(course, date) {
  if (!course.url) return null;
  if (!date) return course.url;

  const ymd = date.replace(/-/g, "");
  let url = course.url;

  // MiClub style: selectedDate=YYYY-MM-DD
  if (url.includes("selectedDate=")) {
    if (/selectedDate=\d{4}-\d{2}-\d{2}/.test(url)) {
      url = url.replace(/selectedDate=\d{4}-\d{2}-\d{2}/, "selectedDate=" + date);
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

/** Normalise e.g. “12:33 pm” → “12:33” (24h) */
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

/** Scrape MiClub timesheet HTML for slots */
function scrapeMiClubTimesheet(html, course, criteria) {
  const { earliest, latest, partySize } = criteria;
  const maxGroup = 4;

  const $ = cheerio.load(html);
  const slots = [];

  $(".row-time").each((_, row) => {
    const $row = $(row);

    const timeLabel = $row.find(".time-wrapper h3").first().text().trim();
    const time24 = normaliseTimeTo24h(timeLabel);
    if (!time24) return;

    // filter by user’s chosen time window
    if (time24 < earliest || time24 > latest) return;

    const rowText = $row.text();

    // count “Taken” occurrences in the row
    const taken = (rowText.match(/Taken/gi) || []).length;
    const available = Math.max(0, maxGroup - taken);

    // need enough spots for this group size
    if (available < partySize) return;

    let price = null;
    const priceMatch = rowText.match(/\$\s*\d+(\.\d+)?/);
    if (priceMatch) {
      price = priceMatch[0].replace(/\s+/g, "");
    }

    slots.push({
      name: course.name,
      provider: course.provider || "Unknown",  // ✅ keep original provider label
      holes: course.holes || null,
      time: time24,
      spots: available,
      price,
      url: course.url,
      lat: course.lat,
      lng: course.lng
    });
  });

  return slots;
}

/** Quick18 – placeholder for now */
function scrapeQuick18Matrix(html, course, criteria) {
  // We haven’t implemented a full Quick18 parser yet,
  // so treat it as “no structured slots found”.
  return [];
}

/** Info / phone courses – no scraping, just return nothing */
function scrapeInfoOnly() {
  return [];
}

/** Main export called from server.js */
export async function scrapeCourse(course, criteria) {
  const url = buildCourseUrl(course, criteria.date);
  if (!url) return [];

  // “phone” or “info” providers – we don’t scrape, just let the UI show
  // the phone number or info banner.
  if (
    course.provider &&
    course.provider.toLowerCase &&
    ["phone", "info"].includes(course.provider.toLowerCase())
  ) {
    return scrapeInfoOnly(course, criteria);
  }

  let res;
  try {
    res = await fetch(url, { timeout: 15000 });
  } catch (err) {
    console.warn("fetch failed for", course.name, err.message);
    return [];
  }

  if (!res.ok) {
    console.warn("non-200 for", course.name, res.status);
    return [];
  }

  const html = await res.text();

  const providerLower = (course.provider || "").toLowerCase();

  if (providerLower.includes("miclub")) {
    return scrapeMiClubTimesheet(html, course, criteria);
  }

  if (providerLower.includes("quick18")) {
    return scrapeQuick18Matrix(html, course, criteria);
  }

  // default: assume MiClub-like layout
  return scrapeMiClubTimesheet(html, course, criteria);
}
