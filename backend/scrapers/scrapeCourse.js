// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const toCompactDate = (yyyy_mm_dd) => yyyy_mm_dd.replace(/-/g, "");

// HH:MM → minutes since midnight
function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getUTCDay(); // 0=Sun,6=Sat
  return day === 0 || day === 6;
}

// Build MiClub URL with date + feeGroupId (when provided)
function buildMiClubUrl(baseUrl, date, feeGroupId) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  // date
  if (u.searchParams.has("selectedDate")) u.searchParams.set("selectedDate", date);
  else u.searchParams.append("selectedDate", date);
  // fee group (if known)
  if (feeGroupId) {
    if (u.searchParams.has("feeGroupId")) u.searchParams.set("feeGroupId", feeGroupId);
    else u.searchParams.append("feeGroupId", feeGroupId);
  }
  // remove any stale recaptchaResponse if present
  if (u.searchParams.has("recaptchaResponse")) u.searchParams.delete("recaptchaResponse");
  return u.toString();
}

// Build Quick18 URL with teedate=YYYYMMDD
function buildQuick18Url(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  u.searchParams.set("teedate", toCompactDate(date));
  return u.toString();
}

// Extract visible HH:MM tokens from a page and filter by time window
function extractTimesWithin(html, earliest, latest) {
  const minStart = toMinutes(earliest);
  const minEnd = toMinutes(latest);
  // grab common HH:MM occurrences
  const re = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;
  const times = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const mm = toMinutes(m[0]);
    if (mm !== null && mm >= minStart && mm <= minEnd) {
      times.push(m[0]);
    }
  }
  return times;
}

/**
 * feeGroups: mapping object loaded by server, e.g. feeGroups[course.name]["9"] -> id
 */
export async function scrapeCourse(course, criteria, feeGroups) {
  const { date, earliest, latest, holes, partySize } = criteria;

  // PHONE-ONLY
  if (course.phoneOnly) {
    return [{
      name: course.name,
      provider: course.provider || "Phone",
      lat: course.lat, lng: course.lng,
      available: true,
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
      // choose feeGroupId based on holes (+ weekend/cart where relevant)
      let feeId = undefined;
      const courseMap = feeGroups?.[course.name];
      if (courseMap) {
        if (holes === "9" && (courseMap["9"] || courseMap["9_cart"])) {
          feeId = courseMap["9"] || courseMap["9_cart"];
        } else if (holes === "18") {
          // prefer non-cart 18, else cart
          feeId = courseMap["18"] || courseMap["18_cart"];
        } else {
          // if no holes specified but only cart exists, pick 18_cart as fallback
          feeId = courseMap["18"] || courseMap["9"] || courseMap["18_cart"] || courseMap["9_cart"];
        }
        // Meadow Springs weekend override
        if (course.name.includes("Meadow Springs")) {
          if (holes === "9" && isWeekend(date) && courseMap["9_weekend"]) feeId = courseMap["9_weekend"];
          if (holes === "18" && isWeekend(date) && courseMap["18_weekend"]) feeId = courseMap["18_weekend"];
        }
      }
      finalUrl = buildMiClubUrl(course.url, date, feeId);
    } else if (course.provider === "Quick18") {
      finalUrl = buildQuick18Url(course.url, date);
    }
  } catch {
    finalUrl = course.url || "";
  }

  // Fetch page
  let ok = false, html = "";
  try {
    const resp = await fetch(finalUrl, { method: "GET" });
    ok = resp.ok;
    html = ok ? (await resp.text()) : "";
  } catch {
    ok = false;
  }

  // Default: not available if unreachable
  if (!ok) {
    return [{
      name: course.name,
      provider: course.provider,
      lat: course.lat, lng: course.lng,
      available: false,
      bookingUrl: finalUrl,
      timeWindow: { earliest, latest },
      holesRequested: holes || "",
      spots: partySize
    }];
  }

  // QUICK checks:
  // 1) MiClub often prints this when truly empty:
  const hasNoRows = /No\s+rows\s+meeting\s+selected\s+criteria/i.test(html);
  if (hasNoRows) {
    return [{
      name: course.name,
      provider: course.provider,
      lat: course.lat, lng: course.lng,
      available: false,
      bookingUrl: finalUrl,
      timeWindow: { earliest, latest },
      holesRequested: holes || "",
      spots: partySize
    }];
  }

  // 2) Look for at least one time within window
  const timesInWindow = extractTimesWithin(html, earliest, latest);
  const available = timesInWindow.length > 0;

  return [{
    name: course.name,
    provider: course.provider,
    lat: course.lat, lng: course.lng,
    available,
    bookingUrl: finalUrl,
    timesFound: timesInWindow.slice(0, 5), // small preview
    timeWindow: { earliest, latest },
    holesRequested: holes || "",
    spots: partySize
  }];
}




