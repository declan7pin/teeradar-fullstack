// backend/scrapers/scrapeCourse.js
import * as cheerio from "cheerio";

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

  // pick right URL
  let url = pickCourseUrl(course, { date, holes });

  // PHONE
  if (course.provider === "Phone") {
    return baseReturn(course, date, false, null, { note: "phone only" });
  }

  // LINK ONLY
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

  // MiClub etc.
  if (course.provider === "MiClub") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });

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

      $("tr, .timesheet-row, .booking-row").each((i, el) => {
        const $row = $(el);
        const rowText = $row.text().trim();
        if (!rowText) return;

        // time
        const m = rowText.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let time = m[1];
        if (time.length === 4) time = "0" + time;
        const timeMin = toMinutes(time);

        if (startMin && timeMin < startMin) return;
        if (endMin && timeMin > endMin) return;

        const lower = rowText.toLowerCase();
        const hasAction =
          lower.includes("book") ||
          lower.includes("available") ||
          $row.find("a,button").length > 0;
        if (!hasAction) return;

        if (partySize > 1) {
          const spotMatch = rowText.match(/(\d+)\s*(spots|left|avail|players)?/i);
          if (spotMatch) {
            const spots = parseInt(spotMatch[1], 10);
            if (!isNaN(spots) && spots < partySize) {
              return;
            }
          }
        }

        strictMatches.push({
          time,
          snippet: rowText.slice(0, 120) + "..."
        });
      });

      if (strictMatches.length > 0) {
        return [
          {
            course: course.name,
            provider: course.provider,
            available: true,
            bookingUrl: url,
            times: strictMatches.map((m) => m.time),
            lat: course.lat,
            lng: course.lng,
            city: course.city,
            state: course.state,
            confidence: "high"
          }
        ];
      }

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




