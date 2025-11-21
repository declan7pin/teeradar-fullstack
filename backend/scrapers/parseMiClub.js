// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Parse MiClub public timesheet HTML and extract tee times with
 * accurate availability per tee-time (0–4 players).
 *
 * Returns objects like:
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

  /**
   * Helper: normalise any “7:15 am / 07:15 / 7:15pm” into "HH:MM"
   */
  function extractTime(rowText) {
    const m = rowText.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!m) return null;

    const rawTime = m[1];
    const ampm = (m[2] || "").toLowerCase();

    let [hStr, mStr] = rawTime.split(":");
    let h = parseInt(hStr, 10);

    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;

    if (Number.isNaN(h)) return null;

    return `${String(h).padStart(2, "0")}:${mStr}`;
  }

  /**
   * MAIN STRATEGY:
   * - Iterate every <tr>
   * - For each row, look for:
   *     * a time
   *     * AND either “Available/Taken” OR a Timesheet booking link
   * - Count Available/Taken **only inside that row**
   *   so legends or headers don't affect the result.
   */
  $("tr").each((_, el) => {
    const row = $(el);
    let rowText = row.text();
    if (!rowText) return;

    rowText = rowText.replace(/\s+/g, " ").trim();
    if (!rowText) return;

    // 1) Time in this row
    const time24 = extractTime(rowText);
    if (!time24) return;

    // 2) Availability words JUST for this row
    const availableMatches = rowText.match(/Available/gi) || [];
    const takenMatches = rowText.match(/Taken/gi) || [];

    // 3) Booking link (if present)
    const bookingLink =
      row.find('a[href*="TimesheetBooking"], a[href*="Timesheet"]').attr("href") ||
      null;

    // Filter out non-timeslot rows:
    // must have either availability markers OR a booking link.
    if (
      availableMatches.length === 0 &&
      takenMatches.length === 0 &&
      !bookingLink
    ) {
      return;
    }

    // If the row has “Available/Taken” cells, use that.
    // Otherwise assume standard 4-ball with all spots free.
    let totalSpots = availableMatches.length + takenMatches.length;
    if (totalSpots === 0) {
      totalSpots = 4; // safe default for weird layouts
    }

    const availableSpots = availableMatches.length || Math.max(totalSpots - takenMatches.length, 0);
    const players = Math.max(totalSpots - availableSpots, 0);

    const status = availableSpots > 0 ? "available" : "full";

    results.push({
      time: time24,
      status,
      players,
      maxPlayers: totalSpots,
      available: availableSpots > 0,
      bookingLink,
    });
  });

  return results;
}

export default parseMiClub;