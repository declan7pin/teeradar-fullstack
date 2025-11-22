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
    const normEmail = normaliseEmail(email);

    if (!normEmail || !password) {
      console.log("🔐 signup invalid input:", { email });
      return res.json({
        ok: false,
        error: "Please enter an email and password.",
      });
    }

    // (Optional) you can re-enable a length check later if you want
    // if (password.length < 6) { ... }

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

    console.log("🔐 signup/upsert result:", result.rowCount, "rows");

    if (result.rowCount === 0) {
      // Email already exists
      return res.json({
        ok: false,
        error: "That email is already registered. Try logging in instead.",
      });
    }

    // Success
    return res.json({
      ok: true,
      email: normEmail,
    });
  } catch (err) {
    console.error("🔐 signup error:", err);
    return res.json({
      ok: false,
      error: "Something went wrong. Please try again.",
    });
  }
});

// ---------- LOGIN ----------
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = normaliseEmail(email);

    if (!normEmail || !password) {
      console.log("🔐 login invalid input:", { email });
      return res.json({
        ok: false,
        error: "Please enter an email and password.",
      });
    }

    const result = await db.query(
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [normEmail]
    );

    console.log("🔐 login query rows:", result.rowCount);

    if (result.rowCount === 0) {
      return res.json({
        ok: false,
        error: "Invalid email or password.",
      });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.json({
        ok: false,
        error: "Invalid email or password.",
      });
    }

    // Success
    return res.json({
      ok: true,
      email: normEmail,
    });
  } catch (err) {
    console.error("🔐 login error:", err);
    return res.json({
      ok: false,
      error: "Something went wrong. Please try again.",
    });
  }
});

export default authRouter;