// backend/server.js

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix ESM pathing
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// =============================================================
//  STATIC FRONTEND  (root /public folder)
// =============================================================

// Go up one level from backend/ → repo root → public/
const publicDir = path.join(__dirname, '..', 'public');

// Serve everything in /public (index.html, admin.html, assets/, etc.)
app.use(express.static(publicDir));

// Serve homepage at "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// =============================================================
//  LOAD COURSES JSON  (backend/data/courses.json)
// =============================================================

const coursesFilePath = path.join(__dirname, 'data', 'courses.json');
let courses = [];

try {
  const rawData = fs.readFileSync(coursesFilePath, 'utf-8');
  courses = JSON.parse(rawData);
  console.log(`Loaded ${courses.length} courses.`);
} catch (err) {
  console.error('Failed to load courses.json:', err);
  courses = [];
}

// Explicit courses endpoint (used by the map)
app.get('/api/courses', (req, res) => {
  try {
    res.json(courses);
  } catch (err) {
    console.error('Error returning courses:', err);
    res.status(500).json({ error: 'Failed to load course list' });
  }
});

// =============================================================
//  CATCH-ALL FOR OTHER /api/* REQUESTS
//  (Stops "Could not reach backend" errors from the frontend)
// =============================================================

// Any other /api/... request will get a safe, empty OK response.
// This prevents network/404 errors and lets the UI degrade gracefully.
app.all('/api/*', (req, res) => {
  // Don't shadow /api/courses (already handled above)
  if (req.path === '/api/courses') {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json({
    ok: true,
    message: 'Stub backend response',
    endpoint: req.path,
    results: [],
  });
});

// =============================================================
//  START SERVER
// =============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

