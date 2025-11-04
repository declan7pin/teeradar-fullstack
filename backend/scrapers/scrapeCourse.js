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
      ...extra,
    },
  ];
}

// helper: HH:MM → minutes
function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// try to detect “this row is bookable”
function rowLooksBookable($row) {
  const text = $row.text().toLowerCase();
  if (text.includes("book")) return true;
  if (text.includes("available")) return true;
  if ($row.find("a").length > 0) return true;
  return false;
}

export async function scrapeCourse(course, criteria) {
  const { date, earliest = "06:00", latest = "17:00", partySize = 1, holes = "" } = criteria;

  // build URL
  let url = course.bookingBase || null;
  if (url) {
    if (course.provider === "Quick18") {
      url = url.replace("YYYYMMDD", date.replace(/-/g, ""));
    } else {
      url = url.replace("YYYY-MM-DD", date);
    }
  }

  // PHONE-ONLY
  if (course.provider === "Phone") {
    return baseReturn(course, date, false, null, {
      note: "phone only",
    });
  }

  // GOLFBOOKING / link only
  if (course.provider === "GolfBooking") {
    return baseReturn(course, date, false, url, {
      note: "link-only provider",
    });
  }

  // MICLUB / similar
  if (course.provider === "MiClub") {
    if (!url) {
      return baseReturn(course, date, false, null, { reason: "no url" });
    }

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "TeeRadar/1.0",
          Accept: "text/html",
        },
      });
      const html = await resp.text();
      const $ = cheerio.load(html);

      const startMin = toMinutes(earliest);
      const endMin = toMinutes(latest);

      const matches = [];

      // MiClub pages are usually tables with rows per tee time
      $("tr, .timesheet-row, .booking-row").each((i, el) => {
        const $row = $(el);
        const rowText = $row.text().trim();
        if (!rowText) return;

        // find a time in this row
        const m = rowText.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let time = m[1];
        if (time.length === 4) time = "0" + time; // 7:05 -> 07:05
        const timeMin = toMinutes(time);

        // filter by time window
        if (startMin && timeMin < startMin) return;
        if (endMin && timeMin > endMin) return;

        // check if bookable
        if (!rowLooksBookable($row)) return;

        // try to detect player capacity in the row
        // (often “4” or “2 left” appears in the row)
        let spotsOk = true;
        if (partySize && partySize > 1) {
          const spotMatch = rowText.match(/(\d+)\s*(spots|left|available)?/i);
          if (spotMatch) {
            const spots = parseInt(spotMatch[1], 10);
            if (!isNaN(spots) && spots < partySize) {
              spotsOk = false;
            }
          }
        }
        if (!spotsOk) return;

        // holes: most MiClub pages don’t show 9 vs 18 in the row,
        // so we only filter if the course itself declares fixed holes
        if (holes && course.holes && String(course.holes) !== String(holes)) {
          return;
        }

        matches.push({
          time,
          row: rowText.slice(0, 120) + "...",
        });
      });

      if (matches.length === 0) {
        // stricter: no confirmed times, mark unavailable
        return baseReturn(course, date, false, url, {
          reason: "no matching rows in time window",
        });
      }

      return [
        {
          course: course.name,
          provider: course.provider,
          available: true,
          bookingUrl: url,
          times: matches.map((m) => m.time),
          lat: course.lat,
          lng: course.lng,
          city: course.city,
          state: course.state,
        },
      ];
    } catch (e) {
      return baseReturn(course, date, false, url, {
        error: e.message,
      });
    }
  }

  // QUICK18: we can only check reachability for now
  if (course.provider === "Quick18") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "TeeRadar/1.0" },
      });
      if (resp.ok) {
        return baseReturn(course, date, false, url, {
          reachable: true,
          note: "Quick18 reached; add table parser when structure known",
        });
      }
      return baseReturn(course, date, false, url, { reachable: false });
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // fallback
  return baseReturn(course, date, false, url, {
    reason: "unknown provider",
  });
}




