// backend/auth.js
// Simple JSON-file auth so it works cleanly with CommonJS + Express

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const authRouter = express.Router();

// ===== SIMPLE LOCAL JSON "DB" =====
// File: backend/data/users.json (same folder as courses.json etc.)
const USERS_PATH = path.join(__dirname, "data", "users.json");

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_PATH)) return [];
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed loading users:", err);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("Failed saving users:", err);
  }
}

// ===== JWT CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || "TEERADAR_SUPER_SECRET_KEY";
const TOKEN_LIFETIME = "30d";

// Helper to issue tokens
function issueToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

// ========== ROUTES ==========

// POST /api/auth/signup
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, homeCourse } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const users = loadUsers();
    const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: "An account with that email already exists." });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id: Date.now().toString(),
      email,
      password: hashed,
      homeCourse: homeCourse || null
    };

    users.push(newUser);
    saveUsers(users);

    const token = issueToken(newUser);

    res.json({
      ok: true,
      token,
      user: {
        email: newUser.email,
        homeCourse: newUser.homeCourse
      }
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed." });
  }
});

// POST /api/auth/login
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const users = loadUsers();
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
      return res.status(400).json({ error: "Invalid login credentials." });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ error: "Invalid login credentials." });
    }

    const token = issueToken(user);

    res.json({
      ok: true,
      token,
      user: {
        email: user.email,
        homeCourse: user.homeCourse
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed." });
  }
});

// POST /api/auth/verify  (used on page load to restore session)
authRouter.post("/verify", (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });

    const payload = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users.find((u) => u.id === payload.id);

    if (!user) return res.json({ ok: false });

    res.json({
      ok: true,
      user: {
        email: user.email,
        homeCourse: user.homeCourse
      }
    });
  } catch (err) {
    console.error("Verify token error:", err.message);
    return res.json({ ok: false });
  }
});

// POST /api/auth/update-home  (optional: update home course)
authRouter.post("/update-home", (req, res) => {
  try {
    const { token, homeCourse } = req.body || {};
    if (!token) return res.status(401).json({ error: "Missing token." });

    const payload = jwt.verify(token, JWT_SECRET);

    const users = loadUsers();
    const idx = users.findIndex((u) => u.id === payload.id);
    if (idx === -1) return res.status(404).json({ error: "User not found." });

    users[idx].homeCourse = homeCourse || null;
    saveUsers(users);

    res.json({ ok: true });
  } catch (err) {
    console.error("Update home course error:", err.message);
    res.status(500).json({ error: "Failed to update home course." });
  }
});

// Export for server.js
module.exports = { authRouter };