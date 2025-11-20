// =========================
//  TeeRadar Full Server.js
// =========================

const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();

// Use Render's port or default to 3001 locally
const PORT = process.env.PORT || 3001;

// -------------------------
//  Basic middleware
// -------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// -------------------------
//  AUTH ROUTES
//  (backend/auth.js)
// -------------------------
try {
  const authModule = require("./auth");

  // Support different export styles:
  //   module.exports = router
  //   module.exports = { authRouter: router }
  //   module.exports = { router }
  let authRouter = authModule;

  if (authModule && authModule.authRouter) {
    authRouter = authModule.authRouter;
  } else if (authModule && authModule.router) {
    authRouter = authModule.router;
  }

  if (authRouter && typeof authRouter === "function") {
    app.use("/api/auth", authRouter);
    console.log("[server] Auth routes mounted at /api/auth");
  } else {
    console.warn("[server] Auth module loaded but no router exported.");
  }
} catch (err) {
  console.warn("[server] Auth module not loaded (./backend/auth.js)", err.message);
}

// -------------------------
//  ANALYTICS ROUTES
//  (backend/analytics.js)
// -------------------------
try {
  const analyticsModule = require("./analytics");

  // Again, be flexible with how analytics.js exports things
  let analyticsRouter = null;

  if (typeof analyticsModule === "function") {
    // e.g. module.exports = (app) => { ... }
    analyticsModule(app);
    console.log("[server] Analytics module initialized via function export");
  } else {
    if (analyticsModule && analyticsModule.analyticsRouter) {
      analyticsRouter = analyticsModule.analyticsRouter;
    } else if (analyticsModule && analyticsModule.router) {
      analyticsRouter = analyticsModule.router;
    } else if (analyticsModule && typeof analyticsModule.use === "function") {
      // Direct router export: module.exports = router
      analyticsRouter = analyticsModule;
    }

    if (analyticsRouter) {
      app.use("/api/analytics", analyticsRouter);
      console.log("[server] Analytics routes mounted at /api/analytics");
    } else {
      console.warn("[server] Analytics module loaded but no router exported.");
    }
  }
} catch (err) {
  console.warn("[server] Analytics module not loaded (./backend/analytics.js)", err.message);
}

// --------------------------------------------------
//  STATIC FRONTEND – DO NOT TOUCH BOOKING / MAP UI
// --------------------------------------------------
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Explicit HTML routes (optional but friendly)
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/about", (_req, res) => {
  res.sendFile(path.join(publicDir, "about.html"));
});

app.get("/faq", (_req, res) => {
  res.sendFile(path.join(publicDir, "faq.html"));
});

app.get("/analytics", (_req, res) => {
  res.sendFile(path.join(publicDir, "analytics.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/book", (_req, res) => {
  res.sendFile(path.join(publicDir, "book.html"));
});

// Any other route → hand to SPA frontend (keeps deep links working)
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// -------------------------
//  START SERVER
// -------------------------
app.listen(PORT, () => {
  console.log(`TeeRadar server running on port ${PORT}`);
});