// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";

const toCompactDate = (yyyy_mm_dd) => yyyy_mm_dd.replace(/-/g, "");

// HH:MM -> minutes since midnight, used only if you later want to do more time logic
function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
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
  // these recaptcha tokens go stale quickly, so strip if present
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
          // no holes specified: pick a sensible default
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

  // We only check that the page is reachable, not the true availability
  let reachable = false;
  try {
    const resp = await fetch(finalUrl, { method: "GET" });
    reachable = resp.ok;
  } catch {
    reachable = false;
  }

  return [{
    name: course.name,
    provider: course.provider,
    lat: course.lat,
    lng: course.lng,
    status: reachable ? "link" : "unknown",
    available: null,              // we don't claim to know
    bookingUrl: finalUrl,
    timeWindow: { earliest, latest },
    holesRequested: holes || "",
    spots: partySize
  }];
}




