// backend/scrapers/parseQuick18.js
import * as cheerio from "cheerio";

/*
 QUICK18 FORMAT (from your view-source):
 --------------------------------------------------------
 #searchMatrix
   .matrixRow
       .time        → tee time string "HH:MM"
       .price       → price per person
       .available   → number of available player spots (0–4)
*/

// ---- Time & party-size helpers ----

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
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
 *   time: "HH:MM",
 *   availableSpots: number,
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
  if (typeof slot.availableSpots === "number") {
    if (slot.availableSpots < partySize) return false;
  }

  return true;
}

export function parseQuick18(html, course, criteria = {}) {
  const $ = cheerio.load(html);
  const results = [];

  const boundsCache = buildCriteriaTimeBounds(criteria);
  const dateStr = criteria.date || "";
  const compactDate = dateStr ? dateStr.replace(/-/g, "") : "";

  $("#searchMatrix .matrixRow").each((i, row) => {
    const time = $(row).find(".time").text().trim();
    if (!time) return;

    const priceRaw = $(row).find(".price").text().trim();
    const price = priceRaw ? priceRaw.replace("$", "").trim() : null;

    const availRaw = $(row).find(".available").text().trim();
    const spots = parseInt(availRaw || "0", 10);

    const slot = {
      name: course.name,
      provider: "Quick18",
      time,
      date: dateStr,
      spots,
      price,
      holes: criteria.holes || null,
      bookUrl: course.quick18Url && compactDate
        ? `${course.quick18Url}?teedate=${compactDate}`
        : course.quick18Url || null,
      // used for generic filtering helper:
      availableSpots: spots
    };

    if (slotMatchesCriteria(slot, criteria, boundsCache)) {
      results.push(slot);
    }
  });

  return results;
}
