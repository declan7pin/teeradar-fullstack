// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";

// Optional: SQLite analytics tracking (safe to keep even if not used)
import analyticsDb from "./db/analyticsDb.js";

export const authRouter = express.Router();

// Make sure the users table exists (runs once on startup)
async function ensureUsersTable() {
  try {
    // Base table (will NOT override existing table)
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        home_course TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // In case the table already existed without newer columns
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course TEXT;
    `);

    // NEW: ensure created_at exists on older DBs
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    // NEW: track last_login for "Last seen" column
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
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
    const { email, password, homeCourse } = req.body || {};
    const normEmail = normaliseEmail(email);

    if (!normEmail || !password || password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `
        INSERT INTO users (email, password_hash, home_course, last_login)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (email) DO NOTHING
        RETURNING id, email, home_course, created_at, last_login;
      `,
      [normEmail, passwordHash, homeCourse || null]
    );

    console.log("🔐 signup: rows =", result.rowCount, "email =", normEmail);

    // Email already exists
    if (result.rowCount === 0) {
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered" });
    }

    const row = result.rows[0];

    // Optional: log to SQLite analytics
    if (analyticsDb?.recordRegisteredUser) {
      analyticsDb.recordRegisteredUser(normEmail);
    }

    return res.json({
      ok: true,
      user: {
        email: row.email,
        homeCourse: row.home_course || null,
      },
    });
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
      `SELECT id, email, password_hash, home_course, last_login
       FROM users
       WHERE email = $1`,
      [normEmail]
    );

    console.log("🔐 login: rows =", result.rowCount, "email =", normEmail);

    if (result.rowCount === 0) {
      // Generic message so we don't leak which emails exist
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const user = result.rows[0];

    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log("🔐 login: password match?", isValid);

    if (!isValid) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password" });
    }

    // NEW: update last_login timestamp
    await db.query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`,
      [user.id]
    );

    // Optional: also touch SQLite analytics user tracker
    if (analyticsDb?.recordRegisteredUser) {
      analyticsDb.recordRegisteredUser(normEmail);
    }

    return res.json({
      ok: true,
      user: {
        email: user.email,
        homeCourse: user.home_course || null,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

// ---------- RESET PASSWORD ----------
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
        SET password_hash = $2,
            last_login = NOW()
        WHERE email = $1
        RETURNING id, email, home_course, last_login;
      `,
      [normEmail, passwordHash]
    );

    console.log("🔐 reset: rows =", result.rowCount, "email =", normEmail);

    if (result.rowCount === 0) {
      // No account with that email
      return res
        .status(404)
        .json({ ok: false, error: "Account not found for this email" });
    }

    const user = result.rows[0];

    // Optional: track in SQLite analytics as "seen"
    if (analyticsDb?.recordRegisteredUser) {
      analyticsDb.recordRegisteredUser(normEmail);
    }

    return res.json({
      ok: true,
      user: {
        email: user.email,
        homeCourse: user.home_course || null,
      },
    });
  } catch (err) {
    console.error("reset error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;