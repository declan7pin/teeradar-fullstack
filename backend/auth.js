const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");

const authRouter = express.Router();

// ===== SIMPLE LOCAL JSON DATABASE =====
const DB_PATH = "./auth_users.json";

function loadUsers() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (err) {
    console.error("Failed loading users:", err);
    return [];
  }
}

function saveUsers(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ===== JWT CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY_12345";
const TOKEN_LIFETIME = "30d";

// ====== SIGNUP ======
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, homeCourse } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email & password required" });

    const users = loadUsers();
    const exists = users.find((u) => u.email === email);

    if (exists) return res.status(400).json({ error: "Account already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const newUser = {
      id: Date.now().toString(),
      email,
      password: hashed,
      homeCourse: homeCourse || null,
    };

    users.push(newUser);
    saveUsers(users);

    const token = jwt.sign({ id: newUser.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

    res.json({
      ok: true,
      token,
      user: {
        email: newUser.email,
        homeCourse: newUser.homeCourse,
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// ====== LOGIN ======
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = loadUsers();

    const user = users.find((u) => u.email === email);
    if (!user) return res.status(400).json({ error: "Invalid login" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid login" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });

    res.json({
      ok: true,
      token,
      user: {
        email: user.email,
        homeCourse: user.homeCourse,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// ====== VERIFY TOKEN ======
authRouter.post("/verify", (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ ok: false });

    const data = jwt.verify(token, JWT_SECRET);

    const users = loadUsers();
    const user = users.find((u) => u.id === data.id);

    if (!user) return res.json({ ok: false });

    res.json({
      ok: true,
      user: {
        email: user.email,
        homeCourse: user.homeCourse,
      },
    });
  } catch (err) {
    return res.json({ ok: false });
  }
});

// ====== UPDATE HOME COURSE ======
authRouter.post("/update-home", (req, res) => {
  try {
    const { token, homeCourse } = req.body;

    const data = jwt.verify(token, JWT_SECRET);

    let users = loadUsers();
    const user = users.find((u) => u.id === data.id);
    if (!user) return res.status(400).json({ error: "User not found" });

    user.homeCourse = homeCourse;
    saveUsers(users);

    res.json({ ok: true });
  } catch (err) {
    console.error("Update home course error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

module.exports = { authRouter };