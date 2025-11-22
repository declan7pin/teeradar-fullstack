// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * MiClub parser tuned for Whaleback etc.
 *
 * Strategy:
 *  - Take the full text of the page.
 *  - Split on "Click to select row." → each chunk ≈ one tee row.
 *  - For each chunk:
 *      * Find the time (e.g. "7:05 am").
 *      * Count "Available" vs "Taken".
 *      * Infer players booked & free spots.
 *
 * Returns objects like:
 *   {
 *     time: "HH:MM",          // 24h time
 *     status: "available" | "full",
 *     players: number,        // booked players
 *     maxPlayers: number,     // total slots (usually 4)
 *     available: boolean,     // at least 1 free slot
 *     bookingLink: null       // we build URLs elsewhere
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

  // Take the *plain text* of the whole document
  const fullText = $.root().text();

  // MiClub has "Click to select row." once per tee row
  const segments = fullText.split(/Click to select row\./i);

  segments.forEach((segmentRaw) => {
    const segment = segmentRaw.trim();
    if (!segment) return;

    // Find a time like "7:05 am" or "14:10"
    const timeMatch = segment.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return;

    const rawTime = timeMatch[1];
    const ampm = timeMatch[2] || "";
    const time24 = to24h(rawTime, ampm);

    // Count how many slots are Available vs Taken in THIS row
    const availableMatches = segment.match(/\bAvailable\b/gi) || [];
    const takenMatches = segment.match(/\bTaken\b/gi) || [];

    let availableSpots = availableMatches.length;
    let takenSpots = takenMatches.length;
    let totalSpots = availableSpots + takenSpots;

    // Fallback: if we don't see explicit "Available"/"Taken",
    // try patterns like "1/4" or "2 of 4".
    if (totalSpots === 0) {
      const fractionMatch = segment.match(/(\d+)\s*\/\s*(\d+)/);
      const ofMatch = segment.match(/(\d+)\s*of\s*(\d+)/i);

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

    // Final fallback: if we *still* don't know, but it's clearly a bookable row,
    // assume a standard 4-ball and be conservative (full unless we see "Available").
    if (totalSpots === 0) {
      const hasBookWord = /Book/i.test(segment);
      if (!hasBookWord) {
        // not obviously bookable → skip
        return;
      }
      totalSpots = 4;
      // if no "Available" seen, assume fully taken
      takenSpots = 4;
      availableSpots = 0;
    }

    const players = takenSpots;
    const maxPlayers = totalSpots;
    const status = availableSpots > 0 ? "available" : "full";

    results.push({
      time: time24,
      status,
      players,
      maxPlayers,
      available: availableSpots > 0,
      bookingLink: null, // we use course.url / feeGroup config to build links
    });
  });

  return results;
}

export default parseMiClub;