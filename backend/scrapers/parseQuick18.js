// backend/scrapers/parseQuick18.js
import * as cheerio from "cheerio";

/*
  QUICK18 FORMAT (from your Hamersley HTML):

  Tee Time  Course              Players
  ----------------------------------------------
  5:30 AM   Back 9 Morning      1 or 2 players   $27.00  Select  ...

  The important bits for us:
    - Time: "5:30" + "AM"/"PM"
    - Capacity: text like
         "1 or 2 players"
         "1 to 4 players"
         "1 player"
    - We build the booking URL by forcing ?teedate=YYYYMMDD
      on top of the base course URL.
*/

/**
 * Parse a Quick18 searchmatrix page and extract tee times with
 * a maximum number of players, so we can respect partySize.
 *
 * Returns objects like:
 *   {
 *     name,
 *     provider: "Quick18",
 *     time: "HH:MM",       // 24h
 *     date: "YYYY-MM-DD",
 *     spots: number,       // max players this slot can take
 *     price: string|null,  // e.g. "$27.00"
 *     holes: number|null,
 *     bookUrl: string
 *   }
 */
export function parseQuick18(html, course, criteria = {}) {
  const results = [];
  const date = criteria.date || null;
  const earliest = criteria.earliest || "06:00";
  const latest = criteria.latest || "17:00";
  const partySize = Number(criteria.partySize || 1);

  // Helper: "7:15" + "AM"/"PM" → "07:15"
  function toTime24(timeStr, ampm) {
    let [hStr, mStr] = timeStr.split(":");
    let h = parseInt(hStr, 10);

    if (ampm) {
      const upper = ampm.toUpperCase();
      if (upper === "PM" && h !== 12) h += 12;
      if (upper === "AM" && h === 12) h = 0;
    }

    return `${String(h).padStart(2, "0")}:${mStr}`;
  }

  const toMinutes = (t) => {
    const [h, m] = t.split(":").map((n) => parseInt(n, 10));
    return h * 60 + m;
  };

  const earliestMin = toMinutes(earliest);
  const latestMin = toMinutes(latest);

  // Use the raw HTML string – Quick18 is very text-driven and
  // this pattern matches:
  //   "6:15 AM ... 1 to 4 players"
  const re =
    /(\d{1,2}:\d{2})\s*(AM|PM)[\s\S]{0,200}?(\d+\s*(?:to|or)\s*\d+\s*players?|\d+\s*player[s]?)/gi;

  let match;
  while ((match = re.exec(html)) !== null) {
    const timeRaw = match[1];     // "6:15"
    const ampm = match[2];        // "AM" / "PM"
    const playersText = match[3]; // "1 to 4 players", etc.

    const time24 = toTime24(timeRaw, ampm);
    const mins = toMinutes(time24);

    // Time window filter
    if (mins < earliestMin || mins > latestMin) continue;

    // Parse "1 to 4 players" → min=1, max=4
    let minPlayers = 1;
    let maxPlayers = 4;

    const rangeMatch = playersText.match(/(\d+)\s*(?:to|or)\s*(\d+)/i);
    if (rangeMatch) {
      minPlayers = parseInt(rangeMatch[1], 10);
      maxPlayers = parseInt(rangeMatch[2], 10);
    } else {
      const singleMatch = playersText.match(/(\d+)\s*player/i);
      if (singleMatch) {
        minPlayers = maxPlayers = parseInt(singleMatch[1], 10);
      }
    }

    // Respect partySize – only keep slots that can actually fit this group
    if (partySize > maxPlayers) continue;

    // Try to grab the first price right after this block
    const slice = html.slice(match.index, match.index + 250);
    const priceMatch = slice.match(/\$[0-9]+(?:\.[0-9]{2})?/);
    const price = priceMatch ? priceMatch[0] : null;

    // Build a clean booking URL with the selected date
    const baseQuickUrl = course.quick18Url || course.url || "";
    const cleanedBase = baseQuickUrl.split("?")[0];

    const bookUrl =
      date && cleanedBase
        ? `${cleanedBase}?teedate=${date.replace(/-/g, "")}`
        : baseQuickUrl;

    results.push({
      name: course.name,
      provider: "Quick18",
      time: time24,
      date,
      spots: maxPlayers,
      price,
      holes: course.holes || null,
      bookUrl,
    });
  }

  return results;
}

export default parseQuick18;