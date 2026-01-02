// backend/analyticsRoutes.js
import express from "express";

/**
 * ✅ FIX:
 * analyticsDb.js in your repo does NOT export `deleteRegisteredUser`.
 * Named ESM imports must exist or Node will crash on boot.
 *
 * So we import the module as a namespace and safely access functions.
 */
import * as analyticsDb from "./db/analyticsDb.js";

/* ✅ ALSO write + read Postgres analytics (backend/analytics.js) */
import {
  recordEvent as recordPgEvent,
  getAnalyticsSummary as getPgAnalyticsSummary,
} from "./analytics.js";
/* ✅ END ONLY ADDITIONS */

const router = express.Router();

// pull the functions that DO exist (no hard failure)
const logAnalyticsEvent = analyticsDb.logAnalyticsEvent;
const getAnalyticsSummary = analyticsDb.getAnalyticsSummary;
const getAllEvents = analyticsDb.getAllEvents;
const getRegisteredUsers = analyticsDb.getRegisteredUsers;
const recordRegisteredUser = analyticsDb.recordRegisteredUser;

// ✅ Try common delete export names (so it works across versions)
const deleteRegisteredUser =
  analyticsDb.deleteRegisteredUser ||
  analyticsDb.deleteRegisteredUserById ||
  analyticsDb.deleteUser ||
  analyticsDb.deleteUserById ||
  analyticsDb.removeRegisteredUser ||
  null;

/**
 * IMPORTANT:
 * Some pages send analytics fields at the top level:
 * { type, at, userId, courseName, roundId }
 * Others send:
 * { type, at, payload: { userId, courseName, roundId } }
 *
 * We merge both into a single payload so NOTHING breaks.
 */

/**
 * POST /api/analytics/event
 * Body: { type, at?, payload? } OR { type, at?, userId?, courseName?, roundId?, ... }
 */
router.post("/event", async (req, res) => {
  try {
    const body = req.body || {};
    const { type } = body;

    if (!type) {
      return res.status(400).json({ error: "Missing event type" });
    }

    const at = body.at || new Date().toISOString();

    // ✅ Merge top-level fields into payload (keep backwards compatibility)
    const incomingPayload =
      body.payload && typeof body.payload === "object" ? body.payload : {};

    const mergedPayload = {
      ...incomingPayload,
      ...body, // allows userId/courseName/roundId sent top-level
    };

    // remove non-payload keys so payload stays clean
    delete mergedPayload.type;
    delete mergedPayload.at;
    delete mergedPayload.payload;

    // ✅ Put the Render log back (so you can see events arriving)
    console.log("\nIncoming analytics event:", {
      type,
      at,
      ...mergedPayload,
    });

    // existing (SQLite) analytics (your old cards / views depend on this)
    if (typeof logAnalyticsEvent === "function") {
      logAnalyticsEvent({ type, at, payload: mergedPayload });
    }

    // ✅ ALSO store to Postgres analytics (so rounds + everything are in one place)
    try {
      const userId =
        mergedPayload.userId ??
        mergedPayload.user_id ??
        mergedPayload.uid ??
        null;

      const courseName =
        mergedPayload.courseName ??
        mergedPayload.course_name ??
        mergedPayload.course ??
        null;

      const roundId =
        mergedPayload.roundId ??
        mergedPayload.round_id ??
        null;

      await recordPgEvent({
        type,
        userId,
        courseName,
        at,
        roundId,
      });
    } catch (e) {
      console.warn("Postgres analytics insert failed (non-fatal):", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error logging analytics event", err);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

// shared handler for summary so we can serve both "/" and "/summary"
async function handleSummary(req, res) {
  try {
    // ✅ prefer Postgres summary (includes rounds played + top played courses)
    let s = null;

    try {
      s = await getPgAnalyticsSummary();
    } catch (e) {
      console.warn("Falling back to analyticsDb summary:", e?.message || e);
      s = typeof getAnalyticsSummary === "function" ? getAnalyticsSummary() : {};
    }

    const response = {
      // backwards-compatible fields you already use
      homePageViews: s.homePageViews ?? s.home_page_views ?? s.homeViews ?? 0,
      courseBookingClicks:
        s.courseBookingClicks ?? s.booking_clicks ?? s.bookingClicks ?? 0,
      searches: s.searches ?? 0,
      newUsers: s.newUsers ?? s.new_users ?? 0,
      homeViews: s.homeViews ?? s.home_page_views ?? 0,
      bookingClicks: s.bookingClicks ?? s.booking_clicks ?? 0,
      usersAllTime: s.usersAllTime ?? s.unique_users ?? 0,
      usersToday: s.usersToday ?? s.users_today ?? 0,
      usersWeek: s.usersWeek ?? s.users_week ?? 0,

      // extra fields for new cards/metrics
      users30d: s.users30d ?? 0,
      returningUsers7d: s.returningUsers7d ?? s.returning_users_7d ?? 0,
      repeatBookers: s.repeatBookers ?? s.repeat_bookers ?? 0,
      peakBookingHour: s.peakBookingHour ?? s.peak_booking_hour ?? null,

      topCourses: s.topCourses ?? s.top_courses ?? [],
      topSearchedCourses: s.topSearchedCourses ?? s.top_searched_courses ?? [],
      demandRank: s.demandRank ?? s.demand_rank ?? [],

      // ✅ NEW: rounds played analytics
      roundsPlayed: s.roundsPlayed ?? s.rounds_played ?? s.rounds ?? 0,
      roundsPlayed7d: s.roundsPlayed7d ?? s.rounds_played_7d ?? 0,

      // ✅ NEW: most played courses
      topPlayedCourses: s.topPlayedCourses ?? [],
      topPlayedCourses30d: s.topPlayedCourses30d ?? [],
    };

    return res.json(response);
  } catch (err) {
    console.error("Error building analytics summary", err);
    return res.status(500).json({ error: "Failed to load analytics summary" });
  }
}

/**
 * GET /api/analytics
 * Main endpoint used by analytics.html
 */
router.get("/", handleSummary);

/**
 * GET /api/analytics/summary
 * Backwards-compatible alias
 */
router.get("/summary", handleSummary);

/**
 * GET /api/analytics/events
 * For debugging – recent raw events.
 */
router.get("/events", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;
    const events = typeof getAllEvents === "function" ? getAllEvents(limit) : [];
    return res.json({ events });
  } catch (err) {
    console.error("Error fetching analytics events", err);
    return res.status(500).json({ error: "Failed to fetch events" });
  }
});

/**
 * PUT /api/analytics/register-user
 * Call this from your auth flow when someone signs up / logs in.
 * Body: { email }
 */
router.put("/register-user", (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }
    if (typeof recordRegisteredUser === "function") {
      recordRegisteredUser(email);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error recording registered user", err);
    return res.status(500).json({ error: "Failed to record user" });
  }
});

/**
 * GET /api/analytics/users
 * Used by the admin dashboard table (analytics.html).
 */
router.get("/users", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 500;
    const users = typeof getRegisteredUsers === "function" ? getRegisteredUsers(limit) : [];
    return res.json({ users });
  } catch (err) {
    console.error("Error fetching registered users", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

/**
 * DELETE /api/analytics/users/:id
 * Used by the "Delete" button in the admin UI.
 */
router.delete("/users/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid id" });
    }

    if (typeof deleteRegisteredUser !== "function") {
      // Don’t crash the server — return a clear error
      return res.status(501).json({
        error: "delete_not_supported",
        message:
          "Your analyticsDb.js does not export a delete user function. Add one (e.g. deleteRegisteredUser) or rename the export.",
        availableExports: Object.keys(analyticsDb || {}).sort(),
      });
    }

    deleteRegisteredUser(id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting registered user", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;