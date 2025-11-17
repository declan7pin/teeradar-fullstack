// backend/server.js

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM path fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// ---------- STATIC FRONTEND ----------

// This folder contains index.html, admin.html, assets/, etc.
const publicDir = path.join(__dirname, 'public');

// Serve all static files (HTML, JS, CSS, images, etc.)
app.use(express.static(publicDir));

// Serve the main homepage at "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------- COURSES API ----------

const coursesFilePath = path.join(__dirname, 'data', 'courses.json');
let courses = [];

try {
  const rawData = fs.readFileSync(coursesFilePath, 'utf-8');
  courses = JSON.parse(rawData);
  console.log(`Loaded ${courses.length} golf courses from courses.json`);
} catch (err) {
  console.error('Failed to load courses.json:', err);
  courses = [];
}

// List of courses for the map
app.get('/api/courses', (req, res) => {
  try {
    res.json(courses);
  } catch (err) {
    console.error('Error returning courses:', err);
    res.status(500).json({ error: 'Failed to load course list' });
  }
});

// ---------- START SERVER ----------

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
