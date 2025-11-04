// backend/scrapers/scrapeCourse.js
import * as cheerio from "cheerio";

// helper to build a standard response
function baseReturn(course, date, available, bookingUrl, extra = {}) {
  return [
    {
      course: course.name,
      provider: course.provider,
      available,
      bookingUrl,
      lat: course.lat,
      lng: course.lng,
      city: course.city,
      state: course.state,
      ...extra
    }
  ];
}

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// NEW: try to read "4 spots", "2 left", "3 available" from a row
function detectSpotsFromText(text) {
  // grab the first number that looks like a spots count
  const m = text.match(/(\d+)\s*(spots|left|available|avail|players)?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

// choose best URL for course based on holes + weekday/weekend
function pickCourseUrl(course, { date, holes }) {
  const day = date ? new Date(date + "T00:00:00") : null;
  const isWeekend = day ? (day.getDay() === 0 || day.getDay() === 6) : false;

  // Meadow Springs has weekday/weekend + 9/18
  if (course.name.startsWith("Meadow Springs")) {
    if (holes === "9") {
      if (isWeekend && course.bookingBase9_weekend) return course.bookingBase9_weekend;
      if (!isWeekend && course.bookingBase9_weekday) return course.bookingBase9_weekday;
    } else if (holes === "18") {
      if (isWeekend && course.bookingBase18_weekend) return course.bookingBase18_weekend;
      if (!isWeekend && course.bookingBase18_weekday) return course.bookingBase18_weekday;
    }
  }

  // general 9/18
  if (holes === "9" && course.bookingBase9) return course.bookingBase9;
  if (holes === "18" && course.bookingBase18) return course.bookingBase18;

  // fallback
  return (
    course.bookingBase ||
    course.bookingBase18 ||
    course.bookingBase9 ||
    null
  );
}

export async function scrapeCourse(course, criteria) {
  const {
    date,
    earliest = "06:00",
    latest = "17:00",
    partySize = 1,
    holes = ""
  } = criteria;

  // pick right URL from course.json
  let url = pickCourseUrl(course, { date, holes });

  // PHONE: show but never "available"
  if (course.provider === "Phone") {
    return baseReturn(course, date, false, null, { note: "phone only" });
  }

  // LINK-ONLY: show but user must click through
  if (course.provider === "GolfBooking") {
    return baseReturn(course, date, false, url, { note: "link-only provider" });
  }

  // QUICK18
  if (course.provider === "Quick18") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });
    url = url.replace("YYYYMMDD", date.replace(/-/g, ""));
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TeeRadar/1.0" } });
      if (r.ok) {
        return baseReturn(course, date, false, url, {
          reachable: true,
          confidence: "unknown"
        });
      }
      return baseReturn(course, date, false, url, { reachable: false });
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // MiClub (all those ViewPublicTimesheet.msp URLs)
  if (course.provider === "MiClub") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });

    // replace date
    url = url.replace("YYYY-MM-DD", date);

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "TeeRadar/1.0",
          "Accept": "text/html"
        }
      });
      if (!resp.ok) {
        return baseReturn(course, date, false, url, {
          reason: "fetch not ok",
          status: resp.status
        });
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      const startMin = toMinutes(earliest);
      const endMin = toMinutes(latest);

      const strictMatches = [];

      // go through rows that look like timesheet rows
      $("tr, .timesheet-row, .booking-row").each((i, el) => {
        const $row = $(el);
        const rowText = $row.text().trim();
        if (!rowText) return;

        // 1) find a time
        const m = rowText.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let time = m[1];
        if (time.length === 4) time = "0" + time; // 7:05 -> 07:05
        const timeMin = toMinutes(time);

        // 2) within window?
        if (startMin && timeMin < startMin) return;
        if (endMin && timeMin > endMin) return;

        // 3) is this actually bookable-looking?
        const lower = rowText.toLowerCase();
        const hasAction =
          lower.includes("book") ||
          lower.includes("available") ||
          $row.find("a,button").length > 0;
        if (!hasAction) return;

        // 4) detect spots in this row
        const spots = detectSpotsFromText(rowText);

        // 5) if user wants, say, 4 players, and we can SEE the row only has 2 → skip it
        if (partySize && spots !== null && spots < partySize) {
          return;
        }

        // 6) holes — only enforce if the course itself has a fixed holes field
        if (holes && course.holes && String(course.holes) !== String(holes)) {
          return;
        }

        // looks good → record it
        strictMatches.push({
          time,
          spots, // might be null
          snippet: rowText.slice(0, 140) + "..."
        });
      });

      // if we found at least one proper row, mark available
      if (strictMatches.length > 0) {
        return [
          {
            course: course.name,
            provider: course.provider,
            available: true,
            bookingUrl: url,
            times: strictMatches.map(m => m.time),
            slots: strictMatches,          // <-- frontend can show spots from here
            lat: course.lat,
            lng: course.lng,
            city: course.city,
            state: course.state,
            confidence: "high"
          }
        ];
      }

      // page loaded but we didn't find a row that matched time/players
      return baseReturn(course, date, false, url, {
        confidence: "unknown",
        reason: "no rows matched time/players"
      });
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // fallback
  return baseReturn(course, date, false, url, { reason: "unknown provider" });
}




