// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import pkg from "pg";

const { Pool } = pkg;

// Use env var if set, otherwise fall back to your Render URL
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://teeradar_user_user:ANWbR8pIDv1yjiRJ5MXBvWpamjuRq3FN@dpg-d4fed4a4d50c73a12t9g-a/teeradar_user",
  ssl: {
    rejectUnauthorized: false, // required for Render Postgres
  },
});

// Create users table if it doesn't exist
async function initUsersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ users table ready");
  } catch (err) {
    console.error("❌ Error creating users table:", err);
  }
}
initUsersTable();

export const authRouter = express.Router();

// Helper: normalise email
function normaliseEmail(email) {
  return (email || "").trim().toLowerCase();
}

// POST /api/auth/register
authRouter.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email);

    if (!normEmail || !password || password.length < 6) {
      return res.json({
        ok: false,
        error: "Email and password (min 6 chars) are required.",
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [normEmail]
    );
    if (existing.rows.length > 0) {
      return res.json({
        ok: false,
        error: "An account already exists with this email.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
        INSERT INTO users (email, password_hash)
        VALUES ($1, $2)
        RETURNING id, email, created_at;
      `,
      [normEmail, passwordHash]
    );

    const user = result.rows[0];

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error("register error", err);
    return res.json({
      ok: false,
      error: "Server error while creating account.",
    });
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email);

    if (!normEmail || !password) {
      return res.json({
        ok: false,
        error: "Email and password are required.",
      });
    }

    const result = await pool.query(
      "SELECT id, email, password_hash FROM users WHERE email = $1 LIMIT 1",
      [normEmail]
    );

    if (result.rows.length === 0) {
      return res.json({
        ok: false,
        error: "Incorrect email or password.",
      });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.json({
        ok: false,
        error: "Incorrect email or password.",
      });
    }

    // Frontend only needs to know success + basic user info
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (err) {
    console.error("login error", err);
    return res.json({
      ok: false,
      error: "Server error while logging in.",
    });
  }
});