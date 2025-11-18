// backend/scrapers/parseMiClub.js

import * as cheerio from 'cheerio';

// ---- Time & party-size helpers ----

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function buildCriteriaTimeBounds(criteria = {}) {
  const earliestMinutes = criteria.earliest
    ? timeToMinutes(criteria.earliest)
    : null;
  const latestMinutes = criteria.latest
    ? timeToMinutes(criteria.latest)
    : null;
  const partySize = Number(criteria.partySize) || 1;
  return { earliestMinutes, latestMinutes, partySize };
}

/**
 * Decide if a parsed tee time matches the user's search criteria.
 *
 * slot: {
 *   time: "HH:mm",
 *   availableSpots: number | undefined,
 *   available: boolean
 * }
 */
function slotMatchesCriteria(slot, criteria = {}, boundsCache) {
  const { earliestMinutes, latestMinutes, partySize } =
    boundsCache || buildCriteriaTimeBounds(criteria);

  // 1) Time window
  const t = timeToMinutes(slot.time);
  if (t != null) {
    if (earliestMinutes != null && t < earliestMinutes) return false;
    if (latestMinutes != null && t > latestMinutes) return false;
  }

  // 2) Party size capacity
  let capacityOK = true;
  if (typeof slot.availableSpots === 'number') {
    capacityOK = slot.availableSpots >= partySize;
  } else if (typeof slot.available === 'boolean') {
    // Fallback: if we don't know exact capacity, at least require "available"
    capacityOK = slot.available;
  }

  if (!capacityOK) return false;

  return true;
}

/**
 * Parses MiClub public timesheet HTML and extracts tee times.
 * Works for all MiClub courses (Araluen, Collier, Whaleback, etc).
 *
 * @param {string} html - Raw HTML from the MiClub timesheet URL
 * @param {object} [criteria] - Optional search criteria:
 *   { earliest, latest, partySize }
 *   If omitted, all "available" slots are returned.
 * @returns {Array} - List of tee times with status, players, etc.
 */
export function parseMiClub(html, criteria = {}) {
  const $ = cheerio.load(html);
  const results = [];

  const boundsCache = buildCriteriaTimeBounds(criteria);

  // MiClub uses table rows for each time slot
  $('tr.TimeSlotRow').each((i, el) => {
    const row = $(el);

    const time =
      row.find('.TimeSlotTime').text().trim() ||
      row.find('td:first-child').text().trim();

    const status =
      row.find('.TimeSlotStatus').text().trim() ||
      row.find('.statusText').text().trim();

    // Total player slots in the row
    const playerSlots = row.find('.playerSlot');
    const players = playerSlots.length;
    const maxPlayersRaw = playerSlots.attr('data-max');
    const maxPlayers = Number(maxPlayersRaw) || players || 4;

    const bookingLink = row.find('a[href*="TimesheetBooking"]').attr('href');

    // Try to detect how many spots are actually available.
    // 1) Look for explicit "available" player slots via class.
    const availableSlotEls = row.find(
      '.playerSlot.available, .playerSlot.Available, .playerSlot.slotAvailable'
    );
    let availableSpots = availableSlotEls.length;

    // 2) If that doesn't exist, try to parse a number from the status text, e.g. "2 Available"
    if (!availableSpots && status) {
      const numMatch = status.match(/(\d+)/);
      if (numMatch) {
        availableSpots = parseInt(numMatch[1], 10);
      }
    }

    // 3) Fallbacks
    if (!availableSpots && status.toLowerCase().includes('available')) {
      // We know it's marked available but no explicit count → assume full row
      availableSpots = maxPlayers;
    }
    if (!availableSpots && status.toLowerCase().includes('full')) {
      availableSpots = 0;
    }

    const available = (availableSpots || 0) > 0;

    const slot = {
      time,
      status,
      // original fields
      players,
      maxPlayers,
      available,
      bookingLink: bookingLink ? bookingLink.trim() : null,
      // new, used for accurate filtering:
      availableSpots
    };

    // If criteria were provided, enforce time window + party size.
    // If criteria is empty, this just behaves like "all available slots".
    if (slotMatchesCriteria(slot, criteria, boundsCache)) {
      results.push(slot);
    }
  });

  return results;
}

export default parseMiClub;