import * as cheerio from "cheerio";

export function parseMiClub(html) {
  const $ = cheerio.load(html);
  const results = [];

  // Select every timesheet "row"
  $("tr.TimeSlotRow, tr.timeslotrow, tr").each((_, row) => {
    const $row = $(row);
    const rowText = $row.text().trim();

    // Extract time (am/pm or 24h)
    const timeMatch = rowText.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
    if (!timeMatch) return;

    let [rawTime, ampm] = [timeMatch[1], (timeMatch[2] || "").toLowerCase()];

    let [h, m] = rawTime.split(":").map(Number);
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;

    const time24 = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    // Find all slot cells (usually 4)
    const slotCells = $row.find("td.timesheetSlotCol, td.TimeSlotCol, td.slot");
    if (!slotCells.length) return;

    let taken = 0;
    let available = 0;

    slotCells.each((_, cell) => {
      const text = $(cell).text().trim().toLowerCase();
      if (text.includes("taken")) taken++;
      else if (text.includes("available")) available++;
    });

    const maxPlayers = slotCells.length;
    const players = taken;
    const hasAvailability = available > 0;

    results.push({
      time: time24,
      status: hasAvailability ? "available" : "full",
      players,
      maxPlayers,
      available: hasAvailability,
      bookingLink: null
    });
  });

  return results;
}

export default parseMiClub;