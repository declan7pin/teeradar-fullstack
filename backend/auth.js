// backend/auth.js
import express from "express";
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
    const normEmail = normaliseEmail(email || "");

    if (!normEmail || !password || password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    // DEV-SIMPLE VERSION:
    // Store the password as plain text in password_hash.
    // Also: upsert so you can safely re-create your account.
    const result = await db.query(
      `
      INSERT INTO users (email, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id;
    `,
      [normEmail, password]
    );

    console.log("🔐 signup/upsert result:", result.rowCount, "rows");

    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("❌ signup error:", err);
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

    console.log("🔐 login query rows:", result.rowCount);

    if (result.rowCount === 0) {
      // email not found
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const user = result.rows[0];

    // Plain text comparison (dev-only)
    if (user.password_hash !== password) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    // Success
    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("❌ login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;