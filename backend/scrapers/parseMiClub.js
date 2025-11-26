// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * MiClub parser (updated to work for Fremantle + others)
 *
 * Strategy:
 *  - Work at the row (<tr>) level instead of full-page text.
 *  - For each row:
 *      * Find the time (e.g. "7:05 am").
 *      * Count "Available" vs "Taken" OR parse "1/4" / "2 of 4".
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

/**
 * Parse a single row of text into a slot object or null.
 */
function parseRowText(segmentRaw) {
  const segment = segmentRaw.trim();
  if (!segment) return null;

  // 1) Find a time like "7:05 am" or "14:10"
  const timeMatch = segment.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
  if (!timeMatch) return null;

  const rawTime = timeMatch[1];
  const ampm = timeMatch[2] || "";
  const time24 = to24h(rawTime, ampm);

  // 2) Count how many slots are Available vs Taken in THIS row
  const availableMatches = segment.match(/\bAvailable\b/gi) || [];
  const takenMatches = segment.match(/\bTaken\b/gi) || [];

  let availableSpots = availableMatches.length;
  let takenSpots = takenMatches.length;
  let totalSpots = availableSpots + takenSpots;

  // 3) Fallback: patterns like "1/4" or "2 of 4" (Fremantle uses "1/4")
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

  // 4) Final fallback:
  // If we *still* don't know, but it's clearly a bookable row,
  // assume a standard 4-ball and be conservative (full unless we see "Available").
  if (totalSpots === 0) {
    const hasBookWord = /Book/i.test(segment);
    const hasAvailWord = /Available/i.test(segment);
    if (!hasBookWord && !hasAvailWord) {
      // not obviously bookable → skip
      return null;
    }
    totalSpots = 4;
    // if no "Available" seen, assume fully taken
    takenSpots = hasAvailWord ? 0 : 4;
    availableSpots = Math.max(totalSpots - takenSpots, 0);
  }

  const players = takenSpots;
  const maxPlayers = totalSpots;
  const status = availableSpots > 0 ? "available" : "full";

  return {
    time: time24,
    status,
    players,
    maxPlayers,
    available: availableSpots > 0,
    bookingLink: null, // we use course.url / feeGroup config to build links
  };
}

export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // ---- PRIMARY STRATEGY: parse per <tr> row ----
  $("tr").each((_, tr) => {
    const rowText = $(tr).text().replace(/\s+/g, " ").trim();
    if (!rowText) return;

    // Only consider rows that look tee-time-ish
    const looksLikeTimeRow =
      /\d{1,2}:\d{2}/.test(rowText) &&
      ( /Book/i.test(rowText) ||
        /Available/i.test(rowText) ||
        /\d+\s*\/\s*\d+/.test(rowText) ||
        /\d+\s*of\s*\d+/i.test(rowText)
      );

    if (!looksLikeTimeRow) return;

    const slot = parseRowText(rowText);
    if (slot) {
      results.push(slot);
    }
  });

  // ---- BACKUP STRATEGY: old "Click to select row" text-splitting ----
  if (results.length === 0) {
    const fullText = $.root().text();
    const segments = fullText.split(/Click to select row\./i);

    segments.forEach((segmentRaw) => {
      const slot = parseRowText(segmentRaw);
      if (slot) {
        results.push(slot);
      }
    });
  }

  return results;
}

export default parseMiClub;