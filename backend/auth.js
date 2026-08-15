// backend/auth.js

import express from "express";
import bcrypt from "bcryptjs";
import db from "./db.js";
import jwt from "jsonwebtoken";

// Optional: SQLite analytics tracking
import analyticsDb from "./db/analyticsDb.js";

export const authRouter = express.Router();

/* =========================================================
   JWT
   ========================================================= */

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_JWT_SECRET ||
  process.env.AUTH_SECRET ||
  "";

function signToken(user) {
  if (!JWT_SECRET) return "";

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
    },
    JWT_SECRET,
    {
      expiresIn: "30d",
    }
  );
}

/* =========================================================
   AUTH MIDDLEWARE
   ========================================================= */

export function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "JWT_SECRET not set",
      });
    }

    const auth = String(
      req.headers.authorization || ""
    );

    const match =
      auth.match(/^Bearer\s+(.+)$/i);

    const token =
      match ? match[1].trim() : "";

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Missing token",
      });
    }

    const payload =
      jwt.verify(token, JWT_SECRET);

    req.user = {
      id: payload.id,
      email: payload.email,
    };

    return next();

  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "Invalid token",
    });
  }
}

/* =========================================================
   USERS TABLE
   ========================================================= */

async function ensureUsersTable() {
  try {

    /*
     * Base table.
     * CREATE TABLE IF NOT EXISTS will NOT overwrite
     * an existing users table.
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,

        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,

        full_name TEXT,
        age INTEGER,
        state TEXT,

        home_course TEXT,
        home_course_id TEXT,
        home_course_state TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login TIMESTAMPTZ
      );
    `);

    /*
     * Add missing columns safely for existing databases.
     */

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS full_name TEXT;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS age INTEGER;
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS state TEXT;
    `);

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

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at
      TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login
      TIMESTAMPTZ;
    `);

    console.log("✅ users table ready");

  } catch (err) {
    console.error(
      "❌ ensureUsersTable error:",
      err.message
    );
  }
}

ensureUsersTable();

/* =========================================================
   HELPERS
   ========================================================= */

function normaliseEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normaliseState(state) {
  return String(state || "")
    .trim()
    .toUpperCase();
}

const VALID_STATES = [
  "WA",
  "NSW",
  "VIC",
  "QLD",
  "SA",
  "TAS",
  "ACT",
  "NT",
];

/* =========================================================
   SIGNUP
   ========================================================= */

authRouter.post(
  "/signup",
  async (req, res) => {
    try {

      const {
        email,
        password,

        fullName,
        age,
        state,

        homeCourse,
        homeCourseId,
        homeCourseState,
      } = req.body || {};

      const normEmail =
        normaliseEmail(email);

      /*
       * Email/password validation
       */

      if (
        !normEmail ||
        !password ||
        String(password).length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Please enter a valid email and a password of at least 6 characters.",
        });
      }

      /*
       * Required profile information
       */

      const cleanFullName =
        String(fullName || "").trim();

      const cleanAge =
        Number(age);

      const cleanState =
        normaliseState(state);

      if (!cleanFullName) {
        return res.status(400).json({
          ok: false,
          error: "Full name is required",
        });
      }

      if (
        !Number.isInteger(cleanAge) ||
        cleanAge < 13 ||
        cleanAge > 120
      ) {
        return res.status(400).json({
          ok: false,
          error: "Valid age is required",
        });
      }

      if (
        !VALID_STATES.includes(cleanState)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Valid state is required",
        });
      }

      /*
       * Hash password
       */

      const passwordHash =
        await bcrypt.hash(
          String(password),
          10
        );

      /*
       * Create user
       */

      const result =
        await db.query(
          `
            INSERT INTO users (
              email,
              password_hash,

              full_name,
              age,
              state,

              home_course,
              home_course_id,
              home_course_state,

              last_login
            )

            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              NOW()
            )

            ON CONFLICT (email)
            DO NOTHING

            RETURNING
              id,
              email,

              full_name,
              age,
              state,

              home_course,
              home_course_id,
              home_course_state,

              created_at,
              last_login;
          `,
          [
            normEmail,
            passwordHash,

            cleanFullName,
            cleanAge,
            cleanState,

            homeCourse || null,
            homeCourseId || null,
            homeCourseState || null,
          ]
        );

      console.log(
        "🔐 signup: rows =",
        result.rowCount,
        "email =",
        normEmail
      );

      /*
       * Existing account
       */

      if (result.rowCount === 0) {
        return res.status(409).json({
          ok: false,
          error: "Email already registered",
        });
      }

      const row =
        result.rows[0];

      /*
       * Analytics
       */

      if (
        analyticsDb?.recordRegisteredUser
      ) {
        analyticsDb.recordRegisteredUser(
          normEmail
        );
      }

      /*
       * JWT
       */

      const token =
        signToken({
          id: row.id,
          email: row.email,
        });

      /*
       * Return user
       */

      return res.json({
        ok: true,

        token:
          token || undefined,

        user: {
          email:
            row.email,

          fullName:
            row.full_name || null,

          age:
            row.age ?? null,

          state:
            row.state || null,

          homeCourse:
            row.home_course || null,

          homeCourseId:
            row.home_course_id || null,

          homeCourseState:
            row.home_course_state || null,
        },
      });

    } catch (err) {
      console.error(
        "signup error:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Something went wrong. Please try again.",
      });
    }
  }
);

/* =========================================================
   LOGIN
   ========================================================= */

authRouter.post(
  "/login",
  async (req, res) => {
    try {

      const {
        email,
        password,
      } = req.body || {};

      const normEmail =
        normaliseEmail(email);

      if (
        !normEmail ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid email or password",
        });
      }

      /*
       * Get user
       */

      const result =
        await db.query(
          `
            SELECT
              id,
              email,
              password_hash,

              full_name,
              age,
              state,

              home_course,
              home_course_id,
              home_course_state,

              last_login

            FROM users

            WHERE email = $1
          `,
          [
            normEmail,
          ]
        );

      console.log(
        "🔐 login: rows =",
        result.rowCount,
        "email =",
        normEmail
      );

      if (
        result.rowCount === 0
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid email or password",
        });
      }

      const user =
        result.rows[0];

      /*
       * Check password
       */

      const isValid =
        await bcrypt.compare(
          String(password),
          user.password_hash
        );

      console.log(
        "🔐 login: password match?",
        isValid
      );

      if (!isValid) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid email or password",
        });
      }

      /*
       * Update last login
       */

      await db.query(
        `
          UPDATE users
          SET last_login = NOW()
          WHERE id = $1
        `,
        [
          user.id,
        ]
      );

      /*
       * Analytics
       */

      if (
        analyticsDb?.recordRegisteredUser
      ) {
        analyticsDb.recordRegisteredUser(
          normEmail
        );
      }

      /*
       * JWT
       */

      const token =
        signToken({
          id: user.id,
          email: user.email,
        });

      return res.json({
        ok: true,

        token:
          token || undefined,

        user: {
          email:
            user.email,

          fullName:
            user.full_name || null,

          age:
            user.age ?? null,

          state:
            user.state || null,

          homeCourse:
            user.home_course || null,

          homeCourseId:
            user.home_course_id || null,

          homeCourseState:
            user.home_course_state || null,
        },
      });

    } catch (err) {
      console.error(
        "login error:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Something went wrong. Please try again.",
      });
    }
  }
);

/* =========================================================
   RESET PASSWORD
   ========================================================= */

authRouter.post(
  "/reset",
  async (req, res) => {
    try {

      const {
        email,
        newPassword,
      } = req.body || {};

      const normEmail =
        normaliseEmail(email);

      if (
        !normEmail ||
        !newPassword ||
        String(newPassword).length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid email or password",
        });
      }

      const passwordHash =
        await bcrypt.hash(
          String(newPassword),
          10
        );

      const result =
        await db.query(
          `
            UPDATE users

            SET
              password_hash = $2,
              last_login = NOW()

            WHERE email = $1

            RETURNING
              id,
              email,

              full_name,
              age,
              state,

              home_course,
              home_course_id,
              home_course_state,

              last_login;
          `,
          [
            normEmail,
            passwordHash,
          ]
        );

      console.log(
        "🔐 reset: rows =",
        result.rowCount,
        "email =",
        normEmail
      );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "Account not found for this email",
        });
      }

      const user =
        result.rows[0];

      /*
       * Analytics
       */

      if (
        analyticsDb?.recordRegisteredUser
      ) {
        analyticsDb.recordRegisteredUser(
          normEmail
        );
      }

      /*
       * Refresh JWT
       */

      const token =
        signToken({
          id: user.id,
          email: user.email,
        });

      return res.json({
        ok: true,

        token:
          token || undefined,

        user: {
          email:
            user.email,

          fullName:
            user.full_name || null,

          age:
            user.age ?? null,

          state:
            user.state || null,

          homeCourse:
            user.home_course || null,

          homeCourseId:
            user.home_course_id || null,

          homeCourseState:
            user.home_course_state || null,
        },
      });

    } catch (err) {
      console.error(
        "reset error:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Something went wrong. Please try again.",
      });
    }
  }
);

/* =========================================================
   ME
   Fetch current logged-in user's information
   ========================================================= */

authRouter.get(
  "/me",
  async (req, res) => {
    try {

      let normEmail = "";

      /*
       * Prefer Bearer token
       */

      const auth =
        String(
          req.headers.authorization || ""
        );

      const match =
        auth.match(
          /^Bearer\s+(.+)$/i
        );

      const token =
        match
          ? match[1].trim()
          : "";

      if (
        token &&
        JWT_SECRET
      ) {
        try {
          const payload =
            jwt.verify(
              token,
              JWT_SECRET
            );

          normEmail =
            normaliseEmail(
              payload.email
            );

        } catch {
          /*
           * Ignore invalid token here so the
           * existing fallback identification
           * remains available.
           */
        }
      }

      /*
       * Existing fallback support
       */

      const headerEmail =
        req.headers["x-user-email"];

      const queryEmail =
        req.query.email;

      normEmail =
        normaliseEmail(
          normEmail ||
          headerEmail ||
          queryEmail
        );

      if (!normEmail) {
        return res.status(401).json({
          ok: false,
          error: "Missing email",
        });
      }

      /*
       * Get user
       */

      const result =
        await db.query(
          `
            SELECT
              email,

              full_name,
              age,
              state,

              home_course,
              home_course_id,
              home_course_state

            FROM users

            WHERE email = $1
          `,
          [
            normEmail,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          ok: false,
          error: "User not found",
        });
      }

      const row =
        result.rows[0];

      return res.json({
        ok: true,

        user: {
          email:
            row.email,

          fullName:
            row.full_name || null,

          age:
            row.age ?? null,

          state:
            row.state || null,

          homeCourse:
            row.home_course || null,

          homeCourseId:
            row.home_course_id || null,

          homeCourseState:
            row.home_course_state || null,
        },
      });

    } catch (err) {
      console.error(
        "me error:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Failed to load user",
      });
    }
  }
);

export default authRouter;
