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
//  STATIC FRONTEND
//  Your index.html is in ROOT /public, not backend/public
// =============================================================

// Go up one level from backend/ → to repo root, then into public/
const publicDir = path.join(__dirname, '..', 'public');

// Serve everything in /public (index.html, admin.html, assets/, etc.)
app.use(express.static(publicDir));

// Serve homepage at "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// =============================================================
//  LOAD COURSES JSON (still in backend/data/courses.json)
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

// API: return all courses
app.get('/api/courses', (req, res) => {
  try {
    res.json(courses);
  } catch (err) {
    console.error('Error returning courses:', err);
    res.status(500).json({ error: 'Failed to load course list' });
  }
});

// =============================================================
//  START SERVER
// =============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
