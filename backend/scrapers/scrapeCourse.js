// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const toCompactDate = (yyyy_mm_dd) => yyyy_mm_dd.replace(/-/g, "");

// HH:MM -> minutes since midnight
function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  return day === 0 || day === 6;
}

// Build MiClub URL with date + optional feeGroupId
function buildMiClubUrl(baseUrl, date, feeGroupId) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  if (u.searchParams.has("selectedDate")) {
    u.searchParams.set("selectedDate", date);
  } else {
    u.searchParams.append("selectedDate", date);
  }
  if (feeGroupId) {
    if (u.searchParams.has("feeGroupId")) {
      u.searchParams.set("feeGroupId", feeGroupId);
    } else {
      u.searchParams.append("feeGroupId", feeGroupId);
    }
  }
  if (u.searchParams.has("recaptchaResponse")) {
    u.searchParams.delete("recaptchaResponse");
  }
  return u.toString();
}

// Build Quick18 URL with teedate=YYYYMMDD
function buildQuick18Url(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  u.searchParams.set("teedate", toCompactDate(date));
  return u.toString();
}

// Try to parse slots from a MiClub HTML page
function parseMiClubSlots(html, earliest, latest) {
  const $ = cheerio.load(html);
  const minStart = toMinutes(earliest);
  const minEnd = toMinutes(latest);

  let bestSlots = 0;
  const timesFound = [];

  // This selector is a generic guess; you may need to tweak it
  $("table.timesheet tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (!cells.length) return;

    const timeText = $(cells[0]).text().trim(); // first cell usually time
    const mm = toMinutes(timeText);
    if (mm == null || mm < minStart || mm > minEnd) return;

    // look for a number of available spots in the row
    const rowText = $(tr).text();
    const matchSpots = rowText.match(/(\d+)\s*(spots|players|avail|available)?/i);
    let spots = 0;
    if (matchSpots) {
      spots = parseInt(matchSpots[1], 10);
      if (Number.isNaN(spots)) spots = 0;
    }

    if (spots > bestSlots) bestSlots = spots;
    timesFound.push(timeText + " (" + spots + ")");
  });

  // Cap at 4, because you care about a group-of-4 max
  bestSlots = Math.max(0, Math.min(4, bestSlots));
  return { slotsAvailable: bestSlots, timesFound };
}

// Try to parse slots from a Quick18 page (very generic)
function parseQuick18Slots(html, earliest, latest) {
  const $ = cheerio.load(html);
  const minStart = toMinutes(earliest);
  const minEnd = toMinutes(latest);

  let bestSlots = 0;
  const timesFound = [];

  // Generic: look for rows that contain a time and a number
  $("tr").each((_, tr) => {
    const rowText = $(tr).text();
    const timeMatch = rowText.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
    if (!timeMatch) return;

    const timeText = timeMatch[0];
    const mm = toMinutes(timeText);
    if (mm == null || mm < minStart || mm > minEnd) return;

    const matchSpots = rowText.match(/(\d+)\s*(spots|players|avail|available)?/i);
    let spots = 0;
    if (matchSpots) {
      spots = parseInt(matchSpots[1], 10);
      if (Number.isNaN(spots)) spots = 0;
    }

    if (spots > bestSlots) bestSlots = spots;
    timesFound.push(timeText + " (" + spots + ")");
  });

  bestSlots = Math.max(0, Math.min(4, bestSlots));
  return { slotsAvailable: bestSlots, timesFound };
}

/**
 * feeGroups: mapping from backend/data/fee_groups.json
 *  e.g. feeGroups["Whaleback Golf Course"]["9"] -> "1500344725"
 */
export async function scrapeCourse(course, criteria, feeGroups) {
  const { date, earliest, latest, holes, partySize } = criteria;

  // PHONE ONLY COURSES
  if (course.phoneOnly) {
    return [{
      name: course.name,
      provider: course.provider || "Phone",
      lat: course.lat,
      lng: course.lng,
      status: "phone",   // purple marker
      available: null,
      slotsAvailable: null,
      bookingUrl: course.phone ? `tel:${course.phone.replace(/\s+/g, "")}` : null,
      phone: course.phone || "",
      note: "Phone booking only",
      timeWindow: { earliest, latest },
      holesRequested: holes || "",
      spots: partySize
    }];
  }

  // Build provider-specific URL
  let finalUrl = course.url || "";
  try {
    if (course.provider === "MiClub") {
      let feeId = undefined;
      const courseMap = feeGroups?.[course.name];

      if (courseMap) {
        if (holes === "9" && (courseMap["9"] || courseMap["9_cart"])) {
          feeId = courseMap["9"] || courseMap["9_cart"];
        } else if (holes === "18") {
          feeId = courseMap["18"] || courseMap["18_cart"];
        } else {
          feeId = courseMap["18"] || courseMap["9"] || courseMap["18_cart"] || courseMap["9_cart"];
        }

        // Meadow Springs weekend override
        if (course.name.includes("Meadow Springs")) {
          if (holes === "9" && isWeekend(date) && courseMap["9_weekend"]) {
            feeId = courseMap["9_weekend"];
          }
          if (holes === "18" && isWeekend(date) && courseMap["18_weekend"]) {
            feeId = courseMap["18_weekend"];
          }
        }
      }

      finalUrl = buildMiClubUrl(course.url, date, feeId);
    } else if (course.provider === "Quick18") {
      finalUrl = buildQuick18Url(course.url, date);
    }
  } catch {
    finalUrl = course.url || "";
  }

  // Fetch the page
  let reachable = false;
  let html = "";
  try {
    const resp = await fetch(finalUrl, { method: "GET" });
    reachable = resp.ok;
    if (reachable) {
      html = await resp.text();
    }
  } catch {
    reachable = false;
  }

  // Default values
  let status = reachable ? "link" : "unknown";
  let slotsAvailable = null;
  let timesFound = [];

  if (reachable && html) {
    try {
      if (course.provider === "MiClub") {
        const parsed = parseMiClubSlots(html, earliest, latest);
        slotsAvailable = parsed.slotsAvailable;
        timesFound = parsed.timesFound;
      } else if (course.provider === "Quick18") {
        const parsed = parseQuick18Slots(html, earliest, latest);
        slotsAvailable = parsed.slotsAvailable;
        timesFound = parsed.timesFound;
      }
    } catch (e) {
      console.warn("parse error for", course.name, e.message);
    }
  }

  return [{
    name: course.name,
    provider: course.provider,
    lat: course.lat,
    lng: course.lng,
    status,
    available: slotsAvailable !== null && slotsAvailable > 0, // basic flag
    slotsAvailable,
    bookingUrl: finalUrl,
    timeWindow: { earliest, latest },
    holesRequested: holes || "",
    spots: partySize,
    timesFound: timesFound.slice(0, 6) // preview
  }];
}





