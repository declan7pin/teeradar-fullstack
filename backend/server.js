// backend/server.js

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// STATIC FRONTEND
// ----------------------------------------------------

const publicDir = path.join(__dirname, '..', 'public');

app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ----------------------------------------------------
// COURSES API
// ----------------------------------------------------

const coursesFilePath = path.join(__dirname, 'data', 'courses.json');
let courses = [];

try {
  const raw = fs.readFileSync(coursesFilePath, 'utf-8');
  courses = JSON.parse(raw);
  console.log(`Loaded ${courses.length} courses.`);
} catch (err) {
  console.error('Failed to load courses.json:', err);
  courses = [];
}

app.get('/api/courses', (req, res) => {
  res.json(courses);
});

// ----------------------------------------------------
// TEMP: LOG ALL OTHER /api CALLS
// ----------------------------------------------------

// This is where the frontend search requests are going.
// We log them so we can see the exact path + query/body,
// then return an empty but successful response for now.

app.all('/api/*', (req, res) => {
  if (req.path === '/api/courses') {
    return res.status(404).json({ error: 'Not found' });
  }

  console.log('Incoming API request:');
  console.log('  Path:', req.path);
  console.log('  Method:', req.method);
  console.log('  Query:', req.query);
  console.log('  Body:', req.body);

  // TODO: once we know the real endpoint and payload,
  // replace this with calls into the scrapers.
  return res.json({
    ok: true,
    message: 'Stub backend response – no tee times implemented yet',
    endpoint: req.path,
    results: []
  });
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});


