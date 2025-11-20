// backend/auth.js
// Postgres-backed auth with auto table creation.
// Does NOT touch booking or analytics logic.

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pkg from "pg";

const { Pool } = pkg;
export const authRouter = express.Router();

// ----- Postgres connection -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ----- Ensure users table exists -----
async function ensureUsersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        home_course TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log("[auth] users table ready");
  } catch (err) {
    console.error("[auth] Failed to ensure users table:", err);
  }
}
ensureUsersTable();

// ----- JWT config -----
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY_12345";
const TOKEN_LIFETIME = "30d";

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    "SELECT id, email, password_hash, home_course FROM users WHERE email = $1",
    [email]
  );
  return rows[0] || null;
}

// ===== SIGNUP =====
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, homeCourse } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email & password required" });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: "Account already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, home_course)
       VALUES ($1, $2, $3)
       RETURNING id, email, home_course`,
      [email, hash, homeCourse || null]
    );

    const user = rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

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
    res.status(500).json({ error: "Signup failed" });
  }
});

// ===== LOGIN =====
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email & password required" });
    }

    const user = await findUserByEmail(email);
    if (!user) return res.status(400).json({ error: "Invalid login" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: "Invalid login" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

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
    res.status(500).json({ error: "Login failed" });
  }
});

// ===== VERIFY TOKEN =====
authRouter.post("/verify", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });

    const data = jwt.verify(token, JWT_SECRET);

    const { rows } = await pool.query(
      "SELECT email, home_course FROM users WHERE id = $1",
      [data.id]
    );
    const user = rows[0];
    if (!user) return res.json({ ok: false });

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

// ===== UPDATE HOME COURSE =====
authRouter.post("/update-home", async (req, res) => {
  try {
    const { token, homeCourse } = req.body || {};
    if (!token) return res.status(400).json({ error: "Missing token" });

    const data = jwt.verify(token, JWT_SECRET);

    await pool.query(
      "UPDATE users SET home_course = $1 WHERE id = $2",
      [homeCourse || null, data.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Update home course error:", err);
    res.status(500).json({ error: "Failed" });
  }
});