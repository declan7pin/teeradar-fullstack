// backend/server.js
import express from 'express';
import fetch from 'node-fetch';
import { scrapeMiClubPage } from './scrapers/scrapeMiClubPage.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load courses.json
const coursesPath = path.join(__dirname, 'data', 'courses.json');
const courses = JSON.parse(fs.readFileSync(coursesPath, 'utf-8'));

// make a quick lookup by name so we can reattach coords later
const courseByName = Object.fromEntries(
  courses.map(c => [c.name, c])
);

const app = express();
app.use(express.json());

// serve public
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'book.html'));
});

app.post('/api/search', async (req, res) => {
  const { date, earliest = '06:00', latest = '18:00', partySize = 1 } = req.body || {};

  const tasks = courses.map(async (course) => {
    try {
      const result = await scrapeMiClubPage(course, { date, earliest, latest, partySize });
      return result;
    } catch (e) {
      console.warn('Scrape failed for', course.name, e.message);
      // IMPORTANT: still return lat/lng from courses.json
      return [{
        course: course.name,
        provider: course.provider,
        available: false,
        bookingUrl: course.bookingBase ? course.bookingBase.replace('YYYY-MM-DD', date) : null,
        lat: course.lat,
        lng: course.lng,
        city: course.city,
        state: course.state,
        error: e.message
      }];
    }
  });

  let all = (await Promise.all(tasks)).flat();

  // safety pass: make sure EVERY item has lat/lng
  all = all.map(slot => {
    const base = courseByName[slot.course];
    return {
      ...slot,
      lat: slot.lat ?? base?.lat ?? null,
      lng: slot.lng ?? base?.lng ?? null,
      city: slot.city ?? base?.city ?? null,
      state: slot.state ?? base?.state ?? null
    };
  });

  res.json({ date, slots: all });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('TeeRadar WA realtime backend running on', PORT);
});
