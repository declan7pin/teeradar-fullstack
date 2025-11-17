// backend/scrapers/parseQuick18.js
import * as cheerio from "cheerio";

/*
 QUICK18 FORMAT (confirmed from your view-source upload):
 --------------------------------------------------------
 #searchMatrix
   .matrixRow
       .time        → tee time string
       .price       → price per person
       .available   → number of available player spots (0–4)
*/

export function parseQuick18(html, course, criteria) {
  const $ = cheerio.load(html);
  const results = [];

  $("#searchMatrix .matrixRow").each((i, row) => {
    const time = $(row).find(".time").text().trim();
    if (!time) return;

    const priceRaw = $(row).find(".price").text().trim();
    const price = priceRaw ? priceRaw.replace("$", "").trim() : null;

    const availRaw = $(row).find(".available").text().trim();
    const spots = parseInt(availRaw || "0", 10);

    // Apply user filters
    if (criteria.earliest && time < criteria.earliest) return;
    if (criteria.latest && time > criteria.latest) return;
    if (criteria.partySize && spots < criteria.partySize) return;

    results.push({
      name: course.name,
      provider: "Quick18",
      time,
      date: criteria.date,
      spots,
      price,
      holes: criteria.holes || null,
      bookUrl: `${course.quick18Url}?teedate=${criteria.date.replace(/-/g, "")}`
    });
  });

  return results;
}
