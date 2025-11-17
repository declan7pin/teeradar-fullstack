// backend/scrapers/scrapeCourse.js
import fetch from "node-fetch";
import { parseMiClub } from "./parseMiClub.js";
import { parseQuick18 } from "./parseQuick18.js";

export async function scrapeCourse(course, criteria) {
  try {
    // ---------- MiClub (unchanged) ----------
    if (course.type === "miclub") {
      const url =
        `${course.base}?bookingResourceId=${course.resourceId}` +
        `&selectedDate=${criteria.date}&feeGroupId=${course.feeGroupId}&mobile=true`;

      const res = await fetch(url, { timeout: 20000 });
      const html = await res.text();
      return parseMiClub(html, course, criteria);
    }

    // ---------- Quick18 ----------
    if (course.type === "quick18") {
      const url = `${course.quick18Url}?teedate=${criteria.date.replace(/-/g, "")}`;

      const res = await fetch(url, { timeout: 20000 });
      const html = await res.text();
      return parseQuick18(html, course, criteria);
    }

    // ---------- Phone-only ----------
    if (course.type === "phone") {
      return [
        {
          name: course.name,
          provider: "Phone",
          time: null,
          spots: 0,
          price: null,
          phone: course.phone
        }
      ];
    }

    return [];
  } catch (err) {
    console.error("❌ Scrape error for", course.name, err);
    return [];
  }
}