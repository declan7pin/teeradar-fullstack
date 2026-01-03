// backend/analyticsRoutes.js
import express from "express";

/**
 * ✅ FIX:
 * analyticsDb.js in your repo may not export all named functions consistently.
 * Use namespace import so missing exports never crash boot.
 */
import * as analyticsDb from "./db/analyticsDb.js";

/**
 * ✅ Postgres (source of truth)
 */
import db from "./db.js";

/**
 * ✅ ALSO write Postgres analytics (backend/analytics.js) if present
 * Use namespace import so missing exports never crash boot.
 */
import * as pgAnalytics from "./analytics.js";

const router = express.Router();

// pull the functions that DO exist (no hard failure)
const logAnalyticsEvent = analyticsDb.logAnalyticsEvent;
const getAnalyticsSummarySqlite = analyticsDb.getAnalyticsSummary;
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
      ...body,
    };

    delete mergedPayload.type;
    delete mergedPayload.at;
    delete mergedPayload.payload;

    console.log("\nIncoming analytics event:", { type, at, ...mergedPayload });

    // legacy SQLite (non-blocking)
    try {
      if (typeof logAnalyticsEvent === "function") {
        const r = logAnalyticsEvent({ type, at, payload: mergedPayload });
        if (r && typeof r.then === "function") await r;
      }
    } catch (e) {
      console.warn("SQLite analytics insert failed (non-fatal):", e?.message || e);
    }

    // ✅ Postgres insert (preferred)
    try {
      const recordPgEvent = pgAnalytics.recordEvent || pgAnalytics.recordPgEvent || null;

      if (typeof recordPgEvent === "function") {
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
          at,
          occurredAt: at,
          occurred_at: at,
          userId,
          user_id: userId,
          courseName,
          course_name: courseName,
          roundId,
          round_id: roundId,
        });
      }
    } catch (e) {
      console.warn("Postgres analytics insert failed (non-fatal):", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error logging analytics event", err);
    return res.status(500).json({ error: "Failed to log event" });
  }
});

/**
 * ✅ Build summary directly from Postgres analytics table
 */
async function buildPgSummary() {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  // totals by type (all-time)
  const totals = await q(
    `
    SELECT type, COUNT(*)::int AS n
    FROM analytics
    GROUP BY type
    `
  );
  const byType = Object.fromEntries(totals.map((r) => [r.type, Number(r.n) || 0]));

  const homeViews = byType.home_view || 0;
  const bookingClicks = byType.course_booking_click || 0;

  /**
   * ✅ IMPORTANT FIX:
   * - "search" = real user pressing Search (what you want on the Searches card)
   * - "search_course" = background scanning / course checks (alerts worker)
   */
  const searches = byType.search || 0; // ✅ USER searches only
  const alertSearches = byType.search_course || 0; // ✅ background scans

  const newUsers = byType.new_user || 0;

  // uniques
  const usersAllTime = await q(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE user_id IS NOT NULL AND user_id <> '';`
  );
  const usersToday = await q(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE user_id IS NOT NULL AND user_id <> ''
       AND occurred_at >= date_trunc('day', now());`
  );
  const usersWeek = await q(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE user_id IS NOT NULL AND user_id <> ''
       AND occurred_at >= now() - interval '7 days';`
  );
  const users30d = await q(
    `SELECT COUNT(DISTINCT user_id)::int AS n
     FROM analytics
     WHERE user_id IS NOT NULL AND user_id <> ''
       AND occurred_at >= now() - interval '30 days';`
  );

  // returning users in last 7d (users with 2+ events in last 7d)
  const returningUsers7d = await q(
    `SELECT COUNT(*)::int AS n FROM (
        SELECT user_id
        FROM analytics
        WHERE user_id IS NOT NULL AND user_id <> ''
          AND occurred_at >= now() - interval '7 days'
        GROUP BY user_id
        HAVING COUNT(*) >= 2
     ) t;`
  );

  // repeat bookers (users with 2+ booking clicks all-time)
  const repeatBookers = await q(
    `SELECT COUNT(*)::int AS n FROM (
        SELECT user_id
        FROM analytics
        WHERE type = 'course_booking_click'
          AND user_id IS NOT NULL AND user_id <> ''
        GROUP BY user_id
        HAVING COUNT(*) >= 2
     ) t;`
  );

  // peak booking hour
  const peakBookingHour = await q(
    `SELECT EXTRACT(HOUR FROM occurred_at)::int AS hr, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'course_booking_click'
     GROUP BY hr
     ORDER BY n DESC
     LIMIT 1;`
  );

  // top booked courses (all-time)
  const topCourses = await q(
    `SELECT course_name AS course, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'course_booking_click'
       AND course_name IS NOT NULL AND course_name <> ''
     GROUP BY course_name
     ORDER BY n DESC
     LIMIT 10;`
  );

  // top scanned courses (all-time) - this is still your search_course bucket
  const topSearchedCourses = await q(
    `SELECT course_name AS course, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'search_course'
       AND course_name IS NOT NULL AND course_name <> ''
     GROUP BY course_name
     ORDER BY n DESC
     LIMIT 10;`
  );

  // rounds played
  const roundsPlayed = byType.round_played || 0;
  const roundsPlayed7dRows = await q(
    `SELECT COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'round_played'
       AND occurred_at >= now() - interval '7 days';`
  );

  // most played courses
  const topPlayedCourses = await q(
    `SELECT course_name AS course, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'round_played'
       AND course_name IS NOT NULL AND course_name <> ''
     GROUP BY course_name
     ORDER BY n DESC
     LIMIT 10;`
  );

  const topPlayedCourses30d = await q(
    `SELECT course_name AS course, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'round_played'
       AND course_name IS NOT NULL AND course_name <> ''
       AND occurred_at >= now() - interval '30 days'
     GROUP BY course_name
     ORDER BY n DESC
     LIMIT 10;`
  );

  // ✅ Alerts (7d) — based on analytics event types
  const alertsSent7dRows = await q(
    `SELECT COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'alert_sent'
       AND occurred_at >= now() - interval '7 days';`
  );
  const alertHits7dRows = await q(
    `SELECT COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'alert_hit'
       AND occurred_at >= now() - interval '7 days';`
  );
  const topAlertCourses7d = await q(
    `SELECT course_name AS course, COUNT(*)::int AS n
     FROM analytics
     WHERE type = 'alert_hit'
       AND occurred_at >= now() - interval '7 days'
       AND course_name IS NOT NULL AND course_name <> ''
     GROUP BY course_name
     ORDER BY n DESC
     LIMIT 10;`
  );

  const alertsSent7d = alertsSent7dRows[0]?.n ?? 0;
  const alertHits7d = alertHits7dRows[0]?.n ?? 0;

  return {
    homePageViews: homeViews,
    courseBookingClicks: bookingClicks,

    // ✅ clean user number
    searches,

    // ✅ background scans count
    alertSearches,

    newUsers,

    homeViews,
    bookingClicks,

    usersAllTime: usersAllTime[0]?.n ?? 0,
    usersToday: usersToday[0]?.n ?? 0,
    usersWeek: usersWeek[0]?.n ?? 0,
    users30d: users30d[0]?.n ?? 0,
    returningUsers7d: returningUsers7d[0]?.n ?? 0,
    repeatBookers: repeatBookers[0]?.n ?? 0,
    peakBookingHour: peakBookingHour[0]?.hr ?? null,

    topCourses: topCourses.map((r) => ({ course: r.course, n: r.n })),
    topSearchedCourses: topSearchedCourses.map((r) => ({ course: r.course, n: r.n })),

    demandRank: [],

    roundsPlayed,
    roundsPlayed7d: roundsPlayed7dRows[0]?.n ?? 0,
    topPlayedCourses: topPlayedCourses.map((r) => ({ course: r.course, n: r.n })),
    topPlayedCourses30d: topPlayedCourses30d.map((r) => ({ course: r.course, n: r.n })),

    // ✅ Alerts summary fields analytics.html expects
    alertsSent7d,
    alertHits7d,
    avgTimeToHitMins: null,
    alertsByPlan: null,
    topAlertCourses: topAlertCourses7d.map((r) => ({ course: r.course, hits: r.n })),
  };
}

// shared handler for summary so we can serve both "/" and "/summary"
async function handleSummary(req, res) {
  try {
    const pg = await buildPgSummary();
    return res.json(pg);
  } catch (e) {
    console.warn("Postgres summary failed, falling back to analyticsDb:", e?.message || e);

    try {
      const s = typeof getAnalyticsSummarySqlite === "function" ? getAnalyticsSummarySqlite() : {};

      return res.json({
        homePageViews: s.homePageViews ?? s.home_page_views ?? s.homeViews ?? 0,
        courseBookingClicks: s.courseBookingClicks ?? s.booking_clicks ?? s.bookingClicks ?? 0,
        searches: s.searches ?? 0,
        alertSearches: 0,
        newUsers: s.newUsers ?? s.new_users ?? 0,
        homeViews: s.homeViews ?? s.home_page_views ?? 0,
        bookingClicks: s.bookingClicks ?? s.booking_clicks ?? 0,
        usersAllTime: s.usersAllTime ?? s.unique_users ?? 0,
        usersToday: s.usersToday ?? s.users_today ?? 0,
        usersWeek: s.usersWeek ?? s.users_week ?? 0,
        users30d: s.users30d ?? 0,
        returningUsers7d: s.returningUsers7d ?? s.returning_users_7d ?? 0,
        repeatBookers: s.repeatBookers ?? s.repeat_bookers ?? 0,
        peakBookingHour: s.peakBookingHour ?? s.peak_booking_hour ?? null,
        topCourses: s.topCourses ?? s.top_courses ?? [],
        topSearchedCourses: s.topSearchedCourses ?? s.top_searched_courses ?? [],
        demandRank: s.demandRank ?? s.demand_rank ?? [],
        roundsPlayed: s.roundsPlayed ?? s.rounds_played ?? s.rounds ?? 0,
        roundsPlayed7d: s.roundsPlayed7d ?? s.rounds_played_7d ?? 0,
        topPlayedCourses: s.topPlayedCourses ?? [],
        topPlayedCourses30d: s.topPlayedCourses30d ?? [],

        // Alerts not supported in sqlite summary here
        alertsSent7d: 0,
        alertHits7d: 0,
        avgTimeToHitMins: null,
        alertsByPlan: null,
        topAlertCourses: [],
      });
    } catch (err) {
      console.error("Error building analytics summary", err);
      return res.status(500).json({ error: "Failed to load analytics summary" });
    }
  }
}

/**
 * GET /api/analytics
 */
router.get("/", handleSummary);

/**
 * GET /api/analytics/summary
 */
router.get("/summary", handleSummary);

/**
 * GET /api/analytics/events
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
 */
router.delete("/users/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid id" });
    }

    if (typeof deleteRegisteredUser !== "function") {
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