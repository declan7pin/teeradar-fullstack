// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";

/**
 * Turn 2025-11-05 into 20251105
 */
function toCompactDate(dateStr) {
  return dateStr.replace(/-/g, "");
}

/**
 * For MiClub URLs we saw:
 *  ...ViewPublicTimesheet.msp?bookingResourceId=3000000&selectedDate=2025-11-05
 * We'll just replace selectedDate if it exists, or append it.
 */
function buildMiClubUrl(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  // if there's selectedDate already, overwrite
  if (u.searchParams.has("selectedDate")) {
    u.searchParams.set("selectedDate", date);
  } else {
    u.searchParams.append("selectedDate", date);
  }
  return u.toString();
}

/**
 * For quick18 (Hamersley) we saw:
 *  https://hamersley.quick18.com/teetimes/searchmatrix?teedate=20251105
 */
function buildQuick18Url(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  u.searchParams.set("teedate", toCompactDate(date));
  return u.toString();
}

/**
 * Very light "scrape" - we're not doing deep HTML parsing here.
 * We'll just check if the page loaded. Frontend will still have the real link.
 */
export async function scrapeCourse(course, criteria) {
  const { date, earliest, latest, holes, partySize } = criteria;

  // phone-only courses -> no scraping, just return a "call" slot
  if (course.phoneOnly) {
    return [
      {
        name: course.name,
        provider: course.provider || "Phone",
        lat: course.lat,
        lng: course.lng,
        available: true,
        time: null,
        holes: null,
        spots: null,
        bookingUrl: `tel:${course.phone}`,
        phone: course.phone,
        note: "Phone booking only"
      }
    ];
  }

  // build the right URL for the provider
  let finalUrl = course.url;
  try {
    if (course.provider === "MiClub") {
      finalUrl = buildMiClubUrl(course.url, date);
    } else if (course.provider === "Quick18") {
      finalUrl = buildQuick18Url(course.url, date);
    }
  } catch (e) {
    // if URL building fails, we'll fall back to base URL
    finalUrl = course.url;
  }

  // try to fetch
  let ok = false;
  try {
    const resp = await fetch(finalUrl, { method: "GET" });
    ok = resp.ok;
    // we could inspect HTML here for specific time strings,
    // but most of these pages are dynamic/protected, so we just mark as reachable.
  } catch (err) {
    ok = false;
  }

  return [
    {
      name: course.name,
      provider: course.provider,
      lat: course.lat,
      lng: course.lng,
      // say it's available only if we could reach the page
      available: ok,
      // we keep the user's filters so the frontend can display them
      timeWindow: { earliest, latest },
      holesRequested: holes || "",
      spots: partySize,
      bookingUrl: finalUrl
    }
  ];
}



