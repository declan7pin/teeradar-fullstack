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

    console.log("🔐 signup/upsert result:", result.rowCount, "rows");

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
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [normEmail]
    );

    console.log("🔐 login query rows:", result.rowCount);

    if (result.rowCount === 0) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

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

// ---------- SIMPLE RESET PASSWORD ----------
// NOTE: this is a basic "forgot password" for now –
// user enters email + new password in the app.
// For production you'd normally email a reset link.
authRouter.post("/reset", async (req, res) => {
  try {
    const { email, newPassword } = req.body || {};
    const normEmail = normaliseEmail(email || "");

    if (!normEmail || !newPassword || newPassword.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const result = await db.query(
      `
        UPDATE users
        SET password_hash = $2
        WHERE email = $1
        RETURNING id;
      `,
      [normEmail, passwordHash]
    );

    console.log("🔐 reset result rows:", result.rowCount);

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "Email not found" });
    }

    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("reset password error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;