// backend/scrapers/parseTeeItUp.js

// Node 18+ has global fetch, so we can use it directly.
// If you prefer node-fetch, you could:
//   import fetch from "node-fetch";

/**
 * Try to pull the TeeItUp `course` id out of the course object / URL.
 * e.g. https://gailes-golf-club.book-v2.teeitup.golf/?course=15309&date=...
 */
export function getTeeItUpCourseId(course) {
  if (!course) return null;

  // optional explicit id if we ever store it in JSON later
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
 * Build the TeeItUp public availability API URL.
 * Mirrors:
 *   course=15309&date=2025-12-04&holes=18&max=999999&golfers=3
 */
export function buildTeeItUpApiUrl({ courseId, date, holes, golfers }) {
  const params = new URLSearchParams();

  params.set("course", courseId);
  params.set("date", date);                    // YYYY-MM-DD
  params.set("holes", String(holes || 18));    // 9 / 18
  params.set("golfers", String(golfers || 1)); // party size
  params.set("max", "999999");

  return `https://phx-api.teeitup.com/api/v1/public/availability?${params.toString()}`;
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
 * Normalise the TeeItUp API response into TeeRadar slot objects.
 */
export function parseTeeItUpResponse(json, { course, criteria }) {
  if (!json) return [];

  // If the API returns an object with a known "root" array, grab it.
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
    // last resort: find the first array in any property
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

    // Try to find a time field – TeeItUp naming is guessed here.
    const rawTime =
      item.teeTime ||
      item.tee_time ||
      item.time ||
      item.startTime ||
      item.start_time ||
      null;

    if (!rawTime) continue;

    // Normalise time to "HH:MM"
    let timePart = String(rawTime).trim();

    // If ISO-ish (2025-12-04T06:30:00), strip the date.
    const tIdx = timePart.indexOf("T");
    if (tIdx !== -1) {
      timePart = timePart.slice(tIdx + 1);
    }

    // Strip seconds and AM/PM if present.
    timePart = timePart
      .replace(/([AP]M)$/i, "")
      .replace(/\s+[AP]\.?M\.?/i, "")
      .trim();

    // Now we expect something like "06:30" or "6:30"
    const hhmmMatch = timePart.match(/^(\d{1,2}):(\d{2})/);
    if (!hhmmMatch) continue;

    const hh = hhmmMatch[1].padStart(2, "0");
    const mm = hhmmMatch[2];

    // Build an ISO-like local datetime string; frontend just treats this as local.
    const isoStart = `${date}T${hh}:${mm}:00`;

    // Available spots / capacity
    const availableSpots =
      item.availableSpots ??
      item.available_spots ??
      item.spotsAvailable ??
      item.spots ??
      item.capacity ??
      null;

    // Price guess (various possible shapes)
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
      raw: item, // keep raw so we can inspect later if needed
    });
  }

  return slots;
}

/**
 * Main entry: used by scrapeCourse.js
 */
export async function scrapeTeeItUpCourse(course, criteria) {
  const courseId = getTeeItUpCourseId(course);

  if (!courseId || !criteria || !criteria.date) {
    return [];
  }

  const apiUrl = buildTeeItUpApiUrl({
    courseId,
    date: criteria.date,
    holes: Number(criteria.holes) || course.holes || 18,
    golfers: criteria.partySize || 1,
  });

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        // These mimick a normal browser request; usually not strictly required
        Origin: course.url || "https://teeitup.golf",
        Referer: course.url || "https://teeitup.golf",
      },
      // Node 22 fetch supports AbortSignal, but we’ll keep it simple for now
    });
  } catch (err) {
    console.error("TeeItUp fetch error for", course.name, err.message);
    return [];
  }

  if (!res.ok) {
    console.error(
      "TeeItUp HTTP error for",
      course.name,
      res.status,
      res.statusText
    );
    return [];
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("TeeItUp JSON parse error for", course.name, err.message);
    return [];
  }

  const slots = parseTeeItUpResponse(json, { course, criteria });

  // Attach a booking URL with the *search date* baked in, so the front-end can just open it.
  const bookingUrl = buildTeeItUpBookingUrl(course, criteria.date);

  const enriched = slots.map((s) => ({
    ...s,
    bookingUrl: s.bookingUrl || bookingUrl || course.url || null,
  }));

  console.log(
    `[TeeItUp] ${course.name} — date=${criteria.date}, found ${enriched.length} slots`
  );

  return enriched;
}