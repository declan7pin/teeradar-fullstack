// backend/scrapers/scrapeCourse.js
import * as cheerio from 'cheerio';

function baseReturn(course, date, available, bookingUrl, extra = {}) {
  return [{
    course: course.name,
    provider: course.provider,
    available,
    bookingUrl,
    lat: course.lat,
    lng: course.lng,
    city: course.city,
    state: course.state,
    ...extra
  }];
}

export async function scrapeCourse(course, criteria) {
  const { date, earliest, latest } = criteria;

  // build URL according to provider
  let url = course.bookingBase || null;
  if (url) {
    if (course.provider === 'Quick18') {
      url = url.replace('YYYYMMDD', date.replace(/-/g, ''));
    } else {
      url = url.replace('YYYY-MM-DD', date);
    }
  }

  // -------- MiClub (most of your WA courses) --------
  if (course.provider === 'MiClub') {
    if (!url) return baseReturn(course, date, false, null, { reason: 'no url' });

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'TeeRadar/1.0',
          'Accept': 'text/html'
        }
      });
      const html = await resp.text();
      const $ = cheerio.load(html);

      const foundTimes = [];

      // 1) common MiClub time cells (sometimes they use class names)
      $('.timeslot-time, .timeslot, tr, td').each((i, el) => {
        const text = $(el).text().trim();
        if (!text) return;
        const m = text.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let t = m[1];
        if (t.length === 4) t = '0' + t; // 7:10 -> 07:10
        if (t >= earliest && t <= latest) {
          foundTimes.push(t);
        }
      });

      // 2) fallback: sometimes it's inside a link/button
      $('a, button').each((i, el) => {
        const text = $(el).text().trim();
        const m = text.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let t = m[1];
        if (t.length === 4) t = '0' + t;
        if (t >= earliest && t <= latest) {
          foundTimes.push(t);
        }
      });

      if (foundTimes.length === 0) {
        // we reached the page, but didn’t see slot text
        return baseReturn(course, date, false, url, { reason: 'no times matched' });
      }

      return [{
        course: course.name,
        provider: course.provider,
        available: true,
        times: foundTimes,
        bookingUrl: url,
        lat: course.lat,
        lng: course.lng,
        city: course.city,
        state: course.state
      }];
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // -------- Quick18 (Hamersley) --------
  if (course.provider === 'Quick18') {
    if (!url) return baseReturn(course, date, false, null, { reason: 'no url' });
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'TeeRadar/1.0' } });
      if (resp.ok) {
        return baseReturn(course, date, false, url, { reachable: true, note: 'Quick18 reached; add JSON parser later' });
      }
      return baseReturn(course, date, false, url, { reachable: false });
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // -------- GolfBooking (Altone) --------
  if (course.provider === 'GolfBooking') {
    return baseReturn(course, date, false, url, { note: 'link-only provider' });
  }

  // default
  return baseReturn(course, date, false, url, { reason: 'unknown provider' });
}


