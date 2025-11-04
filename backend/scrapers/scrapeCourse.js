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

  // build correct URL per provider
  let url = course.bookingBase || null;
  if (url) {
    if (course.provider === 'Quick18') {
      // quick18 = YYYYMMDD
      url = url.replace('YYYYMMDD', date.replace(/-/g, ''));
    } else {
      // everyone else = YYYY-MM-DD
      url = url.replace('YYYY-MM-DD', date);
    }
  }

  // 1) MiClub
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

      const matches = [];
      // generic find-time logic
      $('tr, .timeslot-time, td').each((i, el) => {
        const text = $(el).text().trim();
        const m = text.match(/(\d{1,2}:\d{2})/);
        if (!m) return;
        let t = m[1];
        if (t.length === 4) t = '0' + t;
        if (t >= earliest && t <= latest) {
          matches.push(t);
        }
      });

      if (matches.length === 0) {
        return baseReturn(course, date, false, url, { reason: 'no times in window' });
      }

      return [{
        course: course.name,
        provider: course.provider,
        available: true,
        times: matches,
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

  // 2) Quick18 (Hamersley)
  if (course.provider === 'Quick18') {
    if (!url) return baseReturn(course, date, false, null, { reason: 'no url' });
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'TeeRadar/1.0' } });
      if (resp.ok) {
        // we reached it — for now we just return link
        return baseReturn(course, date, false, url, { reachable: true, note: 'Quick18 reached; add parser later' });
      }
      return baseReturn(course, date, false, url, { reachable: false });
    } catch (e) {
      return baseReturn(course, date, false, url, { error: e.message });
    }
  }

  // 3) GolfBooking (Altone) — link-only
  if (course.provider === 'GolfBooking') {
    return baseReturn(course, date, false, url, { note: 'link-only provider' });
  }

  // fallback
  return baseReturn(course, date, false, url, { reason: 'unknown provider' });
}


