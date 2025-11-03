// backend/scrapers/scrapeMiClubPage.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function scrapeMiClubPage(course, criteria) {
  const { date, earliest, latest, partySize } = criteria;

  if (!course.bookingBase) {
    return [{
      course: course.name,
      provider: course.provider,
      available: false,
      bookingUrl: null,
      reason: 'no bookingBase'
    }];
  }

  const url = course.bookingBase.replace('YYYY-MM-DD', date);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'TeeRadar/1.0',
      'Accept': 'text/html'
    }
  });

  const html = await resp.text();
  const $ = cheerio.load(html);

  const matches = [];

  // Very generic MiClub scrape — you can tighten selectors after you look at the real HTML
  $('tr, div').each((i, el) => {
    const text = $(el).text();
    const m = text.match(/(\d{1,2}:\d{2})/);   // find "7:10" or "07:10"
    if (m) {
      let time = m[1];
      if (time.length === 4) time = '0' + time; // 7:10 -> 07:10
      if (time >= earliest && time <= latest) {
        matches.push({
          course: course.name,
          provider: course.provider,
          time,
          bookingUrl: url,
          available: true
        });
      }
    }
  });

  // if nothing matched, treat course as unavailable for that window
  if (matches.length === 0) {
    return [{
      course: course.name,
      provider: course.provider,
      available: false,
      bookingUrl: url
    }];
  }

  return matches;
}
