// backend/scrapers/parseChronogolf.js

// Node 18+ has global fetch.

/**
 * Extract Chronogolf club_id, course_id and optional affiliation_type_ids
 * from the course object / URL.
 *
 * Example URL:
 *   https://www.chronogolf.com/club/16370/widget?medium=widget&source=club#?course_id=23233&nb_holes=18&date=2025-12-08&affiliation_type_ids=67260,67260,67260
 */
export function getChronogolfIds(course) {
  if (!course || !course.url) return null;

  try {
    const u = new URL(course.url);

    // club_id is the bit after /club/
    // e.g. /club/16370/widget
    const clubMatch = u.pathname.match(/\/club\/(\d+)/);
    const clubId = clubMatch ? clubMatch[1] : null;

    // course_id and affiliation_type_ids live in the hash
    // e.g. "#?course_id=23233&nb_holes=18&date=2025-12-08&affiliation_type_ids=67260,67260,67260"
    let courseId = null;
    let affiliationTypeIds = null;

    if (u.hash && u.hash.length > 1) {
      const hashStr = u.hash.replace(/^#\??/, ""); // remove leading "#?" or "#"
      const hashParams = new URLSearchParams(hashStr);

      const cId = hashParams.get("course_id");
      if (cId) courseId = cId;

      const aff = hashParams.get("affiliation_type_ids");
      if (aff) affiliationTypeIds = aff;
    }

    // Allow overriding via course JSON if you want later
    const finalClubId = course.chronogolfClubId || clubId;
    const finalCourseId = course.chronogolfCourseId || courseId;
    const finalAff = course.chronogolfAffiliationTypeIds || affiliationTypeIds || null;

    if (!finalClubId || !finalCourseId) {
      return null;
    }

    return {
      clubId: String(finalClubId),
      courseId: String(finalCourseId),
      affiliationTypeIds: finalAff,
    };
  } catch (err) {
    console.error("getChronogolfIds error for", course?.name, err.message);
    return null;
  }
}

/**
 * Build the Chronogolf API URL.
 *
 * Empirically these look like:
 *   https://api.chronogolf.com/clubs/{clubId}/teetimes?
 *      date=YYYY-MM-DD&course_id=23233&nb_holes=18&players=3&affiliation_type_ids=...
 */
export function buildChronogolfApiUrl({
  clubId,
  courseId,
  date,
  nbHoles,
  players,
  affiliationTypeIds,
}) {
  const params = new URLSearchParams();

  params.set("date", date);                           // YYYY-MM-DD
  params.set("course_id", String(courseId));
  params.set("nb_holes", String(nbHoles || 18));
  if (players) {
    params.set("players", String(players));
  }
  if (affiliationTypeIds) {
    params.set("affiliation_type_ids", affiliationTypeIds);
  }

  return `https://api.chronogolf.com/clubs/${clubId}/teetimes?${params.toString()}`;
}

/**
 * Build a booking URL for Chronogolf that lands on the chosen date.
 * We start from course.url and rewrite the hash:
 *   #?course_id=...&nb_holes=...&date=YYYY-MM-DD[&affiliation_type_ids=...]
 */
export function buildChronogolfBookingUrl(course, { date, nbHoles, ids }) {
  if (!course || !course.url) return null;

  try {
    const u = new URL(course.url);

    const courseId = ids?.courseId;
    const aff = ids?.affiliationTypeIds || null;
    const holes = nbHoles || course.holes || 18;

    const hashParams = new URLSearchParams();
    if (courseId) hashParams.set("course_id", String(courseId));
    hashParams.set("nb_holes", String(holes));
    if (date) hashParams.set("date", date);
    if (aff) hashParams.set("affiliation_type_ids", aff);

    u.hash = "?" + hashParams.toString();
    return u.toString();
  } catch (err) {
    console.error("buildChronogolfBookingUrl error for", course.name, err.message);
    return course.url;
  }
}

/**
 * Normalise the Chronogolf API response into TeeRadar slot objects.
 *
 * The exact shape can vary; we:
 *  - find the first array in the payload
 *  - pull out tee time, available spots, price if present
 */
export function parseChronogolfResponse(json, { course, criteria }) {
  if (!json) return [];

  let items = [];
  if (Array.isArray(json)) {
    items = json;
  } else {
    const firstArrayKey = Object.keys(json).find((k) => Array.isArray(json[k]));
    if (firstArrayKey) {
      items = json[firstArrayKey];
    }
  }

  const slots = [];
  const date = criteria.date; // YYYY-MM-DD

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    // Try a few candidate fields for the tee time
    const rawTime =
      item.time ||
      item.tee_time ||
      item.teeTime ||
      item.start_time ||
      item.startTime ||
      item.datetime ||
      null;

    if (!rawTime) continue;

    let timePart = String(rawTime).trim();

    // If ISO-like, strip date part
    const tIdx = timePart.indexOf("T");
    if (tIdx !== -1) {
      timePart = timePart.slice(tIdx + 1);
    }

    // Strip seconds + AM/PM
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
      item.available_spots ??
      item.availableSpots ??
      item.remaining ??
      item.capacity ??
      null;

    let price = null;
    if (typeof item.price === "number") {
      price = item.price;
    } else if (item.green_fee && typeof item.green_fee === "number") {
      price = item.green_fee;
    } else if (item.greenFee && typeof item.greenFee === "number") {
      price = item.greenFee;
    } else if (item.fee && typeof item.fee.amount === "number") {
      price = item.fee.amount;
    }

    slots.push({
      course: course.name,
      provider: "Chronogolf",
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
 */
export async function scrapeChronogolfCourse(course, criteria) {
  if (!criteria || !criteria.date) return [];

  const ids = getChronogolfIds(course);
  if (!ids) {
    console.warn("[Chronogolf] Missing IDs for course", course?.name);
    return [];
  }

  const nbHoles = Number(criteria.holes) || course.holes || 18;
  const players = criteria.partySize || 1;

  const apiUrl = buildChronogolfApiUrl({
    clubId: ids.clubId,
    courseId: ids.courseId,
    date: criteria.date,
    nbHoles,
    players,
    affiliationTypeIds: ids.affiliationTypeIds,
  });

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.chronogolf.com",
        Referer: course.url || "https://www.chronogolf.com",
      },
    });
  } catch (err) {
    console.error("Chronogolf fetch error for", course.name, err.message);
    return [];
  }

  if (!res.ok) {
    console.error(
      "Chronogolf HTTP error for",
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
    console.error("Chronogolf JSON parse error for", course.name, err.message);
    return [];
  }

  const slots = parseChronogolfResponse(json, { course, criteria });

  // Provide a booking URL with correct date baked in.
  const bookingUrl = buildChronogolfBookingUrl(course, {
    date: criteria.date,
    nbHoles,
    ids,
  });

  const enriched = slots.map((s) => ({
    ...s,
    bookingUrl: s.bookingUrl || bookingUrl || course.url || null,
  }));

  console.log(
    `[Chronogolf] ${course.name} — date=${criteria.date}, found ${enriched.length} slots`
  );

  return enriched;
}
