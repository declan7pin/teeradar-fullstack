// backend/scrapers/parseMiClub.js

import * as cheerio from 'cheerio';

/**
 * Parses MiClub public timesheet HTML and extracts tee times.
 * Works for all MiClub courses (Araluen, Collier, Whaleback, etc).
 *
 * @param {string} html - Raw HTML from the MiClub timesheet URL
 * @returns {Array} - List of tee times with status, players, etc.
 */
export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // MiClub uses table rows for each time slot
  $('tr.TimeSlotRow').each((i, el) => {
    const row = $(el);

    const time =
      row.find('.TimeSlotTime').text().trim() ||
      row.find('td:first-child').text().trim();

    const status =
      row.find('.TimeSlotStatus').text().trim() ||
      row.find('.statusText').text().trim();

    const players = row.find('.playerSlot').length;
    const maxPlayers = row.find('.playerSlot').attr('data-max') || 4;

    const bookingLink = row.find('a[href*="TimesheetBooking"]').attr('href');

    results.push({
      time,
      status,
      players,
      maxPlayers,
      available: status.toLowerCase().includes('available'),
      bookingLink: bookingLink ? bookingLink.trim() : null,
    });
  });

  return results;
}

export default parseMiClub;
