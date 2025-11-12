// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";

const toCompactDate = (yyyy_mm_dd) => yyyy_mm_dd.replace(/-/g, "");

function buildMiClubUrl(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  if (u.searchParams.has("selectedDate")) {
    u.searchParams.set("selectedDate", date);
  } else {
    u.searchParams.append("selectedDate", date);
  }
  return u.toString();
}

function buildQuick18Url(baseUrl, date) {
  if (!baseUrl) return "";
  const u = new URL(baseUrl);
  u.searchParams.set("teedate", toCompactDate(date));
  return u.toString();
}

export async function scrapeCourse(course, criteria) {
  const { date, earliest, latest, holes, partySize } = criteria;

  // Phone-only: return a tel link as the bookingUrl and mark as available (so users can call)
  if (course.phoneOnly) {
    return [{
      name: course.name,
      provider: course.provider || "Phone",
      lat: course.lat, lng: course.lng,
      available: true,
      bookingUrl: `tel:${(course.phone || "").replace(/\s+/g, "")}`,
      phone: course.phone || "",
      note: "Phone booking only",
      timeWindow: { earliest, latest },
      holesRequested: holes || "",
      spots: partySize
    }];
  }

  // Build provider-specific URL for the selected date
  let finalUrl = course.url || "";
  try {
    if (course.provider === "MiClub") finalUrl = buildMiClubUrl(course.url, date);
    else if (course.provider === "Quick18") finalUrl = buildQuick18Url(course.url, date);
  } catch {
    finalUrl = course.url || "";
  }

  // Attempt to reach the page
  let ok = false;
  try {
    const resp = await fetch(finalUrl, { method: "GET" });
    ok = resp.ok;
  } catch {
    ok = false;
  }

  return [{
    name: course.name,
    provider: course.provider,
    lat: course.lat, lng: course.lng,
    available: ok,
    bookingUrl: finalUrl,
    timeWindow: { earliest, latest },
    holesRequested: holes || "",
    spots: partySize
  }];
}




