// backend/auth.js
// Simple auth router backed by PostgreSQL "users" table.

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;
export const authRouter = express.Router();

// ====== DB POOL ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// Ensure "users" table exists
async function ensureUsersTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      home_course TEXT
    );
  `;
  await pool.query(sql);
}
ensureUsersTable().catch((err) =>
  console.error("Error ensuring users table:", err)
);

// ===== JWT CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY_12345";
const TOKEN_LIFETIME = "30d";

// Helper to issue token
function issueToken(userRow) {
  return jwt.sign({ id: userRow.id }, JWT_SECRET, {
    expiresIn: TOKEN_LIFETIME,
  });
}

// ====== SIGNUP ======
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, homeCourse } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Email & password required" });
    }

    const emailNorm = String(email).trim().toLowerCase();

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [emailNorm]
    );
    if (existing.rows.length > 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Account already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const insert = await pool.query(
      `
        INSERT INTO users (email, password_hash, home_course)
        VALUES ($1, $2, $3)
        RETURNING id, email, home_course
      `,
      [emailNorm, hash, homeCourse || null]
    );

    const user = insert.rows[0];
    const token = issueToken(user);

    res.json({
      ok: true,
      token,
      user: {
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ ok: false, error: "Signup failed" });
  }
});

// ====== LOGIN ======
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Email & password required" });
    }

    const emailNorm = String(email).trim().toLowerCase();

    const result = await pool.query(
      "SELECT id, email, password_hash, home_course FROM users WHERE email = $1",
      [emailNorm]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid login" });
    }

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ ok: false, error: "Invalid login" });
    }

    const token = issueToken(user);

    res.json({
      ok: true,
      token,
      user: {
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ ok: false, error: "Login failed" });
  }
});

// ====== VERIFY TOKEN ======
authRouter.post("/verify", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });

    const data = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      "SELECT id, email, home_course FROM users WHERE id = $1",
      [data.id]
    );
    if (result.rows.length === 0) {
      return res.json({ ok: false });
    }

    const user = result.rows[0];
    res.json({
      ok: true,
      user: {
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.error("Verify token error:", err);
    res.json({ ok: false });
  }
});

// ====== UPDATE HOME COURSE ======
authRouter.post("/update-home", async (req, res) => {
  try {
    const { token, homeCourse } = req.body || {};
    if (!token) {
      return res.status(401).json({ ok: false, error: "No token" });
    }

    const data = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `
        UPDATE users
        SET home_course = $1
        WHERE id = $2
        RETURNING id
      `,
      [homeCourse || null, data.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "User not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Update home course error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
});