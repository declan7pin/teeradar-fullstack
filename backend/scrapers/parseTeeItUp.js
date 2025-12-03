// backend/scrapers/parseTeeItUp.js

const fetch = require("node-fetch");

/**
 * Try to pull the TeeItUp `course` id out of the course object / URL.
 * e.g. https://gailes-golf-club.book-v2.teeitup.golf/?course=15309&date=...
 */
function getTeeItUpCourseId(course) {
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
 * NOTE: This mirrors the booking URL you sent:
 *   course=15309&date=2025-12-04&holes=18&max=999999
 * and we add `golfers` from the search criteria.
 */
function buildTeeItUpApiUrl({ courseId, date, holes, golfers }) {
  const params = new URLSearchParams();

  params.set("course", courseId);
  params.set("date", date);                    // YYYY-MM-DD from your filters
  params.set("holes", String(holes || 18));    // 9 / 18
  params.set("golfers", String(golfers || 1)); // party size
  params.set("max", "999999");

  return `https://phx-api.teeitup.com/api/v1/public/availability?${params.toString()}`;
}

/**
 * Normalise the TeeItUp API response into TeeRadar slot objects.
 * This is written defensively because we haven't inspected the JSON
 * payload yet – but it should get us most of the way there.
 */
function parseTeeItUpResponse(json, { course, criteria }) {
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
async function scrapeTeeItUpCourse(course, criteria) {
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
      timeout: 10000,
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

  // Helpful logging while we’re dialing this in
  console.log(
    `[TeeItUp] ${course.name} — date=${criteria.date}, found ${slots.length} slots`
  );

  return slots;
}

module.exports = {
  getTeeItUpCourseId,
  buildTeeItUpApiUrl,
  parseTeeItUpResponse,
  scrapeTeeItUpCourse,
};
