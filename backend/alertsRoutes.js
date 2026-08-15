// backend/alertsRoutes.js
import express from "express";
import db from "./db.js";

const router = express.Router();

// ---------------------------------------------------------
// Subscriber entitlement helpers
// ---------------------------------------------------------
function isTruthyPlan(plan) {
  const p = String(plan || "").trim().toUpperCase();
  return p === "BASIC" || p === "PRO";
}

function isEntitledSubscriberRow(subRow) {
  if (!subRow) return false;

  const entitlementActive = !!subRow.entitlement_active;
  if (!entitlementActive) return false;

  const status = String(subRow.status || "").trim().toLowerCase();
  if (status !== "active" && status !== "trialing") return false;

  if (!subRow.current_period_end) return false;

  const endMs = new Date(subRow.current_period_end).getTime();
  if (!Number.isFinite(endMs)) return false;

  return endMs > Date.now();
}

function getEffectiveSubscriberPlan(subRow) {
  if (!isEntitledSubscriberRow(subRow)) return "FREE";

  const p = String(subRow.plan || "").trim().toUpperCase();
  return isTruthyPlan(p) ? p : "FREE";
}

async function getSubscriberStatusRow(email) {
  const result = await db.query(
    `
    SELECT
      email,
      plan,
      status,
      entitlement_active,
      current_period_end,
      cancel_at_period_end
    FROM subscriber_status
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
    `,
    [email]
  );

  return result.rows?.[0] || null;
}

async function requireSubscriberAlertsAccess(email) {
  /*
   * TEMPORARY FREE ACCESS MODE:
   *
   * Every registered TeeRadar account receives
   * full PRO alert access.
   *
   * Real Stripe / Apple subscription records
   * remain unchanged.
   */

  const userResult = await db.query(
    `
    SELECT id, email
    FROM users
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
    `,
    [email]
  );

  const user = userResult.rows?.[0] || null;

  return {
    entitled: !!user,
    plan: user ? "PRO" : "FREE",
    subscription: null,
  };
}

// ---------------------------------------------------------
// Ensure tables exist
// ---------------------------------------------------------
async function ensureUserAlertHitsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_hits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT NOT NULL,
        provider TEXT,
        date TEXT NOT NULL,              -- 'YYYY-MM-DD'
        holes INTEGER,
        party_size INTEGER,
        earliest TEXT,
        latest TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);
    console.log("✅ user_alert_hits table ready (alertsRoutes)");
  } catch (err) {
    console.error("❌ error ensuring user_alert_hits table (alertsRoutes):", err);
  }
}

// ✅ NEW: table used by analytics.js for "ALERTS SENT (7D)"
async function ensureAlertEmailsSentTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS alert_emails_sent (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        hit_count INTEGER DEFAULT 0,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("✅ alert_emails_sent table ready (alertsRoutes)");
  } catch (err) {
    console.error("❌ error ensuring alert_emails_sent table (alertsRoutes):", err);
  }
}

ensureUserAlertHitsTable();
ensureAlertEmailsSentTable();

// ---------------------------------------------------------
// ✅ NEW: GET preferences so account.html can re-hydrate fields
// GET /api/account/preferences?email=...
// (Also available as /api/preferences?email=... depending on mount path)
// ---------------------------------------------------------
async function getUserPreferencesRow(email) {
  const result = await db.query(
    `
    SELECT *
    FROM user_preferences
    WHERE email = $1
    LIMIT 1;
    `,
    [email]
  );
  return result.rows?.[0] || null;
}

// Primary path (matches your frontend fetch: /api/account/preferences)
router.get("/account/preferences", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const access = await requireSubscriberAlertsAccess(email);
    if (!access.entitled) {
      return res.status(403).json({
        ok: false,
        error: "subscriber_required",
        plan: "FREE",
        message: "An active subscription is required to access email alerts.",
      });
    }

    const prefs = await getUserPreferencesRow(email);
    if (!prefs) {
      return res.json({
        ok: true,
        found: false,
        plan: access.plan,
        preferences: null,
      });
    }

    return res.json({
      ok: true,
      found: true,
      plan: access.plan,
      preferences: prefs,
    });
  } catch (err) {
    console.error("account/preferences GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Alias path (useful if you decide to call /api/preferences from frontend)
router.get("/preferences", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const access = await requireSubscriberAlertsAccess(email);
    if (!access.entitled) {
      return res.status(403).json({
        ok: false,
        error: "subscriber_required",
        plan: "FREE",
        message: "An active subscription is required to access email alerts.",
      });
    }

    const prefs = await getUserPreferencesRow(email);
    if (!prefs) {
      return res.json({
        ok: true,
        found: false,
        plan: access.plan,
        preferences: null,
      });
    }

    return res.json({
      ok: true,
      found: true,
      plan: access.plan,
      preferences: prefs,
    });
  } catch (err) {
    console.error("preferences GET error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ---------------------------------------------------------
// Helper: build a Set of favourite course names for a user
// ---------------------------------------------------------
async function getFavouriteCourseNameSet(email) {
  try {
    const prefRes = await db.query(
      `
      SELECT favourites
      FROM user_preferences
      WHERE email = $1
      LIMIT 1;
      `,
      [email]
    );

    const favRaw = prefRes.rows?.[0]?.favourites;

    // favourites might be JSONB array OR (older) a stringified JSON
    let favs = favRaw;

    if (typeof favRaw === "string") {
      try {
        favs = JSON.parse(favRaw);
      } catch {
        favs = [];
      }
    }

    if (!Array.isArray(favs)) return new Set();

    const set = new Set();
    for (const f of favs) {
      const name =
        f && (f.name || f.courseName || f.course)
          ? String(f.name || f.courseName || f.course)
          : "";
      const trimmed = name.trim();
      if (trimmed) set.add(trimmed);
    }

    return set;
  } catch (e) {
    return new Set();
  }
}

// ---------------------------------------------------------
// GET /api/alerts/unread?email=...
// Returns unread alert hits (read_at IS NULL) for that user
// FILTERED to only current favourites
// ---------------------------------------------------------
router.get("/unread", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const access = await requireSubscriberAlertsAccess(email);
    if (!access.entitled) {
      return res.status(403).json({
        ok: false,
        error: "subscriber_required",
        plan: "FREE",
        hits: [],
        message: "An active subscription is required to access email alerts.",
      });
    }

    // Get current favourites for this user (prevents old hits showing)
    const favNameSet = await getFavouriteCourseNameSet(email);

    // Return most recent unread hits first (cap to keep payload small)
    const { rows } = await db.query(
      `
      SELECT
        id,
        email,
        course_name,
        provider,
        date,
        holes,
        party_size,
        earliest,
        latest,
        slots,
        created_at
      FROM user_alert_hits
      WHERE LOWER(email) = LOWER($1)
        AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT 200;
      `,
      [email]
    );

    // Filter to favourites only (if favourites exist)
    const filteredRows =
      favNameSet.size > 0
        ? rows.filter((r) => favNameSet.has(String(r.course_name || "").trim()))
        : rows;

    const hits = filteredRows.slice(0, 100).map((r) => ({
      id: r.id,
      email: r.email,
      course_name: r.course_name,
      provider: r.provider,
      date: r.date,
      holes: r.holes,
      party_size: r.party_size,
      earliest: r.earliest,
      latest: r.latest,
      slots: r.slots || [],
      created_at: r.created_at,
    }));

    res.json({
      ok: true,
      plan: access.plan,
      hits,
    });
  } catch (err) {
    console.error("alerts/unread error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ---------------------------------------------------------
// POST /api/alerts/mark-read
// Body: { email, ids: [1,2,3] }
// Marks those hits as read (sets read_at=now())
// ---------------------------------------------------------
router.post("/mark-read", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim().toLowerCase();
    const idsRaw = req.body?.ids;

    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const access = await requireSubscriberAlertsAccess(email);
    if (!access.entitled) {
      return res.status(403).json({
        ok: false,
        error: "subscriber_required",
        plan: "FREE",
        updated: 0,
        message: "An active subscription is required to access email alerts.",
      });
    }

    const ids = Array.isArray(idsRaw)
      ? idsRaw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    if (!ids.length) {
      return res.json({ ok: true, plan: access.plan, updated: 0 });
    }

    const result = await db.query(
      `
      UPDATE user_alert_hits
      SET read_at = now()
      WHERE LOWER(email) = LOWER($1)
        AND id = ANY($2::int[])
      `,
      [email, ids]
    );

    res.json({
      ok: true,
      plan: access.plan,
      updated: result.rowCount || 0,
    });
  } catch (err) {
    console.error("alerts/mark-read error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;
