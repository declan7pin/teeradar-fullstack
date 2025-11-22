// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";

export const authRouter = express.Router();

// ---------- TABLE SETUP ----------
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
    console.error("❌ ensureUsersTable error:", err);
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
    const normEmail = normaliseEmail(email);

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
    // IMPORTANT: bubble the real error so we can see it in the popup
    return res.status(500).json({
      ok: false,
      error: `Signup error: ${err.message}`,
    });
  }
});

// ---------- LOGIN ----------
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email);

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
      // Generic error to avoid leaking which emails exist
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      // Safety net in case the column/schema is weird
      console.error("login error: password_hash is null for user", user);
      return res.status(500).json({
        ok: false,
        error: "Login error: password not stored correctly. Please contact support.",
      });
    }

    let isValid = false;
    try {
      isValid = await bcrypt.compare(password, user.password_hash);
    } catch (cmpErr) {
      console.error("bcrypt.compare error:", cmpErr);
      return res.status(500).json({
        ok: false,
        error: `Login error: ${cmpErr.message}`,
      });
    }

    if (!isValid) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    // For now we just return ok + email (no JWT/session yet)
    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("login error:", err);
    // Again, bubble the actual message so we can see what’s wrong
    return res.status(500).json({
      ok: false,
      error: `Login error: ${err.message}`,
    });
  }
});

export default authRouter;