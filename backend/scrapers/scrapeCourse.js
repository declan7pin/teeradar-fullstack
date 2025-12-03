// backend/scrapers/scrapeCourse.js
import { parseMiClub } from "./parseMiClub.js";
import { parseQuick18 } from "./parseQuick18.js";
import { scrapeTeeItUpCourse } from "./parseTeeItUp.js";

/**
 * Turn "HH:MM" into minutes from midnight
 */
function toMinutes(t) {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/**
 * Build a MiClub timesheet URL for a course + date,
 * using fee_groups.json where available.
 *
 * FALLBACK:
 * - If fee_groups.json doesn't specify bookingResourceId / feeGroupId,
 *   we pull them from course.url instead (this is what Fremantle needs).
 */
function buildMiClubUrl(course, criteria, feeGroups = {}) {
  const courseUrl = course.url || "";
  const [courseBase, courseQuery] = courseUrl.split("?");

  const cfg = feeGroups[course.name] || {};

  // Base URL: prefer cfg.baseUrl, then the base part of course.url
  const base = (cfg.baseUrl || courseBase || "").trim();

  // Existing params from course.url (if any)
  const existingParams = new URLSearchParams(courseQuery || "");

  const bookingResourceId =
    cfg.bookingResourceId ||
    existingParams.get("bookingResourceId") ||
    "3000000";

  const feeGroupId =
    cfg.feeGroupId ||
    existingParams.get("feeGroupId") ||
    null;

  const params = new URLSearchParams();
  params.set("bookingResourceId", bookingResourceId);
  params.set("selectedDate", criteria.date);
  if (feeGroupId) params.set("feeGroupId", feeGroupId);
  params.set("mobile", "true");

  return `${base}?${params.toString()}`;
}

/**
 * Build a Quick18 searchmatrix URL for a course + date.
 */
function buildQuick18Url(course, criteria) {
  const base = (course.quick18Url || course.url || "").split("?")[0];
  if (!criteria.date) return base;
  const yyyymmdd = criteria.date.replace(/-/g, "");
  return `${base}?teedate=${yyyymmdd}`;
}

/**
 * Scrape a MiClub course and return *filtered* slots,
 * only where availableSpots >= partySize, and time in range.
 */
async function scrapeMiClubCourse(course, criteria, feeGroups) {
  const url = buildMiClubUrl(course, criteria, feeGroups);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("MiClub fetch failed", course.name, res.status);
    return [];
  }

  const html = await res.text();
  const rawSlots = parseMiClub(html);

  const earliest = criteria.earliest || "06:00";
  const latest = criteria.latest || "17:00";
  const earliestMin = toMinutes(earliest);
  const latestMin = toMinutes(latest);
  const partySize = Number(criteria.partySize || 1);
  const requestedHoles = criteria.holes ? Number(criteria.holes) : null;

  const filtered = rawSlots.filter((slot) => {
    if (!slot.time) return false;

    const mins = toMinutes(slot.time);
    if (mins < earliestMin || mins > latestMin) return false;

    // Only enforce holes filter for MiClub (courses are explicitly 9 or 18)
    if (requestedHoles && course.holes && Number(course.holes) !== requestedHoles) {
      return false;
    }

    const maxPlayers = slot.maxPlayers || 4;
    const players = slot.players || 0;
    const availableSpots = maxPlayers - players;

    if (availableSpots < partySize) return false;

    return slot.available !== false; // default to true if missing
  });

  const mapped = filtered.map((slot) => {
    const maxPlayers = slot.maxPlayers || 4;
    const players = slot.players || 0;
    const availableSpots = maxPlayers - players;
    const courseName = course.name;

    return {
      course: courseName,
      courseName,
      courseTitle: courseName,
      course_name: courseName,

      provider: "MiClub",
      date: criteria.date,
      time: slot.time,
      holes: course.holes || null,
      price: null,
      maxPlayers,
      playersBooked: players,
      availableSpots,
      bookUrl: url,
    };
  });

  console.log(
    `MiClub → ${course.name} → ${mapped.length} slots (after partySize filter)`
  );

  return mapped;
}

/**
 * Scrape a Quick18 course and return *filtered* slots.
 *
 * NOTE: Quick18 courses are treated as suitable for BOTH
 * 9 and 18-hole searches, because e.g. Armadale is a 9-hole
 * layout that can be played twice to make 18.
 */
async function scrapeQuick18Course(course, criteria) {
  const url = buildQuick18Url(course, criteria);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Quick18 fetch failed", course.name, res.status);
    return [];
  }

  const html = await res.text();
  const rawSlots = parseQuick18(html);

  const earliest = criteria.earliest || "06:00";
  const latest = criteria.latest || "17:00";
  const earliestMin = toMinutes(earliest);
  const latestMin = toMinutes(latest);
  const partySize = Number(criteria.partySize || 1);

  const filtered = rawSlots.filter((slot) => {
    if (!slot.time) return false;
    const mins = toMinutes(slot.time);
    if (mins < earliestMin || mins > latestMin) return false;

    const maxPlayers = slot.spots || 4;
    if (maxPlayers < partySize) return false;

    // We do NOT filter on criteria.holes here,
    // so these courses appear for both 9- and 18-hole searches.
    return true;
  });

  const mapped = filtered.map((slot) => {
    const courseName = course.name;

    return {
      course: courseName,
      courseName,
      courseTitle: courseName,
      course_name: courseName,

      provider: "Quick18",
      date: criteria.date,
      time: slot.time,
      holes: course.holes || null,
      price: slot.price || null,
      maxPlayers: slot.spots || 4,
      playersBooked: 0,
      availableSpots: slot.spots || 4,
      bookUrl: url,
    };
  });

  console.log(
    `Quick18 → ${course.name} → ${mapped.length} slots (after partySize filter)`
  );

  return mapped;
}

/**
 * Main entry point used by server.js
 */
export async function scrapeCourse(course, criteria, feeGroups = {}) {
  try {
    // Phone-only / "Other" / non-scrapable providers:
    // keep them on the map but they don't contribute slots.
    if (course.provider === "Phone" || course.provider === "Other") {
      console.log(`Non-scrapable provider → ${course.name}`);
      return [];
    }

    const requestedHoles = criteria.holes ? Number(criteria.holes) : null;

    // 🔹 Skip MiClub courses that don't match the requested holes,
    //     so we don't waste time fetching them.
    if (
      course.provider === "MiClub" &&
      requestedHoles &&
      course.holes &&
      Number(course.holes) !== requestedHoles
    ) {
      console.log(
        `Skipping ${course.name} – course is ${course.holes} holes, user requested ${requestedHoles}`
      );
      return [];
    }

    if (course.provider === "MiClub") {
      return await scrapeMiClubCourse(course, criteria, feeGroups);
    }

    if (course.provider === "Quick18") {
      return await scrapeQuick18Course(course, criteria);
    }

    if (course.provider === "TeeItUp") {
      return await scrapeTeeItUpCourse(course, criteria);
    }

    console.log(`Unknown provider for course: ${course.name}`, course.provider);
    return [];
  } catch (err) {
    console.error("scrapeCourse error for", course.name, err.message);
    return [];
  }
}

export default scrapeCourse;