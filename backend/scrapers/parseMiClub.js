// backend/scrapers/parseMiClub.js
import * as cheerio from 'cheerio';

/**
 * Generic MiClub parser.
 *
 * 1. First pass: use the standard MiClub table structure (works for most clubs).
 * 2. If we get no results, do a second pass that just finds rows with
 *    a TimesheetBooking link (handles quirky layouts like Meadow Springs).
 *
 * This is deliberately conservative so we don't break the courses
 * that are already working well for you.
 */
export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // ---------- PASS 1: standard MiClub layout ----------
  $('tr.TimeSlotRow').each((i, el) => {
    const row = $(el);

    const time =
      row.find('.TimeSlotTime').text().trim() ||
      row.find('td:first-child').text().trim();

    if (!time) return;

    const statusText =
      row.find('.TimeSlotStatus').text().trim() ||
      row.find('.statusText').text().trim();

    const playerCells = row.find('.playerSlot, .TimeSlotPlayer');
    const maxPlayers = playerCells.length || 4;

    // Count booked vs free cells if MiClub marks them up
    let booked = 0;
    playerCells.each((_, cell) => {
      const c = $(cell);
      const bookedIcon =
        c.find('img[alt*="Booked"], img[alt*="Full"]').length > 0;
      const bookedClass = /booked|full/i.test(c.attr('class') || '');
      if (bookedIcon || bookedClass) booked += 1;
    });

    const freeSpots = Math.max(maxPlayers - booked, 0);

    const bookingLink = row.find('a[href*="TimesheetBooking"]').attr('href');

    const available =
      /available|open/i.test(statusText) ||
      (!!bookingLink && freeSpots > 0);

    results.push({
      time,
      status: statusText || (available ? 'Available' : 'Unavailable'),
      players: maxPlayers - freeSpots, // players already booked
      maxPlayers,
      freeSpots,
      available,
      bookingLink: bookingLink ? bookingLink.trim() : null,
    });
  });

  // If that worked, we're done – this keeps all the
  // currently-good courses behaving exactly the same.
  if (results.length > 0) {
    return results;
  }

  // ---------- PASS 2: fallback for quirky layouts (e.g. Meadow Springs) ----------
  // Look for *any* row that contains a booking link.
  const fallback = [];
  $('a[href*="TimesheetBooking"]').each((i, linkEl) => {
    const link = $(linkEl);
    const row = link.closest('tr');
    if (!row.length) return;

    const time =
      row.find('.TimeSlotTime, .time, .slotTime')
        .first()
        .text()
        .trim() ||
      row.find('td:first-child').text().trim();

    if (!time) return;

    // Try to infer number of player cells; fall back to 4
    const playerCells = row.find('.playerSlot, .TimeSlotPlayer, .slotPlayer');
    const maxPlayers = playerCells.length || 4;

    let booked = 0;
    playerCells.each((_, cell) => {
      const c = $(cell);
      const bookedIcon =
        c.find('img[alt*="Booked"], img[alt*="Full"]').length > 0;
      const bookedClass = /booked|full/i.test(c.attr('class') || '');
      if (bookedIcon || bookedClass) booked += 1;
    });

    const freeSpots = Math.max(maxPlayers - booked, 0);

    fallback.push({
      time,
      status: freeSpots > 0 ? 'Available' : 'Unavailable',
      players: maxPlayers - freeSpots,
      maxPlayers,
      freeSpots,
      available: freeSpots > 0,
      bookingLink: link.attr('href')?.trim() || null,
    });
  });

  return fallback;
}

export default parseMiClub;