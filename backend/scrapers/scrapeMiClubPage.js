// backend/scrapers/scrapeMiClubPage.js
import * as cheerio from 'cheerio';

export async function scrapeMiClubPage(course, criteria) {
  const { date, earliest, latest } = criteria;

  if (!course.bookingBase) {
    return [{
      course: course.name,
      provider: course.provider,
      available: false,
      bookingUrl: null,
      lat: course.lat,
      lng: course.lng,
      city: course.city,
      state: course.state,
      reason: 'no bookingBase'
    }];
  }

  const url = course.bookingBase.replace('YYYY-MM-DD', date);

  // Node 22 has global fetch, so just use it
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'TeeRadar/1.0',
      'Accept': 'text/html'
    }
  });

  const html = await resp.text();
  const $ = cheerio.load(html);

  const matches = [];

  // generic MiClub scan — you can tighten later
  $('tr, div').each((i, el) => {
    const text = $(el).text();
    const m = text.match(/(\d{1,2}:\d{2})/);
    if (!m) return;

    let time = m[1];
    if (time.length === 4) time = '0' + time; // 7:10 -> 07:10

    if (time >= earliest && time <= latest) {
      matches.push({
        course: course.name,
        provider: course.provider,
        available: true,
        time,
        bookingUrl: url,
        lat: course.lat,
        lng: course.lng,
        city: course.city,
        state: course.state
      });
    }
  });

  if (matches.length === 0) {
    return [{
      course: course.name,
      provider: course.provider,
      available: false,
      bookingUrl: url,
      lat: course.lat,
      lng: course.lng,
      city: course.city,
      state: course.state
    }];
  }

  return matches;
}


