// backend/scrapers/parseQuick18.js
import * as cheerio from "cheerio";

/*
  QUICK18 FORMAT (Hamersley / Armadale / Lake Claremont etc):

  Each tee time is rendered as a row in the "search matrix" table.
  The combined row text typically looks something like:

    "5:30 AM  Back 9 Morning  1 to 4 players  $27.00  Select"

  or

    "7:10 AM  Front 9  1 or 2 players  $19.00  Select"

  We DON'T rely on specific classes (because they differ between courses),
  we just read the text in each row and pattern-match:

    - Time:     (\d{1,2}:\d{2}) (AM|PM)?
    - Players:  "1 to 4 players", "1 or 2 players", "1 player", etc.
    - Price:    first "$xx.xx" in the row
*/

/**
 * Parse a Quick18 searchmatrix page and extract tee times with
 * a maximum number of players, so we can respect partySize.
 *
 * Returns objects like:
 *   {
 *     time: "HH:MM",        // 24h
 *     spots: number,        // max players this slot can take
 *     price: string|null    // "$27.00"
 *   }
 */
export function parseQuick18(html) {
  const results = [];
  const $ = cheerio.load(html);

  // Helper: "7:15" + "AM"/"PM" → "07:15"
  function toTime24(timeStr, ampm) {
    let [hStr, mStr] = timeStr.split(":");
    let h = parseInt(hStr, 10);
    const m = mStr;

    if (ampm) {
      const upper = ampm.toUpperCase();
      if (upper === "PM" && h !== 12) h += 12;
      if (upper === "AM" && h === 12) h = 0;
    }

    return `${String(h).padStart(2, "0")}:${m}`;
  }

  // Table / matrix that contains the tee times
  const rows = $("#searchMatrix tr, table#searchMatrix tr, .matrixRow");

  rows.each((_, row) => {
    const text = $(row).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    // 1. Time
    const timeMatch = text.match(/(\d{1,2}:\d{2})\s*(AM|PM)?/i);
    if (!timeMatch) return;

    const rawTime = timeMatch[1];
    const ampm = timeMatch[2] || "";
    const time24 = toTime24(rawTime, ampm);

    // 2. Players capacity
    // Examples:
    //   "1 to 4 players"
    //   "1 or 2 players"
    //   "1 player"
    let minPlayers = 1;
    let maxPlayers = 4;

    const rangeMatch = text.match(/(\d+)\s*(?:to|or)\s*(\d+)\s*players?/i);
    if (rangeMatch) {
      minPlayers = parseInt(rangeMatch[1], 10);
      maxPlayers = parseInt(rangeMatch[2], 10);
    } else {
      const singleMatch = text.match(/(\d+)\s*player[s]?/i);
      if (singleMatch) {
        minPlayers = maxPlayers = parseInt(singleMatch[1], 10);
      } else {
        // No players text → we don't know capacity, skip this row
        return;
      }
    }

    // 3. Price (first $xx.xx in the row)
    const priceMatch = text.match(/\$[0-9]+(?:\.[0-9]{2})?/);
    const price = priceMatch ? priceMatch[0] : null;

    results.push({
      time: time24,
      spots: maxPlayers,
      price,
    });
  });

  return results;
}

export default parseQuick18;