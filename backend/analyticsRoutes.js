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
import Stripe from "stripe";

const router = express.Router();

// ✅ Stripe (for plan healing in /api/analytics/users)
const stripeKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
const stripe = stripeKey ? new Stripe(stripeKey) : null;

// ✅ priceId → plan
const PRICE_TO_PLAN = {
  "price_1SdnQTASm4geYL4WeBGAEEkA": "BASIC",
  "price_1SdnRLASm4geYL4W23IKreHO": "BASIC",
  "price_1SdnSGASm4geYL4WBWsFWUNe": "PRO",
  "price_1SdnSpASm4geYL4W1yxaZf2i": "PRO",
};
function normalizePlan(plan) {
  const p = String(plan || "").trim().toUpperCase();
  if (p === "PRO") return "PRO";
  if (p === "BASIC") return "BASIC";
  return "FREE";
}

function titlePlan(plan) {
  const p = normalizePlan(plan);
  if (p === "PRO") return "Pro";
  if (p === "BASIC") return "Basic";
  return "Free";
}

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

  plan:
    mergedPayload.plan ??
    mergedPayload.subscriptionPlan ??
    mergedPayload.subscription_plan ??
    null,

  meta: {
    ...(mergedPayload.meta || {}),

    provider:
      mergedPayload.provider ??
      mergedPayload.meta?.provider ??
      null,
  },
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
async function buildPgSummary(filters = {}) {
  const providerRaw = String(filters.provider || "").trim().toLowerCase();
  const from = String(filters.from || "").trim();
  const to = String(filters.to || "").trim();

  const params = [];
  const where = [];

  const providerAliases = {
    miclub: ["miclub"],
    quick18: ["quick18"],
    phone: ["phone", "phonebooking"],
    teeradar: ["teeradarbooking", "teeradar", "teeradarbooking"],
  };

  if (providerRaw) {
    const aliases = providerAliases[providerRaw] || [providerRaw];

    params.push(aliases);
    where.push(`
      LOWER(
        regexp_replace(
          COALESCE(
            meta->>'provider',
            meta->>'courseProvider',
            meta->>'course_provider',
            ''
          ),
          '\\s+',
          '',
          'g'
        )
      ) = ANY($${params.length}::text[])
    `);
  }

  if (from) {
    params.push(from);
    where.push(`occurred_at >= $${params.length}::date`);
  }

  if (to) {
    params.push(to);
    where.push(`occurred_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const q = async (sql, extraParams = params) => {
    const r = await db.query(sql, extraParams);
    return r.rows || [];
  };

  const totals = await q(`
    SELECT type, COUNT(*)::int AS n
    FROM analytics
    ${whereSql}
    GROUP BY type
  `);

  const byType = Object.fromEntries(
    totals.map((r) => [r.type, Number(r.n) || 0])
  );

  const topCourses = await q(`
    SELECT course_name AS course, COUNT(*)::int AS n
    FROM analytics
    ${whereSql}
      ${whereSql ? "AND" : "WHERE"} type IN ('course_booking_click', 'booking_click')
      AND course_name IS NOT NULL
      AND course_name <> ''
    GROUP BY course_name
    ORDER BY n DESC
    LIMIT 10
  `);

  const topSearchedCourses = await q(`
    SELECT course_name AS course, COUNT(*)::int AS n
    FROM analytics
    ${whereSql}
      ${whereSql ? "AND" : "WHERE"} type = 'search_course'
      AND course_name IS NOT NULL
      AND course_name <> ''
    GROUP BY course_name
    ORDER BY n DESC
    LIMIT 10
  `);

  const topAlertCourses = await q(`
    SELECT course_name AS course, COUNT(*)::int AS hits
    FROM analytics
    ${whereSql}
      ${whereSql ? "AND" : "WHERE"} type = 'alert_hit'
      AND course_name IS NOT NULL
      AND course_name <> ''
    GROUP BY course_name
    ORDER BY hits DESC
    LIMIT 10
  `);

  const homeViews = byType.home_view || 0;
  const bookingClicks =
    (byType.course_booking_click || 0) + (byType.booking_click || 0);
  const searches = byType.search || 0;

  return {
    ok: true,

    homePageViews: homeViews,
    homeViews,

    courseBookingClicks: bookingClicks,
    bookingClicks,

    searches,
    alertSearches: byType.search_course || 0,

    newUsers: byType.new_user || 0,

    groupVotesCreated: byType.group_vote_created || 0,
    groupVotesOpened: byType.group_vote_opened || 0,
    groupVotesSubmitted: byType.group_vote_vote_submitted || 0,
    groupVotesWinnerSelected: byType.group_vote_winner_selected || 0,

    usersAllTime: 0,
    usersToday: 0,
    usersWeek: 0,
    users30d: 0,
    returningUsers7d: 0,
    repeatBookers: 0,
    peakBookingHour: null,

    topCourses: topCourses.map((r) => ({ course: r.course, n: r.n })),
    topSearchedCourses: topSearchedCourses.map((r) => ({ course: r.course, n: r.n })),
    demandRank: topCourses.map((r) => ({ course: r.course, n: r.n })),

    roundsPlayed: byType.round_played || 0,
    roundsPlayed7d: 0,
    topPlayedCourses: [],
    topPlayedCourses30d: [],

    alertsSent7d: byType.alert_sent || 0,
    alertHits7d: byType.alert_hit || 0,
    alertsSentAllTime: byType.alert_sent || 0,
    alertHitsAllTime: byType.alert_hit || 0,
    avgTimeToHitMins: 0,
    alertsByPlan: { BASIC: 0, PRO: 0, FREE: 0, TRIAL: 0, UNKNOWN: 0 },
    topAlertCourses: topAlertCourses.map((r) => ({
      course: r.course,
      hits: r.hits,
    })),

    homeToBookingRate: homeViews > 0 ? bookingClicks / homeViews : 0,
    searchToBookingRate: searches > 0 ? bookingClicks / searches : 0,
  };
}
function buildSqliteSummaryFromEvents(events = []) {
  const byType = {};
  for (const e of events) {
    const t = String(e?.type || "").trim();
    if (!t) continue;
    byType[t] = (byType[t] || 0) + 1;
  }

  const homeViews = byType.home_view || 0;
  const bookingClicks = byType.course_booking_click || 0;

  // "search" = user pressed search
  const searches = byType.search || 0;

  // background scans (alerts worker)
  const alertSearches = byType.search_course || 0;

  const newUsers = byType.new_user || 0;
const groupVotesCreated = byType.group_vote_created || 0;
const groupVotesOpened = byType.group_vote_opened || 0;
const groupVotesSubmitted = byType.group_vote_vote_submitted || 0;
const groupVotesWinnerSelected = byType.group_vote_winner_selected || 0;
const roundsPlayed = byType.round_played || 0;

  // top booked courses (from course_name)
  const topCoursesMap = new Map();
  for (const e of events) {
    if (e?.type !== "course_booking_click") continue;
    const name = e?.course_name || e?.courseName || e?.course || null;
    if (!name) continue;
    topCoursesMap.set(name, (topCoursesMap.get(name) || 0) + 1);
  }

  const topCourses = [...topCoursesMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([course, n]) => ({ course, n }));

  // top scanned courses (search_course)
  const topScannedMap = new Map();
  for (const e of events) {
    if (e?.type !== "search_course") continue;
    const name = e?.course_name || e?.courseName || e?.course || null;
    if (!name) continue;
    topScannedMap.set(name, (topScannedMap.get(name) || 0) + 1);
  }

  const topSearchedCourses = [...topScannedMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([course, n]) => ({ course, n }));

  return {
    homePageViews: homeViews,
    courseBookingClicks: bookingClicks,
    searches,
    alertSearches,
    newUsers,
    groupVotesCreated,
    groupVotesOpened,
    groupVotesSubmitted,
    groupVotesWinnerSelected,

    homeViews,
    bookingClicks,

    // these can stay 0 if you aren’t tracking user_id yet
    usersAllTime: 0,
    usersToday: 0,
    usersWeek: 0,
    users30d: 0,
    returningUsers7d: 0,
    repeatBookers: 0,
    peakBookingHour: null,

    topCourses,
    topSearchedCourses,
    demandRank: [],

    roundsPlayed,
    roundsPlayed7d: 0,
    topPlayedCourses: [],
    topPlayedCourses30d: [],

    // alerts if you emit these event types
    alertsSent7d: byType.alert_sent || 0,
    alertsHits7d: byType.alert_hit || 0,
    alertsSentAllTime: byType.alert_sent || 0,
    alertsHitAllTime: byType.alert_hit || 0,
    avgTimeToHitMins: null,
    alertsByPlan: null,
    topAlertCourses: [],
  };
}

// shared handler for summary so we can serve both "/" and "/summary"
async function handleSummary(req, res) {
  const started = Date.now();

  try {
    const filters = {
      provider: String(req.query.provider || "").trim(),
      from: String(req.query.from || "").trim(),
      to: String(req.query.to || "").trim(),
    };

    console.log("📊 /api/analytics/summary start", filters);

    // ✅ FAST PATH: avoids slow analytics.js summary timing out
    const summary = await buildPgSummary(filters);

    console.log("📊 /api/analytics/summary done", Date.now() - started + "ms");

    return res.json({
      ok: true,
      ...summary,
      loadedMs: Date.now() - started,
    });
  } catch (err) {
    console.error("❌ /api/analytics/summary failed:", err);

    return res.status(500).json({
      ok: false,
      error: "analytics_summary_failed",
      detail: err?.message || String(err),
      loadedMs: Date.now() - started,
    });
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
 * ✅ DEBUG: check Stripe + DB plan for one email
 * GET /api/analytics/users/stripe-check?email=someone@gmail.com
 */
router.get("/users/stripe-check", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "email is required" });

    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users';`
    );
    const hasPlan = new Set(cols.rows.map((r) => r.column_name)).has("plan");

        const dbRow = hasPlan
      ? await db.query(`SELECT id, email, plan FROM users WHERE LOWER(email) = $1 LIMIT 1;`, [email])
      : await db.query(`SELECT id, email FROM users WHERE LOWER(email) = $1 LIMIT 1;`, [email]);

    const subRow = await db.query(
      `
      SELECT
        email,
        plan,
        status,
        entitlement_active,
        cancel_at_period_end,
        current_period_end,
        updated_at
      FROM subscriber_status
      WHERE LOWER(email) = $1
      LIMIT 1
      `,
      [email]
    );

        const out = {
      ok: true,
      stripeEnabled: !!stripe,
      stripeKeyPresent: !!stripeKey,
      email,
      dbUser: dbRow.rows[0] || null,
      subscriberStatus: subRow.rows[0] || null,
      stripe: {
        customerFound: false,
        customerId: null,
        activeSubFound: false,
        priceId: null,
        mappedPlan: null,
      },
    };

    if (!stripe) return res.json(out);

    const custList = await stripe.customers.list({ email, limit: 1 });
    if (!custList.data.length) return res.json(out);

    const customer = custList.data[0];
    out.stripe.customerFound = true;
    out.stripe.customerId = customer.id;

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
      limit: 1,
      expand: ["data.items.data.price"],
    });

    if (!subs.data.length) return res.json(out);

    out.stripe.activeSubFound = true;

    const priceId = subs.data[0]?.items?.data?.[0]?.price?.id || null;
    out.stripe.priceId = priceId;
    out.stripe.mappedPlan = priceId ? PRICE_TO_PLAN[priceId] : null;

    return res.json(out);
  } catch (err) {
    console.error("stripe-check error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

/**
 * GET /api/analytics/users
 * ✅ Robust: works even if your users table schema differs
 */
router.get("/users", async (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 500));

  try {
    // ---- helpers ----
    const tableExists = async (name) => {
      const r = await db.query(`SELECT to_regclass($1::text) AS t;`, [name]);
      return !!r.rows[0]?.t;
    };

    const getCols = async (tableName) => {
      const r = await db.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        `,
        [tableName]
      );
      return new Set((r.rows || []).map((x) => x.column_name));
    };

    // ---- must have users table ----
    const hasUsers = await tableExists("public.users");
    if (!hasUsers) {
      // Return 200 so frontend doesn't treat as "endpoint missing"
      return res.json({
        users: [],
        warning: "users_table_missing",
      });
    }

        const usersCols = await getCols("users");

    // Safe column picks
    const colId = usersCols.has("id") ? "u.id" : "NULL::int AS id";
    const colEmail = usersCols.has("email") ? "u.email" : "NULL::text AS email";

    const colCreatedAt = usersCols.has("created_at")
      ? "u.created_at"
      : "NULL::timestamptz AS created_at";

    const colLastSeen = usersCols.has("last_seen_at")
      ? "u.last_seen_at"
      : (usersCols.has("last_login") ? "u.last_login AS last_seen_at" : "NULL::timestamptz AS last_seen_at");

    // Optional join to preferences (if table exists)
    const hasPrefs = await tableExists("public.user_preferences");

        const hasSubscriberStatus = await tableExists("public.subscriber_status");

    let sql = "";
    if (hasPrefs) {
      const prefsCols = await getCols("user_preferences");

      const colHomeState =
  prefsCols.has("home_state")
    ? "COALESCE(p.home_state, '') AS home_state"
    : "''::text AS home_state";

const colFavs =
  prefsCols.has("favourites")
    ? "COALESCE(p.favourites, '[]'::jsonb) AS favourites"
    : "'[]'::jsonb AS favourites";

const colAlertDays =
  prefsCols.has("preferred_days")
    ? "COALESCE(array_to_json(p.preferred_days)::jsonb, '[]'::jsonb) AS alert_days"
    : "'[]'::jsonb AS alert_days";

const colAlertTimeRange =
  prefsCols.has("preferred_earliest") && prefsCols.has("preferred_latest")
    ? "CASE WHEN p.preferred_earliest IS NOT NULL OR p.preferred_latest IS NOT NULL THEN COALESCE(p.preferred_earliest::text, '—') || '–' || COALESCE(p.preferred_latest::text, '—') ELSE '' END AS alert_time_range"
    : "''::text AS alert_time_range";

const colAlertHoles =
  prefsCols.has("preferred_holes")
    ? "COALESCE(p.preferred_holes::text, '') AS alert_holes"
    : "''::text AS alert_holes";

const colAlertPlayers =
  prefsCols.has("preferred_party_size")
    ? "COALESCE(p.preferred_party_size::text, '') AS alert_players"
    : "''::text AS alert_players";

const colHomeCourse =
  usersCols.has("home_course")
    ? "COALESCE(u.home_course, '') AS home_course"
    : "''::text AS home_course";

      if (hasSubscriberStatus) {
        sql = `
  SELECT
    ${colId},
    ${colEmail},
    CASE
  WHEN LOWER(COALESCE(ss.status, '')) IN ('active','trialing')
   AND UPPER(COALESCE(ss.plan, 'FREE')) IN ('BASIC','PRO')
   AND (
     ss.current_period_end IS NULL
     OR ss.current_period_end > NOW()
   )
  THEN UPPER(ss.plan)
  ELSE 'FREE'
END AS plan,
    ${colHomeState},
    ${colHomeCourse},
    ${colFavs},
    ${colAlertDays},
    ${colAlertTimeRange},
    ${colAlertHoles},
    ${colAlertPlayers},
    ${colCreatedAt},
    ${colLastSeen},
    ss.status AS subscription_status,
    ss.entitlement_active,
    ss.cancel_at_period_end,
    ss.current_period_end
  FROM users u
  LEFT JOIN user_preferences p
    ON LOWER(p.email) = LOWER(u.email)
  LEFT JOIN subscriber_status ss
    ON LOWER(ss.email) = LOWER(u.email)
  ORDER BY ${usersCols.has("created_at") ? "u.created_at" : "u.id"} DESC NULLS LAST
  LIMIT $1;
`;
      } else {
        sql = `
  SELECT
    ${colId},
    ${colEmail},
    'FREE'::text AS plan,
    ${colHomeState},
    ${colHomeCourse},
    ${colFavs},
    ${colAlertDays},
    ${colAlertTimeRange},
    ${colAlertHoles},
    ${colAlertPlayers},
    ${colCreatedAt},
    ${colLastSeen},
    NULL::text AS subscription_status,
    FALSE AS entitlement_active,
    FALSE AS cancel_at_period_end,
    NULL::timestamptz AS current_period_end
  FROM users u
  LEFT JOIN user_preferences p
    ON LOWER(p.email) = LOWER(u.email)
  ORDER BY ${usersCols.has("created_at") ? "u.created_at" : "u.id"} DESC NULLS LAST
  LIMIT $1;
`;
      }
    } else {
      const colHomeCourse =
        usersCols.has("home_course")
          ? "COALESCE(u.home_course, '') AS home_course"
          : "''::text AS home_course";

      if (hasSubscriberStatus) {
        sql = `
          SELECT
            ${colId},
            ${colEmail},
            CASE
  WHEN LOWER(COALESCE(ss.status, '')) IN ('active','trialing')
   AND UPPER(COALESCE(ss.plan, 'FREE')) IN ('BASIC','PRO')
   AND (
     ss.current_period_end IS NULL
     OR ss.current_period_end > NOW()
   )
  THEN UPPER(ss.plan)
  ELSE 'FREE'
END AS plan,
            ''::text AS home_state,
            ${colHomeCourse},
            '[]'::jsonb AS favourites,
            ${colCreatedAt},
            ${colLastSeen},
            ss.status AS subscription_status,
            ss.entitlement_active,
            ss.cancel_at_period_end,
            ss.current_period_end
          FROM users u
          LEFT JOIN subscriber_status ss
            ON LOWER(ss.email) = LOWER(u.email)
          ORDER BY ${usersCols.has("created_at") ? "u.created_at" : "u.id"} DESC NULLS LAST
          LIMIT $1;
        `;
      } else {
        sql = `
          SELECT
            ${colId},
            ${colEmail},
            'FREE'::text AS plan,
            ''::text AS home_state,
            ${colHomeCourse},
            '[]'::jsonb AS favourites,
            ${colCreatedAt},
            ${colLastSeen},
            NULL::text AS subscription_status,
            FALSE AS entitlement_active,
            FALSE AS cancel_at_period_end,
            NULL::timestamptz AS current_period_end
          FROM users u
          ORDER BY ${usersCols.has("created_at") ? "u.created_at" : "u.id"} DESC NULLS LAST
          LIMIT $1;
        `;
      }
    }

    const r = await db.query(sql, [limit]);

    const users = (r.rows || []).map((u) => ({
      ...u,
      plan: titlePlan(u.plan),
      favourites_count: Array.isArray(u.favourites) ? u.favourites.length : 0,
    }));

    return res.json({ users });
  } catch (err) {
    console.error("❌ /api/analytics/users error:", err);
    return res.json({
      users: [],
      error: "users_query_failed",
      detail: err?.message || String(err),
    });
  }
});
/**
 * PATCH /api/analytics/users/:id
 * Body: { home_state?, home_course? }
 */
router.patch("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const usersCols = await db.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
      `
    );
    const usersColSet = new Set(usersCols.rows.map((r) => r.column_name));

    const userRes = await db.query(
      `
      SELECT id, email
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const user = userRes.rows?.[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const email = String(user.email || "").trim().toLowerCase();

    const rawHomeState = req.body?.home_state;
    const rawHomeCourse = req.body?.home_course;

    const homeState =
      rawHomeState === undefined
        ? undefined
        : String(rawHomeState || "").trim().toUpperCase();

    const homeCourse =
      rawHomeCourse === undefined
        ? undefined
        : String(rawHomeCourse || "").trim();

    if (homeState !== undefined) {
      const validStates = new Set(["", "WA", "NT", "QLD", "SA", "TAS", "VIC", "NSW", "ACT"]);
      if (!validStates.has(homeState)) {
        return res.status(400).json({ ok: false, error: "invalid_home_state" });
      }
    }

    if (homeCourse !== undefined && homeCourse.length > 255) {
      return res.status(400).json({ ok: false, error: "home_course_too_long" });
    }

    // Update users table if columns exist
    if (usersColSet.has("home_course") || usersColSet.has("home_course_state")) {
      const updates = [];
      const params = [];
      let i = 1;

      if (homeCourse !== undefined && usersColSet.has("home_course")) {
        updates.push(`home_course = $${i++}`);
        params.push(homeCourse || null);
      }

      if (homeState !== undefined && usersColSet.has("home_course_state")) {
        updates.push(`home_course_state = $${i++}`);
        params.push(homeState || null);
      }

      if (updates.length) {
        params.push(id);
        await db.query(
          `
          UPDATE users
          SET ${updates.join(", ")}
          WHERE id = $${i}
          `,
          params
        );
      }
    }

    // Update user_preferences if that table exists
    const prefsExists = await db.query(`SELECT to_regclass('public.user_preferences') AS t;`);
    if (prefsExists.rows?.[0]?.t) {
      await db.query(
        `
        INSERT INTO user_preferences (email, home_state, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (email)
        DO UPDATE SET
          home_state = COALESCE($2, user_preferences.home_state),
          updated_at = NOW()
        `,
        [email, homeState === undefined ? null : homeState || null]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/analytics/users/:id error:", err);
    return res.status(500).json({ ok: false, error: "update_failed", detail: err.message });
  }
});
/**
 * DELETE /api/analytics/users/:id
 */
router.delete("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const userRes = await db.query(
      `
      SELECT id, email
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const user = userRes.rows?.[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const email = String(user.email || "").trim().toLowerCase();

    await db.query(`DELETE FROM user_preferences WHERE LOWER(email) = LOWER($1)`, [email]);
    await db.query(`DELETE FROM subscriber_status WHERE LOWER(email) = LOWER($1)`, [email]);
    await db.query(`DELETE FROM users WHERE id = $1`, [id]);

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/analytics/users/:id error:", err);
    return res.status(500).json({ ok: false, error: "delete_failed", detail: err.message });
  }
});

export default router;
