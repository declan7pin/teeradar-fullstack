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
        home_course TEXT,
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

/**
 * SIGNUP
 *
 * Behaviour:
 *  - If email does NOT exist → create new user
 *  - If email already exists → UPDATE password_hash (acts as reset)
 *
 * Response: { ok: true, email, mode: "created" | "reset" }
 */
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, homeCourse } = req.body || {};
    const normEmail = normaliseEmail(email || "");

    if (!normEmail || !password || password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Does this email already exist?
    const existing = await db.query(
      `SELECT id FROM users WHERE email = $1`,
      [normEmail]
    );

    if (existing.rowCount > 0) {
      // Update password (reset)
      await db.query(
        `
        UPDATE users
        SET password_hash = $2,
            home_course = COALESCE($3, home_course)
        WHERE email = $1
      `,
        [normEmail, passwordHash, homeCourse || null]
      );

      console.log("🔐 signup: password reset for existing user", normEmail);

      return res.json({
        ok: true,
        email: normEmail,
        mode: "reset",
      });
    }

    // New user
    const insert = await db.query(
      `
      INSERT INTO users (email, password_hash, home_course)
      VALUES ($1, $2, $3)
      RETURNING id, email, home_course
    `,
      [normEmail, passwordHash, homeCourse || null]
    );

    const user = insert.rows[0];
    console.log("🔐 signup: created new user", user.email);

    return res.json({
      ok: true,
      email: user.email,
      mode: "created",
    });
  } catch (err) {
    console.error("signup error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

/**
 * LOGIN
 *
 * Checks email + password using bcrypt.
 */
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
      `SELECT id, email, password_hash, home_course FROM users WHERE email = $1`,
      [normEmail]
    );

    console.log("🔐 login: rows =", result.rowCount, "email =", normEmail);

    if (result.rowCount === 0) {
      // Same generic error for security
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

    // For now we don't bother with JWT – we just return success + user info.
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        homeCourse: user.home_course || null,
      },
      token: null, // kept for future compatibility
    });
  } catch (err) {
    console.error("login error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

export default authRouter;