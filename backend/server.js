// backend/server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeMiClubPage } from './scrapers/scrapeMiClubPage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load WA courses
const coursesPath = path.join(__dirname, 'data', 'courses.json');
const courses = JSON.parse(fs.readFileSync(coursesPath, 'utf-8'));

// lookup so we can reattach coords even if scraping failed
const courseByName = Object.fromEntries(courses.map(c => [c.name, c]));

const app = express();
app.use(express.json());

// serve frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'book.html'));
});

app.post('/api/search', async (req, res) => {
  const { date, earliest = '06:00', latest = '18:00', partySize = 1 } = req.body || {};

  const tasks = courses.map(async (course) => {
    try {
      const result = await scrapeMiClubPage(course, {
        date,
        earliest,
        latest,
        partySize
      });
      return result;
    } catch (err) {
      console.error('SCRAPE ERROR for', course.name, err.message);
      return [{
        course: course.name,
        provider: course.provider,
        available: false,
        bookingUrl: course.bookingBase ? course.bookingBase.replace('YYYY-MM-DD', date) : null,
        lat: course.lat,
        lng: course.lng,
        city: course.city,
        state: course.state,
        error: err.message
      }];
    }
  });

  let all = (await Promise.all(tasks)).flat();

  // safety pass — make sure everything has coords
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
