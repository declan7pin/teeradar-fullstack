// backend/scrapers/scrapeCourse.js
import db from "../db.js"; // ✅ needed for TeeRadarBooking provider

import { parseMiClub } from "./parseMiClub.js";
import { parseQuick18 } from "./parseQuick18.js";
import { scrapeChronogolfCourse } from "./parseChronogolf.js";
import { scrapeTeeItUpCourse } from "./parseTeeItUp.js";

/**
 * Turn "HH:MM" into minutes from midnight
 */
function toMinutes(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
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

  const feeGroupId = cfg.feeGroupId || existingParams.get("feeGroupId") || null;

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
 * ✅ Pull availability from TeeRadar Booking system (your own DB)
 * This lets Hillview show up in the map search results like MiClub/Quick18.
 */
async function scrapeTeeRadarBookingCourse(course, criteria) {
  const date = criteria?.date;
  if (!date) return [];

  const earliest = criteria.earliest || "06:00";
  const latest = criteria.latest || "17:00";
  const earliestMin = toMinutes(earliest);
  const latestMin = toMinutes(latest);

  const partySize = Number(criteria.partySize || 1);
  const requestedHoles = criteria.holes ? Number(criteria.holes) : null;

  // booking slug can come from course.bookingSlug, or fallback to id/name
  const slug = String(
    course.bookingSlug || course.slug || course.id || course.name || ""
  )
    .trim()
    .toLowerCase();

  if (!slug) {
    console.warn(
      "TeeRadarBooking: missing bookingSlug/slug/id for course:",
      course?.name
    );
    return [];
  }

  const c = await db.query(
    `SELECT id, name FROM booking_courses WHERE LOWER(slug) = LOWER($1) LIMIT 1;`,
    [slug]
  );

  const courseId = c.rows[0]?.id || null;

  // ✅ IMPORTANT: emit the exact courses.json name so frontend grouping matches markers
  const courseName = String(course.name || c.rows[0]?.name || slug);

  console.log("🟦 TeeRadarBooking name check:", {
    coursesJsonName: course.name,
    bookingCoursesName: c.rows[0]?.name,
    emittedSlotCourseName: courseName,
    slug,
  });

  if (!courseId) {
    console.warn("TeeRadarBooking: booking_courses not found for slug:", slug);
    return [];
  }

  const q = `
    SELECT
      bt.play_date,
      bt.tee_time,
      bt.holes,
      bt.max_players,
      bt.price_per_player_cents,
      COALESCE(SUM(bb.players), 0)::int AS booked_players
    FROM booking_times bt
    LEFT JOIN booking_bookings bb
      ON bb.course_id = bt.course_id
     AND bb.play_date = bt.play_date
     AND bb.tee_time  = bt.tee_time
     AND bb.holes     = bt.holes
     AND bb.status    = 'CONFIRMED'
    WHERE bt.course_id = $1
      AND bt.play_date = $2::date
      AND bt.status = 'AVAILABLE'
      ${requestedHoles ? "AND bt.holes = $4" : ""}
    GROUP BY
      bt.play_date,
      bt.tee_time,
      bt.holes,
      bt.max_players,
      bt.price_per_player_cents
    HAVING (bt.max_players - COALESCE(SUM(bb.players), 0)) >= $3
    ORDER BY bt.tee_time ASC;
  `;

  const params = requestedHoles
    ? [courseId, date, partySize, requestedHoles]
    : [courseId, date, partySize];

  const r = await db.query(q, params);

  const SITE_URL = (process.env.SITE_URL || "https://teeradar.com.au").trim();

  const out = [];
  for (const row of r.rows || []) {
    const t = String(row.tee_time || "").trim();
    const mins = toMinutes(t);

    if (earliestMin !== null && mins !== null && mins < earliestMin) continue;
    if (latestMin !== null && mins !== null && mins > latestMin) continue;

    const holes =
      Number(row.holes) || (course.holes ? Number(course.holes) : null) || 18;

    const maxPlayers = Number(row.max_players || 4);

    // ✅ FIX: these were missing (caused Hillview to be red + broke builds)
    const playersBooked = Number(row.booked_players || 0);
    const remaining = Math.max(0, maxPlayers - playersBooked);

    out.push({
      course: courseName,
      courseName,
      courseTitle: courseName,
      course_name: courseName,

      provider: "TeeRadarBooking",
      date,
      time: t,
      holes,
      price: null,

      // ✅ keep existing fields
      maxPlayers,
      playersBooked,

      // ✅ ADD: emit snake_case + variants so normalizeRemaining() ALWAYS detects capacity
      max_players: maxPlayers,
      booked_players: playersBooked,
      bookedPlayers: playersBooked,

      remaining, // ✅ your strict logic needs this
      spotsAvailable: remaining, // ✅ some UIs read this
      playersAvailable: remaining, // ✅ some UIs read this too
      availableSpots: remaining, // keep your existing naming too

      bookUrl: `${SITE_URL}/book/${slug}`,

      // optional extra (won't break anything if UI ignores it)
      pricePerPlayerCents: Number(row.price_per_player_cents || 0),
    });
  }

  console.log(
    `TeeRadarBooking → ${courseName} → ${out.length} slots (after partySize filter)`
  );

  return out;
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
    if (mins === null || earliestMin === null || latestMin === null) return false;
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
    if (mins === null || earliestMin === null || latestMin === null) return false;
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

    // ✅ TeeRadar booking system (Hillview etc.)
    if (course.provider === "TeeRadarBooking") {
      return await scrapeTeeRadarBookingCourse(course, criteria);
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

    // ✅ Chronogolf support
    if (course.provider === "Chronogolf") {
      return await scrapeChronogolfCourse(course, criteria);
    }

    console.log(`Unknown provider for course: ${course.name}`, course.provider);
    return [];
  } catch (err) {
    console.error("scrapeCourse error for", course.name, err.message);
    return [];
  }
}

export default scrapeCourse;