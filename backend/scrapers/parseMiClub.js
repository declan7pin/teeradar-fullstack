// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Stable MiClub parser (previous fully working version)
 * Counts "Available" and "Taken" to determine booked vs total players.
 */
export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // MiClub lists rows where each tee time contains multiple “Available” or “Taken”
  $("tr").each((_, row) => {
    const text = $(row).text();

    // Detect times like 7:15 AM, 12:04 PM, etc.
    const timeMatch = text.match(/(\d{1,2}:\d{2})\s*(am|pm)/i);
    if (!timeMatch) return;

    let time = timeMatch[1];
    let ampm = timeMatch[2].toLowerCase();

    // Convert to 24h format
    let [h, m] = time.split(":");
    h = parseInt(h);
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const time24 = `${String(h).padStart(2, "0")}:${m}`;

    // Count availability
    const availableSpots = (text.match(/Available/gi) || []).length;
    const takenSpots = (text.match(/Taken/gi) || []).length;

    if (availableSpots + takenSpots === 0) return;

    const total = availableSpots + takenSpots;
    const playersBooked = takenSpots;

    results.push({
      time: time24,
      status: availableSpots > 0 ? "available" : "full",
      players: playersBooked,
      maxPlayers: total,
      available: availableSpots > 0,
      bookingLink: null
    });
  });

  return results;
}

export default parseMiClub;