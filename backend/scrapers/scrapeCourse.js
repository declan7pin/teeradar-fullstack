// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";   // ✅ FIXED — Cheerio has no default export

/**
 * Build a date-specific URL for the course.
 */
function buildCourseUrl(course, date) {
  if (!course.url) return null;
  if (!date) return course.url;

  const ymd = date.replace(/-/g, "");
  let url = course.url;

  // MiClub
  if (url.includes("selectedDate=")) {
    if (/selectedDate=\d{4}-\d{2}-\d{2}/.test(url)) {
      url = url.replace(/selectedDate=\d{4}-\d{2}-\d{2}/, "selectedDate=" + date);
    } else {
      const sep = url.includes("?") ? "&" : "?";
      url = url + sep + "selectedDate=" + date;
    }
  }

  // Quick18
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

/** Normalise times */
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

/** SCRAPE MiClub */
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

    if (time24 < earliest || time24 > latest) return;

    const rowText = $row.text();
    const taken = (rowText.match(/Taken/gi) || []).length;
    const available = Math.max(0, maxGroup - taken);

    if (available < partySize) return;

    let price = null;
    const priceMatch = rowText.match(/\$\s*\d+(\.\d+)?/);
    if (priceMatch) price = priceMatch[0].replace(/\s+/g, "");

    slots.push({
      name: course.name,
      provider: "miclub",
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

/** Quick18 - placeholder */
function scrapeQuick18Matrix() {
  return [];
}

/** No-scrape courses */
function scrapeInfoOnly() {
  return [];
}

/** Main export */
export async function scrapeCourse(course, criteria) {
  const url = buildCourseUrl(course, criteria.date);
  if (!url) return [];

  if (["phone", "info"].includes(course.provider)) {
    return scrapeInfoOnly(course, criteria);
  }

  let res;
  try {
    res = await fetch(url, { timeout: 15000 });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  const html = await res.text();

  if (course.provider === "miclub") {
    return scrapeMiClubTimesheet(html, course, criteria);
  }

  if (course.provider === "quick18") {
    return scrapeQuick18Matrix(html, course, criteria);
  }

  return scrapeMiClubTimesheet(html, course, criteria);
}


