// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pkg from "pg";

const { Pool } = pkg;

// --- JWT CONFIG ---
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_DEV_SECRET_CHANGE_ME";
const TOKEN_LIFETIME = "30d";

// --- DATABASE POOL ---
// Use AUTH_DATABASE_URL if set, otherwise fall back to DATABASE_URL
const connectionString =
  process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[auth] No AUTH_DATABASE_URL / DATABASE_URL set. Auth will FAIL in production."
  );
}

const pool = new Pool({
  connectionString,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Create table if it doesn't exist
async function initAuthTable() {
  if (!connectionString) return;

  const sql = `
    CREATE TABLE IF NOT EXISTS teeradar_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      home_course TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;
  try {
    await pool.query(sql);
    console.log("[auth] teeradar_users table ready");
  } catch (err) {
    console.error("[auth] Failed to init auth table:", err.message);
  }
}
initAuthTable();

const authRouter = express.Router();

// --- HELPERS ---
async function findUserByEmail(email) {
  const { rows } = await pool.query(
    "SELECT * FROM teeradar_users WHERE email = $1",
    [email]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    "SELECT * FROM teeradar_users WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

// --- SIGNUP ---
authRouter.post("/signup", async (req, res) => {
  try {
    if (!connectionString) {
      return res
        .status(500)
        .json({ error: "Auth DB not configured (no DATABASE_URL set)" });
    }

    const { email, password, homeCourse } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required" });
    }

    const existing = await findUserByEmail(email.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: "Account already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const insertSql = `
      INSERT INTO teeradar_users (email, password_hash, home_course)
      VALUES ($1, $2, $3)
      RETURNING id, email, home_course;
    `;
    const { rows } = await pool.query(insertSql, [
      email.toLowerCase(),
      hash,
      homeCourse || null,
    ]);
    const user = rows[0];

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.error("[auth] signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// --- LOGIN ---
authRouter.post("/login", async (req, res) => {
  try {
    if (!connectionString) {
      return res
        .status(500)
        .json({ error: "Auth DB not configured (no DATABASE_URL set)" });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required" });
    }

    const user = await findUserByEmail(email.toLowerCase());
    if (!user) {
      return res.status(400).json({ error: "Invalid login" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid login" });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.error("[auth] login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// --- VERIFY TOKEN ---
authRouter.post("/verify", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.id);
    if (!user) return res.json({ ok: false });

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        homeCourse: user.home_course,
      },
    });
  } catch (err) {
    console.warn("[auth] verify failed:", err.message);
    res.json({ ok: false });
  }
});

// --- UPDATE HOME COURSE ---
authRouter.post("/update-home", async (req, res) => {
  try {
    const { token, homeCourse } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    await pool.query(
      "UPDATE teeradar_users SET home_course = $1 WHERE id = $2",
      [homeCourse || null, payload.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth] update-home error:", err);
    res.status(500).json({ error: "Failed to update home course" });
  }
});

export { authRouter };