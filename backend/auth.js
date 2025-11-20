// auth.js
// Simple email/password auth with hashed passwords (bcrypt) and JWT.
// Users are stored in a small JSON file on disk so we NEVER save raw passwords.

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const express = require("express");

const router = express.Router();

// Where we'll keep users on disk (email + passwordHash + optional homeCourse)
const USERS_FILE = path.join(__dirname, "data", "users.json");
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = "7d";

// Ensure data directory exists
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load & save helpers
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load users file:", e);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save users file:", e);
  }
}

// Generate JWT
function createToken(user) {
  const payload = { sub: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Middleware to read token from Authorization header
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid auth token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { sub, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---- Routes ----

// Register (sign-up)
router.post("/register", async (req, res) => {
  const { email, password, homeCourse } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const normalisedEmail = String(email).trim().toLowerCase();
  const users = loadUsers();

  if (users.some((u) => u.email === normalisedEmail)) {
    return res.status(409).json({ error: "Email already registered" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: `u_${Date.now()}`,
      email: normalisedEmail,
      passwordHash,
      homeCourse: homeCourse || null,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    const token = createToken(newUser);

    res.json({
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        homeCourse: newUser.homeCourse
      }
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const normalisedEmail = String(email).trim().toLowerCase();
  const users = loadUsers();
  const user = users.find((u) => u.email === normalisedEmail);

  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  try {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = createToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        homeCourse: user.homeCourse || null
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

// Get current user (from token)
router.get("/me", authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users.find((u) => u.id === req.user.sub);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    id: user.id,
    email: user.email,
    homeCourse: user.homeCourse || null
  });
});

// Update profile (home course, later things like subscription)
router.post("/me", authMiddleware, (req, res) => {
  const { homeCourse } = req.body || {};
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === req.user.sub);

  if (idx === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  if (typeof homeCourse === "string") {
    users[idx].homeCourse = homeCourse.trim() || null;
  }

  saveUsers(users);

  res.json({
    id: users[idx].id,
    email: users[idx].email,
    homeCourse: users[idx].homeCourse || null
  });
});

module.exports = {
  authRouter: router,
  authMiddleware
};