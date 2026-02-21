// backend/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";

// ✅ NEW: JWT for authenticated "My Rounds" access
import jwt from "jsonwebtoken";

// Optional: SQLite analytics tracking (safe to keep even if not used)
import analyticsDb from "./db/analyticsDb.js";

export const authRouter = express.Router();

// ✅ NEW: resolve JWT secret from env (supports your existing env naming)
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_JWT_SECRET ||
  process.env.AUTH_SECRET ||
  "";

// ✅ NEW: create a signed token
function signToken(user) {
  if (!JWT_SECRET) return "";
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// ✅ NEW: middleware to require login via Bearer token
export function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ ok: false, error: "JWT_SECRET not set" });
    }

    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1].trim() : "";

    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing token" });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    // attach user context for downstream routes
    req.user = {
      id: payload.id,
      email: payload.email,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

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
        home_course_id TEXT,
        home_course_state TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login TIMESTAMPTZ
      );
    `);

    // In case the table already existed without newer columns
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course TEXT;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course_id TEXT;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS home_course_state TEXT;
    `);

    // ensure created_at exists on older DBs
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    // track last_login for "Last seen" column
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
    // NEW: accept homeCourseId + homeCourseState from frontend
    const {
      email,
      password,
      homeCourse,
      homeCourseId,
      homeCourseState,
    } = req.body || {};

    const normEmail = normaliseEmail(email);

    if (!normEmail || !password || password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email or password" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `
        INSERT INTO users (email, password_hash, home_course, home_course_id, home_course_state, last_login)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (email) DO NOTHING
        RETURNING id, email, home_course, home_course_id, home_course_state, created_at, last_login;
      `,
      [
        normEmail,
        passwordHash,
        homeCourse || null,
        homeCourseId || null,
        homeCourseState || null,
      ]
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

    // ✅ NEW: JWT token (only if JWT_SECRET exists)
    const token = signToken({ id: row.id, email: row.email });

    return res.json({
      ok: true,
      token: token || undefined,
      user: {
        email: row.email,
        homeCourse: row.home_course || null,
        homeCourseId: row.home_course_id || null,
        homeCourseState: row.home_course_state || null,
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
      `SELECT id,
              email,
              password_hash,
              home_course,
              home_course_id,
              home_course_state,
              last_login
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

    // update last_login timestamp
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [
      user.id,
    ]);

    // Optional: also touch SQLite analytics user tracker
    if (analyticsDb?.recordRegisteredUser) {
      analyticsDb.recordRegisteredUser(normEmail);
    }

    // ✅ NEW: JWT token (only if JWT_SECRET exists)
    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      ok: true,
      token: token || undefined,
      user: {
        email: user.email,
        homeCourse: user.home_course || null,
        homeCourseId: user.home_course_id || null,
        homeCourseState: user.home_course_state || null,
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
        RETURNING id,
                  email,
                  home_course,
                  home_course_id,
                  home_course_state,
                  last_login;
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

    // ✅ NEW: refresh token after reset (only if JWT_SECRET exists)
    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      ok: true,
      token: token || undefined,
      user: {
        email: user.email,
        homeCourse: user.home_course || null,
        homeCourseId: user.home_course_id || null,
        homeCourseState: user.home_course_state || null,
      },
    });
  } catch (err) {
    console.error("reset error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

// ---------- ME (fetch current user's saved preferences) ----------
authRouter.get("/me", async (req, res) => {
  try {
    // ✅ NEW: prefer Bearer token, fall back to header/query (keeps old behaviour)
    let normEmail = "";

    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1].trim() : "";

    if (token && JWT_SECRET) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        normEmail = normaliseEmail(payload.email);
      } catch {
        // ignore and fall back
      }
    }

    // Minimal identification: header OR query param
    const headerEmail = req.headers["x-user-email"];
    const queryEmail = req.query.email;
    normEmail = normaliseEmail(normEmail || headerEmail || queryEmail);

    if (!normEmail) {
      return res.status(401).json({ ok: false, error: "Missing email" });
    }

    const result = await db.query(
      `SELECT email, home_course, home_course_id, home_course_state
       FROM users
       WHERE email = $1`,
      [normEmail]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const row = result.rows[0];

    return res.json({
      ok: true,
      user: {
        email: row.email,
        homeCourse: row.home_course || null,
        homeCourseId: row.home_course_id || null,
        homeCourseState: row.home_course_state || null,
      },
    });
  } catch (err) {
    console.error("me error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load user" });
  }
});

export default authRouter;
