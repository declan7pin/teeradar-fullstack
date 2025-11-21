// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Parse MiClub public timesheet HTML and extract tee times with
 * accurate per-time availability (0–4 players).
 *
 * Returned shape:
 *   {
 *     time: "HH:MM",          // 24h time string
 *     status: "available" | "full",
 *     players: number,        // booked players
 *     maxPlayers: number,     // total slots (usually 4)
 *     available: boolean,     // at least 1 free slot
 *     bookingLink: string|null
 *   }
 */

// Convert "7:05" + "am"/"pm" to "07:05"
function to24h(rawTime, ampmText) {
  let [hStr, mStr] = rawTime.split(":");
  let h = parseInt(hStr, 10);
  const ampm = (ampmText || "").toUpperCase();

  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;

  return `${String(h).padStart(2, "0")}:${mStr}`;
}

export function parseMiClub(html) {
  const $ = cheerio.load(html);

  // Get all visible text once
  const fullText = $.root().text().replace(/\r/g, "");

  const results = [];

  // MiClub repeats this string for every tee row
  const segments = fullText.split(/Click to select row\./i);

  for (const seg of segments) {
    const text = seg.replace(/\s+/g, " ").trim();
    if (!text) continue;

    // Find the tee time inside this segment, e.g. "07:05 am"
    // Prefer a heading-like pattern first, then fall back to any time
    const timeMatch =
      text.match(/###\s*(\d{1,2}:\d{2})\s*(am|pm)/i) ||
      text.match(/(\d{1,2}:\d{2})\s*(am|pm)/i);

    if (!timeMatch) continue;

    const rawTime = timeMatch[1];
    const ampm = timeMatch[2] || "";
    const time24 = to24h(rawTime, ampm);

    // Count availability words for *this* row only
    const availableMatches = text.match(/\bAvailable\b/gi) || [];
    const takenMatches =
      text.match(/\b(Taken|Booked|Full|Sold Out)\b/gi) || [];

    let availableSpots = availableMatches.length;
    let takenSpots = takenMatches.length;
    let totalSpots = availableSpots + takenSpots;

    // If we see nothing, skip this row – we don't want to lie
    if (totalSpots === 0) {
      // In almost all MiClub WA public sheets, each tee row has
      // explicit "Taken"/"Available". If not, we ignore it.
      continue;
    }

    const players = takenSpots;      // people already booked
    const maxPlayers = totalSpots;   // usually 4
    const status = availableSpots > 0 ? "available" : "full";

    results.push({
      time: time24,
      status,
      players,
      maxPlayers,
      available: availableSpots > 0,
      bookingLink: null, // we use your existing URL builder instead
    });
  }

  return results;
}

export default parseMiClub;