// backend/scrapers/scrapeCourse.js

import courses from "../data/courses.json" assert { type: "json" };
import feeGroups from "../data/fee_groups.json" assert { type: "json" };
import { parseMiClub } from "./parseMiClub.js";
import { parseQuick18 } from "./parseQuick18.js";
import { buildMiClubUrl } from "../utils/buildMiClubUrl.js";

// If you're on Node 18+ you already have global fetch.
// If you were importing node-fetch before, you can keep that import instead.

export async function scrapeCourse(course, criteria) {
  try {
    // 🟢 MiClub courses (Wembley, Meadow Springs, Whaleback, Collier, etc.)
    if (course.provider === "MiClub") {
      const feeInfo = feeGroups[course.name];

      // Build the scrape URL for MiClub based on your stored URL + correct date/feeGroup
      const scrapeUrl = (() => {
        const base = new URL(course.url);

        // Completely reset query params to avoid stale junk
        base.search = "";

        if (feeInfo?.bookingResourceId) {
          base.searchParams.set("bookingResourceId", feeInfo.bookingResourceId);
        }

        if (feeInfo?.feeGroupId) {
          base.searchParams.set("feeGroupId", feeInfo.feeGroupId);
        }

        // Always use the search date (YYYY-MM-DD)
        base.searchParams.set("selectedDate", criteria.date);

        return base.toString();
      })();

      const html = await fetch(scrapeUrl).then((r) => r.text());
      const teeTimes = parseMiClub(html); // 🔁 your known-working parser

      const filtered = teeTimes.filter((slot) => {
        // Must have at least 1 free spot
        if (!slot.available) return false;

        const freeSpots = slot.maxPlayers - slot.players;

        // Respect party size
        if (criteria.partySize && freeSpots < criteria.partySize) return false;

        // Time window filter (HH:MM string compared lexicographically works)
        if (criteria.earliest && slot.time < criteria.earliest) return false;
        if (criteria.latest && slot.time > criteria.latest) return false;

        return true;
      });

      const deepLink = buildMiClubUrl(course.name, criteria.date);

      return filtered.map((slot) => ({
        course: course.name,
        provider: "MiClub",
        date: criteria.date,
        time: slot.time,
        holes: course.holes,
        availableSpots: slot.maxPlayers - slot.players,
        maxPlayers: slot.maxPlayers,
        status: slot.status,
        bookUrl: deepLink, // 👈 always the clean deep link using fee_groups + date
      }));
    }

    // 🟠 Quick18 (Armadale / The Springs, Hamersley, Lake Claremont)
    if (course.provider === "Quick18") {
      const teedate = criteria.date.replace(/-/g, ""); // 2025-11-21 → 20251121
      const searchUrl = `${course.quick18Url}?teedate=${teedate}`;

      const html = await fetch(searchUrl).then((r) => r.text());

      // Your working Quick18 parser (you pasted this)
      const slots = parseQuick18(html, course, criteria);

      return slots.map((slot) => ({
        course: slot.name,
        provider: "Quick18",
        date: slot.date,
        time: slot.time,
        holes: slot.holes,
        availableSpots: slot.spots,
        maxPlayers: 4,
        price: slot.price,
        bookUrl: slot.bookUrl, // already built in parseQuick18
      }));
    }

    // 🟣 Phone-only courses (Hillview, Marri Park, etc.)
    if (course.provider === "Phone") {
      return [
        {
          course: course.name,
          provider: "Phone",
          date: criteria.date,
          time: null,
          holes: course.holes,
          availableSpots: null,
          maxPlayers: null,
          phone: course.phone || null,
          bookUrl: null,
        },
      ];
    }

    // 🟡 Other providers (e.g. Sanctuary, Pemberton site)
    if (course.provider === "Other") {
      return [
        {
          course: course.name,
          provider: course.provider,
          date: criteria.date,
          time: null,
          holes: course.holes,
          availableSpots: null,
          maxPlayers: null,
          bookUrl: course.url || null,
        },
      ];
    }

    // Fallback: unknown provider → do nothing
    return [];
  } catch (err) {
    console.error(
      `scrapeCourse failed for ${course.name}:`,
      err?.message || err
    );
    return [];
  }
}

export default scrapeCourse;