// backend/server.js
import express from 'express';
import fetch from 'node-fetch';
import { scrapeMiClubPage } from './scrapers/scrapeMiClubPage.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) load courses.json
const coursesPath = path.join(__dirname, 'data', 'courses.json');
const courses = JSON.parse(fs.readFileSync(coursesPath, 'utf-8'));

const app = express();
app.use(express.json());

// 2) serve /public as static (note: public is ONE LEVEL ABOVE backend)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// 3) root page -> serve /public/book.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'book.html'));
});

// 4) realtime search
app.post('/api/search', async (req, res) => {
  const { date, earliest = '06:00', latest = '18:00', partySize = 1 } = req.body || {};

  const tasks = courses.map(async (course) => {
    try {
      const result = await scrapeMiClubPage(course, { date, earliest, latest, partySize });
      return result;
    } catch (e) {
      console.warn('Scrape failed for', course.name, e.message);
      return [{
        course: course.name,
        provider: course.provider,
        available: false,
        bookingUrl: course.bookingBase ? course.bookingBase.replace('YYYY-MM-DD', date) : null,
        error: e.message
      }];
    }
  });

  const all = (await Promise.all(tasks)).flat();
  res.json({ date, slots: all });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('TeeRadar WA realtime backend running on', PORT);
});

