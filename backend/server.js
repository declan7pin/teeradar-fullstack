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
//  STATIC FRONTEND FIX — SERVE backend/public/*
//  (Your index.html is in backend/public, NOT in /assets)
// =============================================================

const publicDir = path.join(__dirname, 'public');

// Serve everything inside backend/public
app.use(express.static(publicDir));

// Serve homepage correctly
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// =============================================================
//  LOAD COURSES JSON
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
  res.json(courses);
});

// =============================================================
//  START SERVER
// =============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
