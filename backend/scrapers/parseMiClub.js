// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Parse MiClub public timesheet HTML and extract tee times with
 * accurate availability per tee-time (0–4 players).
 *
 * This version is designed to work generically across MiClub sites,
 * including the ones you use (Whaleback, Collier, Araluen, etc.).
 *
 * It returns objects shaped so your existing scrapeCourse logic
 * can keep working:
 *   {
 *     time: "HH:MM",          // 24h time string
 *     status: "available" | "full",
 *     players: number,        // booked players
 *     maxPlayers: number,     // total slots (usually 4)
 *     available: boolean,     // at least 1 free slot
 *     bookingLink: string|null
 *   }
 */
export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  const fullText = $.root().text();

  // ---------- PRIMARY PARSER ----------
  // Split into “rows” using the “Click to select row.” marker MiClub uses
  const segments = fullText.split(/Click to select row\./i);

  segments.forEach((segment) => {
    // Find a time like "02:01 pm" or "7:15 am"
    const timeMatch = segment.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return;

    const rawTime = timeMatch[1];
    const ampm = (timeMatch[2] || "").toUpperCase();

    let [hStr, mStr] = rawTime.split(":");
    let h = parseInt(hStr, 10);

    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;

    const time24 = `${String(h).padStart(2, "0")}:${mStr}`;

    // Count how many player slots are Available/Taken in this row
    const availableMatches = segment.match(/Available/gi) || [];
    const takenMatches = segment.match(/Taken/gi) || [];

    const availableSpots = availableMatches.length;
    const takenSpots = takenMatches.length;
    const totalSpots = availableSpots + takenSpots;

    if (totalSpots === 0) {
      // If for some odd reason there are no explicit “Available/Taken”
      // but it’s still a bookable row, assume standard 4-ball.
      if (/Book Now/i.test(segment)) {
        results.push({
          time: time24,
          status: "available",
          players: 0,
          maxPlayers: 4,
          available: true,
          bookingLink: null,
        });
      }
      return;
    }

    const players = totalSpots - availableSpots;
    const status = availableSpots > 0 ? "available" : "full";

    results.push({
      time: time24,
      status,
      players,
      maxPlayers: totalSpots,
      available: availableSpots > 0,
      bookingLink: null, // we use your existing course URL builder for deep links
    });
  });

  // ---------- FALLBACK #1 ----------
  // Older/odd MiClub layouts: use table rows with TimeSlotRow class
  if (results.length === 0) {
    $("tr.TimeSlotRow").each((_, el) => {
      const row = $(el);

      const rawTime =
        row.find(".TimeSlotTime").text().trim() ||
        row.find("td").first().text().trim();

      if (!rawTime) return;

      const basicTime = (rawTime.match(/(\d{1,2}:\d{2})/) || [])[1];
      if (!basicTime) return;

      const time24 = basicTime; // assume already HH:MM in these layouts

      const rowText = row.text();
      const availableMatches = rowText.match(/Available/gi) || [];
      const takenMatches = rowText.match(/Taken/gi) || [];

      const availableSpots = availableMatches.length;
      const takenSpots = takenMatches.length;
      const totalSpots = (availableSpots + takenMatches.length) || 4;
      const players = totalSpots - availableSpots;

      const bookingLink =
        row.find('a[href*="TimesheetBooking"]').attr("href") || null;

      results.push({
        time: time24,
        status: availableSpots > 0 ? "available" : "full",
        players,
        maxPlayers: totalSpots,
        available: availableSpots > 0,
        bookingLink,
      });
    });
  }

  // ---------- FALLBACK #2 (Meadow Springs & other weird layouts) ----------
  // If we STILL have nothing, try a very generic table parser:
  // - Look for rows with a time AND either a TimesheetBooking link or "Book"
  // - Try to infer availability from "1/4", "2 of 4", etc.
  if (results.length === 0) {
    $("tr").each((_, el) => {
      const row = $(el);
      const rowText = row.text().replace(/\s+/g, " ").trim();
      if (!rowText) return;

      // Any time like "7:15 am" or "14:03"
      const timeMatch = rowText.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
      if (!timeMatch) return;

      const rawTime = timeMatch[1];
      const ampm = (timeMatch[2] || "").toUpperCase();

      let [hStr, mStr] = rawTime.split(":");
      let h = parseInt(hStr, 10);

      if (ampm === "PM" && h !== 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;

      const time24 = `${String(h).padStart(2, "0")}:${mStr}`;

      const hasBookingLink =
        row.find('a[href*="TimesheetBooking"]').length > 0 ||
        /Book/i.test(rowText);

      if (!hasBookingLink) return;

      // Try to detect patterns like "1/4", "2 / 4", "1 of 4", etc.
      let players = 0;
      let maxPlayers = 4;

      const fractionMatch = rowText.match(/(\d+)\s*\/\s*(\d+)/);
      const ofMatch = rowText.match(/(\d+)\s*of\s*(\d+)/i);

      if (fractionMatch) {
        const booked = parseInt(fractionMatch[1], 10);
        const total = parseInt(fractionMatch[2], 10);
        if (!Number.isNaN(booked) && !Number.isNaN(total) && total > 0) {
          maxPlayers = total;
          players = booked;
        }
      } else if (ofMatch) {
        const booked = parseInt(ofMatch[1], 10);
        const total = parseInt(ofMatch[2], 10);
        if (!Number.isNaN(booked) && !Number.isNaN(total) && total > 0) {
          maxPlayers = total;
          players = booked;
        }
      }

      const availableSpots = Math.max(maxPlayers - players, 0);
      const status = availableSpots > 0 ? "available" : "full";

      results.push({
        time: time24,
        status,
        players,
        maxPlayers,
        available: availableSpots > 0,
        bookingLink: row
          .find('a[href*="TimesheetBooking"]')
          .attr("href") || null,
      });
    });
  }

  return results;
}

export default parseMiClub;