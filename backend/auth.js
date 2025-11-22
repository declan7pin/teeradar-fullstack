// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";

export const authRouter = express.Router();

// Make sure the users table exists (runs once on startup)
async function ensureUsersTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ users table ready");
  } catch (err) {
    console.error("❌ ensureUsersTable error:", err.message);
  }
}
ensureUsersTable();

// Helper – normalise email
function normaliseEmail(email) {
  return (email || "").trim().toLowerCase();
}

// ---------- SIGNUP ----------
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email || "");

    if (!normEmail || !password || password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `
      INSERT INTO users (email, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (email) DO NOTHING
      RETURNING id;
    `,
      [normEmail, passwordHash]
    );

    // Email already exists
    if (result.rowCount === 0) {
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });
    }

    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("signup error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

// ---------- LOGIN ----------
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email || "");

    if (!normEmail || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const result = await db.query(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [normEmail]
    );

    if (result.rowCount === 0) {
      // Same generic error for security
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const user = result.rows[0];

    // Extra safety: make sure we have a valid hash string
    const hash = typeof user.password_hash === "string" ? user.password_hash : null;
    if (!hash) {
      console.error(
        "login error: missing or invalid password_hash for user",
        normEmail
      );
      return res.status(500).json({
        ok: false,
        error: "Account issue detected. Please reset your password or sign up with a different email.",
      });
    }

    let isValid = false;
    try {
      isValid = await bcrypt.compare(password, hash);
    } catch (cmpErr) {
      console.error("bcrypt.compare error for user", normEmail, cmpErr);
      // Treat as invalid login rather than crashing
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    if (!isValid) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    // Front-end just needs to know it worked – token can be added later
    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;