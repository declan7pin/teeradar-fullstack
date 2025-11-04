// backend/server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeCourse } from './scrapers/scrapeCourse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load WA courses
const coursesPath = path.join(__dirname, 'data', 'courses.json');
const courses = JSON.parse(fs.readFileSync(coursesPath, 'utf-8'));

// serve static
const app = express();
app.use(express.json());

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'book.html'));
});

app.post('/api/search', async (req, res) => {
  const { date, earliest = '06:00', latest = '17:00', partySize = 1 } = req.body || {};

  // scrape all courses
  const tasks = courses.map(c => scrapeCourse(c, { date, earliest, latest, partySize }));
  let all = (await Promise.all(tasks)).flat();

  // reattach coords to be safe
  const byName = Object.fromEntries(courses.map(c => [c.name, c]));
  all = all.map(slot => {
    const base = byName[slot.course] || {};
    return {
      ...slot,
      lat: slot.lat ?? base.lat ?? null,
      lng: slot.lng ?? base.lng ?? null,
      city: slot.city ?? base.city ?? null,
      state: slot.state ?? base.state ?? null
    };
  });

  res.json({ date, slots: all });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('TeeRadar WA backend running on', PORT);
});

