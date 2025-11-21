// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Parse MiClub public timesheet HTML and extract tee times with
 * accurate per-time availability (0–4 players).
 *
 * Returned shape (unchanged from before):
 *   {
 *     time: "HH:MM",          // 24h time string
 *     status: "available" | "full",
 *     players: number,        // booked players
 *     maxPlayers: number,     // total slots (usually 4)
 *     available: boolean,     // at least 1 free slot
 *     bookingLink: string|null
 *   }
 */

function to24h(rawTime, ampmText) {
  // rawTime like "9:45" or "09:45"
  let [hStr, mStr] = rawTime.split(":");
  let h = parseInt(hStr, 10);
  const ampm = (ampmText || "").toUpperCase();

  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;

  return `${String(h).padStart(2, "0")}:${mStr}`;
}

export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // --- MAIN STRATEGY: work row-by-row ---
  $("tr").each((_, el) => {
    const row = $(el);
    const rowText = row.text().replace(/\s+/g, " ").trim();
    if (!rowText) return;

    // Find any time in this row (e.g. "9:53 am" or "10:01")
    const timeMatch = rowText.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return; // not a tee row

    const rawTime = timeMatch[1];
    const ampm = timeMatch[2] || "";
    const time24 = to24h(rawTime, ampm);

    // Now **only** look at this row to count "Available"/"Taken"
    const availableMatches = rowText.match(/\bAvailable\b/gi) || [];
    const takenMatches =
      rowText.match(/\b(Taken|Booked|Full|Sold Out)\b/gi) || [];

    let availableSpots = availableMatches.length;
    let takenSpots = takenMatches.length;
    let totalSpots = availableSpots + takenSpots;

    // Some layouts don’t repeat the words; try to infer from “x/4” etc.
    if (totalSpots === 0) {
      // Patterns like "1/4", "2 of 4" in the row
      const fractionMatch = rowText.match(/(\d+)\s*\/\s*(\d+)/);
      const ofMatch = rowText.match(/(\d+)\s*of\s*(\d+)/i);

      if (fractionMatch) {
        const booked = parseInt(fractionMatch[1], 10);
        const total = parseInt(fractionMatch[2], 10);
        if (!Number.isNaN(booked) && !Number.isNaN(total) && total > 0) {
          totalSpots = total;
          takenSpots = booked;
          availableSpots = Math.max(total - booked, 0);
        }
      } else if (ofMatch) {
        const booked = parseInt(ofMatch[1], 10);
        const total = parseInt(ofMatch[2], 10);
        if (!Number.isNaN(booked) && !Number.isNaN(total) && total > 0) {
          totalSpots = total;
          takenSpots = booked;
          availableSpots = Math.max(total - booked, 0);
        }
      }
    }

    // If we *still* don't know, assume a 4-ball row but don’t lie about availability.
    if (totalSpots === 0) {
      // If row contains “Book” / booking link we at least treat it as a standard tee
      const hasBookWord = /Book/i.test(rowText);
      const hasTimesheetLink =
        row.find('a[href*="TimesheetBooking"]').length > 0;

      if (!hasBookWord && !hasTimesheetLink) return;

      totalSpots = 4;
      // If we can’t see any “Available”, be conservative and say it’s full.
      takenSpots = 4;
      availableSpots = 0;
    }

    const players = takenSpots;
    const maxPlayers = totalSpots;
    const status = availableSpots > 0 ? "available" : "full";

    const bookingLink =
      row.find('a[href*="TimesheetBooking"]').attr("href") || null;

    results.push({
      time: time24,
      status,
      players,
      maxPlayers,
      available: availableSpots > 0,
      bookingLink,
    });
  });

  return results;
}

export default parseMiClub;