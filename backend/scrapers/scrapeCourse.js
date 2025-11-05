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

function detectSpotsFromText(text) {
  const m = text.match(/(\d+)\s*(spots|left|available|avail|players)?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

function pickCourseUrl(course, { date, holes }) {
  const day = date ? new Date(date + "T00:00:00") : null;
  const isWeekend = day ? day.getDay() === 0 || day.getDay() === 6 : false;

  // Meadow Springs special
  if (course.name.startsWith("Meadow Springs")) {
    if (holes === "9") {
      if (isWeekend && course.bookingBase9_weekend) return course.bookingBase9_weekend;
      if (!isWeekend && course.bookingBase9_weekday) return course.bookingBase9_weekday;
    } else if (holes === "18") {
      if (isWeekend && course.bookingBase18_weekend) return course.bookingBase18_weekend;
      if (!isWeekend && course.bookingBase18_weekday) return course.bookingBase18_weekday;
    }
  }

  if (holes === "9" && course.bookingBase9) return course.bookingBase9;
  if (holes === "18" && course.bookingBase18) return course.bookingBase18;

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

  let url = pickCourseUrl(course, { date, holes });

  // phone-only
  if (course.provider === "Phone") {
    return baseReturn(course, date, false, null, { note: "phone only" });
  }

  // link-only
  if (course.provider === "GolfBooking") {
    return baseReturn(course, date, false, url, { note: "link-only provider" });
  }

  // Quick18 style
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

  // MiClub / ViewPublicTimesheet
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
      const looseMatches = [];

      $("tr, .timesheet-row, .booking-row, td, div").each((i, el) => {
        const $row = $(el);
        const rowText = $row.text().trim();
        if (!rowText) return;

        const m = rowText.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let time = m[1];
        if (time.length === 4) time = "0" + time;
        const timeMin = toMinutes(time);

        if (startMin && timeMin < startMin) return;
        if (endMin && timeMin > endMin) return;

        const spots = detectSpotsFromText(rowText);
        if (partySize && spots !== null && spots < partySize) {
          return;
        }

        const lower = rowText.toLowerCase();
        const hasAction =
          lower.includes("book") ||
          lower.includes("available") ||
          $row.find("a,button").length > 0;

        const matchObj = {
          time,
          spots,
          snippet: rowText.slice(0, 140) + "..."
        };

        if (hasAction) {
          strictMatches.push(matchObj);
        } else {
          looseMatches.push(matchObj);
        }
      });

      if (strictMatches.length > 0) {
        return [
          {
            course: course.name,
            provider: course.provider,
            available: true,
            bookingUrl: url,
            times: strictMatches.map((m) => m.time),
            slots: strictMatches,
            lat: course.lat,
            lng: course.lng,
            city: course.city,
            state: course.state,
            confidence: "high"
          }
        ];
      }

      if (looseMatches.length > 0) {
        return [
          {
            course: course.name,
            provider: course.provider,
            available: true,
            bookingUrl: url,
            times: looseMatches.map((m) => m.time),
            slots: looseMatches,
            lat: course.lat,
            lng: course.lng,
            city: course.city,
            state: course.state,
            confidence: "medium",
            note: "matched time window but no explicit booking button"
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

  return baseReturn(course, date, false, url, { reason: "unknown provider" });
}



