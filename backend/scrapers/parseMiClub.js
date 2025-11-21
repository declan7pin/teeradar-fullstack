// backend/scrapers/parseMiClub.js
import * as cheerio from "cheerio";

/**
 * Parse MiClub public timesheet HTML and extract tee times with
 * accurate availability per tee-time (0–4 players).
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

  // =====================================================
  // 1) PREFERRED: parse MiClub tee rows from the table
  // =====================================================
  const teeRows = $("tr.TimeSlotRow, tr.timeSlotRow, tr.timeslotrow, tr.tsRow");

  teeRows.each((_, el) => {
    const row = $(el);

    // ---- TIME ----
    let rawTime =
      row.find(".TimeSlotTime").text().trim() ||
      row.find("td").first().text().trim();

    if (!rawTime) return;

    const timeMatch = rawTime.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return;

    const baseTime = timeMatch[1];
    const ampm = (timeMatch[2] || "").toUpperCase();

    let [hStr, mStr] = baseTime.split(":");
    let h = parseInt(hStr, 10);

    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;

    const time24 = `${String(h).padStart(2, "0")}:${mStr}`;

    // ---- PLAYER CELLS ----
    // Only look at cells that actually represent player spots
    const playerCells = row.find("td").filter((_, cell) => {
      const t = $(cell).text().trim();
      return /Available|Taken|Booked|Phone/i.test(t);
    });

    let availableSpots = 0;
    let takenSpots = 0;

    playerCells.each((_, cell) => {
      const t = $(cell).text().trim();
      if (/Available/i.test(t)) {
        availableSpots++;
      } else if (/Taken|Booked/i.test(t)) {
        takenSpots++;
      } else if (/Phone/i.test(t)) {
        // Treat phone booking as not online-available
        takenSpots++;
      }
    });

    const totalSpots = availableSpots + takenSpots;
    if (totalSpots === 0) return;

    const players = totalSpots - availableSpots;
    const status = availableSpots > 0 ? "available" : "full";

    const bookingLink =
      row.find('a[href*="TimesheetBooking"]').attr("href") || null;

    results.push({
      time: time24,
      status,
      players,
      maxPlayers: totalSpots,
      available: availableSpots > 0,
      bookingLink,
    });
  });

  // If table parsing worked, we're done.
  if (results.length > 0) {
    return results;
  }

  // =====================================================
  // 2) FALLBACK: text-based parsing (generic MiClub pages)
  //    (kept for courses with unusual markup)
  // =====================================================

  const fullText = $.root().text();
  const segments = fullText.split(/Click to select row\./i);

  segments.forEach((segment) => {
    const timeMatch = segment.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return;

    const rawTime = timeMatch[1];
    const ampm = (timeMatch[2] || "").toUpperCase();

    let [hStr, mStr] = rawTime.split(":");
    let h = parseInt(hStr, 10);

    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;

    const time24 = `${String(h).padStart(2, "0")}:${mStr}`;

    // Count player slots in THIS segment
    const availableMatches = segment.match(/Available/gi) || [];
    const takenMatches = segment.match(/Taken|Booked/gi) || [];
    const phoneMatches = segment.match(/Phone/gi) || [];

    const availableSpots = availableMatches.length;
    const takenSpots = takenMatches.length + phoneMatches.length;
    const totalSpots = availableSpots + takenSpots;

    if (totalSpots === 0) {
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
      bookingLink: null,
    });
  });

  // =====================================================
  // 3) LAST-RESORT FALLBACK: very generic table parser
  // =====================================================
  if (results.length === 0) {
    $("tr").each((_, el) => {
      const row = $(el);
      const rowText = row.text().replace(/\s+/g, " ").trim();
      if (!rowText) return;

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

      // Patterns like "1/4", "2 of 4", etc.
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
        bookingLink:
          row.find('a[href*="TimesheetBooking"]').attr("href") || null,
      });
    });
  }

  return results;
}

export default parseMiClub;