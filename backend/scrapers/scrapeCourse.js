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

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function scrapeCourse(course, criteria) {
  const {
    date,
    earliest = "06:00",
    latest = "17:00",
    partySize = 1,
    holes = "",
  } = criteria;

  // build URL
  let url = course.bookingBase || null;
  if (url) {
    if (course.provider === "Quick18") {
      // YYYYMMDD
      url = url.replace("YYYYMMDD", date.replace(/-/g, ""));
    } else {
      // YYYY-MM-DD
      url = url.replace("YYYY-MM-DD", date);
    }
  }

  // PHONE ONLY
  if (course.provider === "Phone") {
    return baseReturn(course, date, false, null, { note: "phone only" });
  }

  // LINK ONLY
  if (course.provider === "GolfBooking") {
    return baseReturn(course, date, false, url, {
      note: "link-only provider",
    });
  }

  // MICLUB (most of your WA courses)
  if (course.provider === "MiClub") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "TeeRadar/1.0",
          Accept: "text/html",
        },
      });

      // if the site blocks us, just return unavailable
      if (!resp.ok) {
        return baseReturn(course, date, false, url, {
          reason: "fetch not ok",
          status: resp.status,
        });
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      const startMin = toMinutes(earliest);
      const endMin = toMinutes(latest);

      const strictMatches = [];
      const looseTimes = [];

      // look through rows / cells for times
      $("tr, td, div, a, button").each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (!text) return;

        // find HH:MM
        const m = text.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let time = m[1];
        if (time.length === 4) time = "0" + time; // 7:05 -> 07:05
        const timeMin = toMinutes(time);

        // remember that we saw *some* tee times
        looseTimes.push(time);

        // time window check
        if (startMin && timeMin < startMin) return;
        if (endMin && timeMin > endMin) return;

        // try to find the row around it
        const row = $el.closest("tr");
        let rowText = row.text().trim();
        if (!rowText) rowText = text;

        // OPTIONAL: party size check — only if the row actually shows a number
        let spotsOk = true;
        if (partySize > 1) {
          const spotMatch = rowText.match(/(\d+)\s*(spots|left|avail|players)?/i);
          if (spotMatch) {
            const spots = parseInt(spotMatch[1], 10);
            if (!isNaN(spots) && spots < partySize) {
              spotsOk = false;
            }
          }
        }
        if (!spotsOk) return;

        // holes — only filter if course itself declares fixed holes
        if (holes && course.holes && String(course.holes) !== String(holes)) {
          return;
        }

        // now we consider this a strict match
        strictMatches.push({
          time,
          snippet: rowText.slice(0, 120) + "...",
        });
      });

      // 1) if we found strict matches, great
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
            confidence: "high",
          },
        ];
      }

      // 2) no strict matches but we DID see times on the page → fallback to "unconfirmed available"
      if (looseTimes.length > 0) {
        return [
          {
            course: course.name,
            provider: course.provider,
            available: true,               // <-- fallback to true
            bookingUrl: url,
            times: looseTimes,
            lat: course.lat,
            lng: course.lng,
            city: course.city,
            state: course.state,
            confidence: "low",             // tell frontend it was loose
          },
        ];
      }

      // 3) page loaded but no times at all
      return baseReturn(course, date, false, url, {
        reason: "no times on page",
      });
    } catch (e) {
      return baseReturn(course, date, false, url, {
        error: e.message,
      });
    }
  }

  // QUICK18
  if (course.provider === "Quick18") {
    if (!url) return baseReturn(course, date, false, null, { reason: "no url" });
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "TeeRadar/1.0" } });
      if (resp.ok) {
        return baseReturn(course, date, false, url, {
          reachable: true,
          note: "Quick18 reached; add parser when structure is known",
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





