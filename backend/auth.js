// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";

export const authRouter = express.Router();

// ----- helpers -----
function normaliseEmail(email) {
  return (email || "").trim().toLowerCase();
}

// Ensure users table exists
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

    if (result.rowCount === 0) {
      // email already exists
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

    // No JWT yet – front end just checks ok:true
    return res.json({ ok: true, email: user.email });
  } catch (err) {
    console.error("login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

// ---------- RESET PASSWORD (simple flow) ----------
// NOTE: this is a very basic reset – NO email link, etc.
// User enters email + new password and it updates if the email exists.
// Fine for your own project, not production-grade security.
authRouter.post("/reset", async (req, res) => {
  try {
    const { email, newPassword } = req.body || {};
    const normEmail = normaliseEmail(email);

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

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "No account found for that email" });
    }

    console.log("🔐 password reset for", normEmail);
    return res.json({ ok: true, email: normEmail });
  } catch (err) {
    console.error("reset error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;