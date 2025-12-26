// backend/analyticsRoutes.js
import express from "express";
import {
  logAnalyticsEvent,
  getAnalyticsSummary,
  getAllEvents,
  getRegisteredUsers,
  recordRegisteredUser,
  deleteRegisteredUser,
} from "./db/analyticsDb.js";

/* ✅ ONLY ADDITIONS NEEDED: also write + read Postgres analytics (backend/analytics.js) */
import {
  recordEvent as recordPgEvent,
  getAnalyticsSummary as getPgAnalyticsSummary,
} from "./analytics.js";
/* ✅ END ONLY ADDITIONS */

const router = express.Router();

/**
 * POST /api/analytics/event
 * Body: { type, at?, payload? }
 */
router.post("/event", async (req, res) => {
  try {
    const { type, at, payload } = req.body || {};

    if (!type) {
      return res.status(400).json({ error: "Missing event type" });
    }

    // ✅ FIX: support both { payload: {...} } and top-level fields (roundId, userId, courseName, etc)
    // This prevents "round_played" being logged without roundId (which keeps roundsPlayed at 0).
    const mergedPayload = {
      ...(payload && typeof payload === "object" ? payload : {}),
      ...(req.body && typeof req.body === "object" ? req.body : {}),
    };
    // Avoid nesting payload inside itself
    delete mergedPayload.payload;
    delete mergedPayload.type;
    delete mergedPayload.at;

    // existing (SQLite) analytics
    logAnalyticsEvent({ type, at, payload: mergedPayload });

    // ✅ ALSO store to Postgres analytics (so rounds + everything are in one place)
    try {
      const userId =
        mergedPayload?.userId ??
        mergedPayload?.user_id ??
        mergedPayload?.uid ??
        null;

      const courseName =
        mergedPayload?.courseName ??
        mergedPayload?.course_name ??
        mergedPayload?.course ??
        null;

      const roundId =
        mergedPayload?.roundId ??
        mergedPayload?.round_id ??
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
    return res.status(500).json({ error: "Failed to log analytics event" });
  }
});

// shared handler for summary so we can serve both "/" and "/summary"
async function handleSummary(req, res) {
  try {
    /* ✅ ONLY CHANGE NEEDED: prefer Postgres summary (includes rounds played + top played courses) */
    let s = null;

    try {
      s = await getPgAnalyticsSummary();
    } catch (e) {
      console.warn("Falling back to analyticsDb summary:", e?.message || e);
      s = getAnalyticsSummary(); // legacy fallback
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

      // ✅ NEW: most played courses (what you asked for)
      topPlayedCourses: s.topPlayedCourses ?? [],
      topPlayedCourses30d: s.topPlayedCourses30d ?? [],
    };
    /* ✅ END ONLY CHANGE */

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
    const events = getAllEvents(limit);
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
    recordRegisteredUser(email);
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
    const users = getRegisteredUsers(limit);
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
    deleteRegisteredUser(id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting registered user", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;