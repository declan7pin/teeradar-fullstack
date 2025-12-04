// backend/scrapers/parseTeeItUp.js

// Node 18+ has global fetch, so we *could* use it, but for TeeItUp we are
// no longer doing a server-side availability fetch because their site is
// behind Cloudflare and uses React Server Components instead of a simple
// public JSON API.

/**
 * Try to pull the TeeItUp `course` id out of the course object / URL.
 * e.g. https://gailes-golf-club.book-v2.teeitup.golf/?course=15309&date=...
 * (Currently unused, but kept here in case we ever get an official API.)
 */
export function getTeeItUpCourseId(course) {
  if (!course) return null;

  // Optional explicit id if we ever store it in JSON later
  if (course.teeItUpCourseId) return String(course.teeItUpCourseId);

  if (course.url) {
    try {
      const u = new URL(course.url);
      const id = u.searchParams.get("course");
      if (id) return String(id);
    } catch (_) {
      // ignore URL parse failure
    }
  }

  return null;
}

/**
 * Build a *booking* URL for TeeItUp so the user lands on the right date.
 * We start from course.url (e.g. https://gailes-golf-club.book-v2.teeitup.golf/?course=15309)
 * and just force the date param.
 */
export function buildTeeItUpBookingUrl(course, date) {
  if (!course || !course.url) return null;

  try {
    const u = new URL(course.url);

    if (date) {
      // TeeItUp booking pages generally accept ?date=YYYY-MM-DD
      u.searchParams.set("date", date);
    }

    return u.toString();
  } catch (err) {
    console.error("buildTeeItUpBookingUrl error for", course.name, err.message);
    return course.url;
  }
}

/**
 * (Kept for future use, but NOT used now.)
 * If TeeItUp ever exposes a proper JSON availability API, we can wire it
 * up through this parser.
 */
export function parseTeeItUpResponse(json, { course, criteria }) {
  if (!json) return [];

  let items = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (Array.isArray(json.availability)) {
    items = json.availability;
  } else if (Array.isArray(json.availableTeeTimes)) {
    items = json.availableTeeTimes;
  } else if (Array.isArray(json.teeTimes)) {
    items = json.teeTimes;
  } else {
    const firstArrayKey = Object.keys(json).find(
      (k) => Array.isArray(json[k])
    );
    if (firstArrayKey) {
      items = json[firstArrayKey];
    }
  }

  const slots = [];
  const date = criteria.date; // YYYY-MM-DD

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const rawTime =
      item.teeTime ||
      item.tee_time ||
      item.time ||
      item.startTime ||
      item.start_time ||
      null;

    if (!rawTime) continue;

    let timePart = String(rawTime).trim();

    const tIdx = timePart.indexOf("T");
    if (tIdx !== -1) {
      timePart = timePart.slice(tIdx + 1);
    }

    timePart = timePart
      .replace(/([AP]M)$/i, "")
      .replace(/\s+[AP]\.?M\.?/i, "")
      .trim();

    const hhmmMatch = timePart.match(/^(\d{1,2}):(\d{2})/);
    if (!hhmmMatch) continue;

    const hh = hhmmMatch[1].padStart(2, "0");
    const mm = hhmmMatch[2];

    const isoStart = `${date}T${hh}:${mm}:00`;

    const availableSpots =
      item.availableSpots ??
      item.available_spots ??
      item.spotsAvailable ??
      item.spots ??
      item.capacity ??
      null;

    let price = null;
    if (item.price && typeof item.price === "number") {
      price = item.price;
    } else if (item.greenFee && typeof item.greenFee === "number") {
      price = item.greenFee;
    } else if (item.fee && typeof item.fee.amount === "number") {
      price = item.fee.amount;
    }

    slots.push({
      course: course.name,
      provider: "TeeItUp",
      state: course.state || null,
      holes: criteria.holes ? Number(criteria.holes) : course.holes || 18,
      partySize: criteria.partySize || null,
      time: isoStart,
      availableSpots,
      price,
      raw: item,
    });
  }

  return slots;
}

/**
 * Main entry: used by scrapeCourse.js
 *
 * We NO LONGER scrape live availability for TeeItUp because:
 *  - The booking site uses Cloudflare and React Server Components,
 *  - There is no stable public JSON API to call from Node.
 *
 * Instead, we return no slots and let the front-end send users directly
 * to the official TeeItUp booking page for the chosen date.
 */
export async function scrapeTeeItUpCourse(course, criteria) {
  if (!criteria || !criteria.date) {
    return [];
  }

  const bookingUrl = buildTeeItUpBookingUrl(course, criteria.date);

  console.log(
    `[TeeItUp] Skipping server-side availability scrape for ${
      course?.name || "(unknown)"
    } — click-through only. bookingUrl=${bookingUrl || course?.url || "none"}`
  );

  // No server-side slots; MiClub + Quick18 will still return real slots.
  return [];
}
