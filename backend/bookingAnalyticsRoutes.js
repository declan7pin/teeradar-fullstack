// backend/bookingAnalyticsRoutes.js
import express from "express";
import db from "./db.js";
import jwt from "jsonwebtoken"; // ✅ ADD

const router = express.Router();

// -----------------------------
// db wrappers (pg or sqlite)
// -----------------------------
async function qAll(sql, params = []) {
  if (typeof db.query === "function") {
    const r = await db.query(sql, params);
    return r.rows || [];
  }
  if (typeof db.all === "function") {
    return await db.all(sql, params);
  }
  throw new Error("DB adapter missing query/all");
}
async function qOne(sql, params = []) {
  const rows = await qAll(sql, params);
  return rows[0] || null;
}
async function qExec(sql, params = []) {
  if (typeof db.query === "function") {
    await db.query(sql, params);
    return;
  }
  if (typeof db.run === "function") {
    await db.run(sql, params);
    return;
  }
  throw new Error("DB adapter missing query/run");
}

// -----------------------------
// ensure table
// -----------------------------
async function ensureBookingAnalyticsTable() {
  try {
    if (typeof db.query === "function") {
      await qExec(`
        CREATE TABLE IF NOT EXISTS booking_analytics_events (
          id BIGSERIAL PRIMARY KEY,
          course_slug TEXT,
          event_type TEXT NOT NULL,
          occurred_at TIMESTAMPTZ DEFAULT now(),
          session_id TEXT,
          user_agent TEXT,
          ip TEXT,
          referrer TEXT,
          path TEXT,
          payload JSONB
        );
      `);

      await qExec(`
        CREATE INDEX IF NOT EXISTS booking_analytics_events_slug_time_idx
        ON booking_analytics_events (course_slug, occurred_at);
      `);

      await qExec(`
        CREATE INDEX IF NOT EXISTS booking_analytics_events_type_time_idx
        ON booking_analytics_events (event_type, occurred_at);
      `);
    } else {
      // sqlite fallback
      await qExec(`
        CREATE TABLE IF NOT EXISTS booking_analytics_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course_slug TEXT,
          event_type TEXT NOT NULL,
          occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,
          session_id TEXT,
          user_agent TEXT,
          ip TEXT,
          referrer TEXT,
          path TEXT,
          payload TEXT
        );
      `);
    }
    console.log("✅ booking_analytics_events table ready");
  } catch (e) {
    console.error("❌ ensureBookingAnalyticsTable error:", e?.message || e);
  }
}
ensureBookingAnalyticsTable();

// -----------------------------
// auth helpers (use server.js middleware if present)
// -----------------------------
function getEmailFromBearer(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  if (!token) return "";

  const JWT_SECRET =
    process.env.JWT_SECRET ||
    process.env.AUTH_JWT_SECRET ||
    process.env.AUTH_SECRET ||
    "";

  if (!JWT_SECRET) return "";

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return String(payload?.email || payload?.userEmail || payload?.sub || "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}
function isBookingAdminReq(req) {
  // 1) bypass key (optional)
  const bypassKey = String(process.env.BOOKING_ADMIN_BYPASS_KEY || "").trim();
  const providedBypass = String(req.headers["x-booking-admin-key"] || "").trim();
  if (bypassKey && providedBypass && providedBypass === bypassKey) return true;

  // 2) server middleware flags (if present)
  try {
    if (typeof req.isBookingAdmin === "function" && req.isBookingAdmin()) return true;
    if (req.bookingAdmin === true) return true;
  } catch {}

  // 3) ✅ allow your normal JWT admin user through if server set req.user
  // (most auth middleware attaches req.user after verifying Bearer token)
  const adminEmail = String(process.env.ADMIN_EMAIL || "declan7pin@gmail.com")
    .trim()
    .toLowerCase();

    const authedEmail =
    String(req.user?.email || req.user?.user?.email || req.auth?.email || "")
      .trim()
      .toLowerCase();

  const bearerEmail = getEmailFromBearer(req);
  const effectiveEmail = authedEmail || bearerEmail;

  if (adminEmail && effectiveEmail && effectiveEmail === adminEmail) return true;

  return false;
}

function getCourseAdminSlugFromReq(req) {
  // bookingViews.js sets req.courseAdmin when using requireCourseAdmin;
  // BUT for analytics we’ll also accept bypass header.
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
  const providedBypass = String(req.headers["x-course-admin-key"] || "").trim();
  if (bypassKey && providedBypass && providedBypass === bypassKey) {
    const slug =
      String(req.headers["x-course-slug"] || "").trim().toLowerCase() ||
      String(req.query.slug || "").trim().toLowerCase();
    return slug || "";
  }

  // if another middleware set it
  const slug = String(req.courseAdmin?.slug || "").trim();
  return slug;
}

function requireCourseAdminOrBypass(req, res, next) {
  const slug = getCourseAdminSlugFromReq(req);
  if (!slug) return res.status(401).json({ ok: false, error: "Not logged in as course admin" });
  req._courseSlug = slug;
  next();
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.ip ||
    null
  );
}

function normaliseSlug(raw) {
  const slug = String(raw || "").trim().toLowerCase();
  if (!slug) return "";
  // sane chars only
  if (!/^[a-z0-9-]+$/.test(slug)) return "";
  return slug;
}
// ✅ booking event types that represent a confirmed booking
// Add to this list if you introduce new names later.
const BOOKING_CONFIRMED_EVENT_TYPES = [
  "booking_confirmed",
  "course_booking_click",

  // ✅ manual booking variants (common)
  "manual_booking_confirmed",
  "booking_confirmed_manual",
  "booking_manual_confirmed",
];

// ✅ best-effort dedupe key so 1 booking isn't counted twice
// falls back to event id if payload doesn't contain identifiers
function bookingKeySql() {
  return `
    COALESCE(
      payload->>'reference',
      payload->>'booking_ref',
      payload->>'bookingReference',
      payload->>'booking_id',
      payload->>'bookingId',
      payload->>'payment_intent',
      payload->>'paymentIntent',
      id::text
    )
  `;
}

// -----------------------------
// POST event (public booking page can call this)
// -----------------------------
router.post("/api/book/analytics/event", express.json(), async (req, res) => {
  try {
    const {
      eventType,
      courseSlug,
      sessionId = null,
      payload = null,
      path: clientPath = null,
    } = req.body || {};

    const type = String(eventType || "").trim();
    const slug = normaliseSlug(courseSlug);

    if (!type) return res.status(400).json({ ok: false, error: "eventType is required" });

    // Allow event without slug (platform events), but if provided enforce sane chars
    if (courseSlug && !slug) {
      return res.status(400).json({ ok: false, error: "Invalid courseSlug" });
    }

    const ua = String(req.headers["user-agent"] || "");
    const ref = String(req.headers["referer"] || "");
    const ip = getClientIp(req);

    if (typeof db.query === "function") {
      await qExec(
        `
        INSERT INTO booking_analytics_events
          (course_slug, event_type, occurred_at, session_id, user_agent, ip, referrer, path, payload)
        VALUES
          ($1,$2,now(),$3,$4,$5,$6,$7,$8::jsonb)
        `,
        [
          slug || null,
          type,
          sessionId ? String(sessionId) : null,
          ua || null,
          ip,
          ref || null,
          clientPath || req.path || null,
          payload ? JSON.stringify(payload) : null,
        ]
      );
    } else {
      await qExec(
        `
        INSERT INTO booking_analytics_events
          (course_slug, event_type, occurred_at, session_id, user_agent, ip, referrer, path, payload)
        VALUES
          (?,?,?,?,?,?,?,?,?)
        `,
        [
          slug || null,
          type,
          new Date().toISOString(),
          sessionId ? String(sessionId) : null,
          ua || null,
          ip,
          ref || null,
          clientPath || req.path || null,
          payload ? JSON.stringify(payload) : null,
        ]
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("booking analytics event error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Course admin: summary (last N days)
// -----------------------------
router.get("/api/book/course-admin/analytics/summary", requireCourseAdminOrBypass, async (req, res) => {
  try {
    const slug = req._courseSlug;
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));

    const views = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = 'course_page_view'
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days]
    );

    const times = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = 'times_view'
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days]
    );

    const started = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = 'booking_started'
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days]
    );

    // ✅ confirmed bookings (manual + online)
    const confirmed = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = ANY($3::text[])
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    // ✅ revenue (manual + online)
    const revenue = await qOne(
      `
      SELECT COALESCE(SUM(NULLIF((payload->>'total_cents')::text,'')::int),0)::int AS total_cents
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = ANY($3::text[])
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    const v = Number(views?.n || 0);
    const c = Number(confirmed?.n || 0);
    const conversion = v > 0 ? c / v : 0;

    return res.json({
      ok: true,
      courseSlug: slug,
      days,
      metrics: {
        course_page_view: v,
        times_view: Number(times?.n || 0),
        booking_started: Number(started?.n || 0),
        booking_confirmed: c,
        revenue_cents: Number(revenue?.total_cents || 0),
        conversion_rate: conversion,
      },
    });
  } catch (e) {
    console.error("course analytics summary error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Course admin: daily series (last N days)
// -----------------------------
router.get("/api/book/course-admin/analytics/daily", requireCourseAdminOrBypass, async (req, res) => {
  try {
    const slug = req._courseSlug;
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));

    const rows = await qAll(
      `
      SELECT
        to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
        event_type,
        COUNT(*)::int AS n,
        COALESCE(SUM(CASE WHEN event_type IN ('booking_confirmed','course_booking_click') THEN (payload->>'total_cents')::int ELSE 0 END),0)::int AS revenue_cents
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND occurred_at >= now() - ($2::int || ' days')::interval
        AND event_type IN (
          'course_page_view',
          'times_view',
          'booking_started',
          'booking_confirmed',
          'course_booking_click'
        )
      GROUP BY 1,2
      ORDER BY 1 ASC
      `,
      [slug, days]
    );

    return res.json({ ok: true, courseSlug: slug, days, rows });
  } catch (e) {
    console.error("course analytics daily error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: overall summary
// -----------------------------
router.get("/api/book/admin/analytics/summary", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).json({ ok: false, error: "Not logged in as booking admin" });
    }

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const slug = normaliseSlug(req.query.slug);

    const whereSlug = slug ? `AND course_slug = $2` : ``;
    const params = slug ? [days, slug] : [days];

    const totals = await qOne(
      `
      SELECT
        COUNT(*) FILTER (WHERE event_type='course_page_view')::int AS views,
        COUNT(*) FILTER (WHERE event_type='times_view')::int AS times_view,
        COUNT(*) FILTER (WHERE event_type='booking_started')::int AS started,
        COUNT(*) FILTER (WHERE event_type IN ('booking_confirmed','course_booking_click'))::int AS confirmed,
        COALESCE(SUM(CASE WHEN event_type IN ('booking_confirmed','course_booking_click') THEN (payload->>'total_cents')::int ELSE 0 END),0)::int AS revenue_cents
      FROM booking_analytics_events
      WHERE occurred_at >= now() - ($1::int || ' days')::interval
      ${whereSlug}
      `,
      params
    );

    const top = await qAll(
      `
      SELECT
        course_slug,
        COUNT(*) FILTER (WHERE event_type IN ('booking_confirmed','course_booking_click'))::int AS bookings,
        COALESCE(SUM(CASE WHEN event_type IN ('booking_confirmed','course_booking_click') THEN (payload->>'total_cents')::int ELSE 0 END),0)::int AS revenue_cents
      FROM booking_analytics_events
      WHERE occurred_at >= now() - ($1::int || ' days')::interval
      ${whereSlug}
      GROUP BY course_slug
      ORDER BY revenue_cents DESC NULLS LAST, bookings DESC
      LIMIT 20
      `,
      params
    );

    return res.json({
      ok: true,
      days,
      filter: { courseSlug: slug || null },
      metrics: {
        course_page_view: Number(totals?.views || 0),
        times_view: Number(totals?.times_view || 0),
        booking_started: Number(totals?.started || 0),
        booking_confirmed: Number(totals?.confirmed || 0),
        revenue_cents: Number(totals?.revenue_cents || 0),
      },
      topCourses: top || [],
    });
  } catch (e) {
    console.error("admin analytics summary error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: booking counts (calendar-based)
// today / week / month / optional custom range + optional slug
// -----------------------------
router.get("/api/book/admin/analytics/bookings", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).json({ ok: false, error: "Not logged in as booking admin" });
    }

    const slug = normaliseSlug(req.query.slug);
    const start = String(req.query.start || "").trim(); // YYYY-MM-DD
    const end = String(req.query.end || "").trim();     // YYYY-MM-DD

    // ✅ include manual + online booking-confirmed event types
    // (BOOKING_CONFIRMED_EVENT_TYPES should be defined once near top of file)
    const eventTypes = BOOKING_CONFIRMED_EVENT_TYPES;

    // ---- TODAY ----
    const todayParams = slug ? [eventTypes, slug] : [eventTypes];
    const today = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('day', now())
        AND occurred_at <  date_trunc('day', now()) + interval '1 day'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      todayParams
    );

    // ---- THIS WEEK (Mon–Sun) ----
    const weekParams = slug ? [eventTypes, slug] : [eventTypes];
    const week = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('week', now())
        AND occurred_at <  date_trunc('week', now()) + interval '7 days'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      weekParams
    );

    // ---- THIS MONTH ----
    const monthParams = slug ? [eventTypes, slug] : [eventTypes];
    const month = await qOne(
      `
      SELECT COUNT(*)::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('month', now())
        AND occurred_at <  date_trunc('month', now()) + interval '1 month'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      monthParams
    );

    // ---- CUSTOM RANGE (optional) ----
    let rangeCount = null;
    if (start && end) {
      const params = slug ? [eventTypes, start, end, slug] : [eventTypes, start, end];
      rangeCount = await qOne(
        `
        SELECT COUNT(*)::int AS n
        FROM booking_analytics_events
        WHERE event_type = ANY($1::text[])
          AND occurred_at >= $2::date
          AND occurred_at <  ($3::date + interval '1 day')
        ${slug ? "AND course_slug = $4" : ""}
        `,
        params
      );
    }

    // ---- Course list (for dropdown) ----
    // last 90d confirmed bookings per slug
    const courses = await qAll(
      `
      SELECT
        course_slug,
        COUNT(*) FILTER (WHERE event_type = ANY($1::text[]))::int AS bookings
      FROM booking_analytics_events
      WHERE occurred_at >= now() - interval '90 days'
      GROUP BY course_slug
      ORDER BY bookings DESC
      `,
      [eventTypes]
    );

    return res.json({
      ok: true,
      filter: { courseSlug: slug || "all" },
      bookings: {
        today: Number(today?.n || 0),
        week: Number(week?.n || 0),
        month: Number(month?.n || 0),
        range: rangeCount ? Number(rangeCount.n || 0) : null,
      },
      courses: (courses || []).filter((c) => c.course_slug),
    });
  } catch (e) {
    console.error("admin bookings analytics error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: funnel (last N days) + optional slug
// -----------------------------
router.get("/api/book/admin/analytics/funnel", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).json({ ok: false, error: "Not logged in as booking admin" });
    }

    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const slug = normaliseSlug(req.query.slug);

    const whereSlug = slug ? `AND course_slug = $2` : ``;
    const params = slug ? [days, slug] : [days];

    const row = await qOne(
      `
      SELECT
        COUNT(*) FILTER (WHERE event_type='course_page_view')::int AS views,
        COUNT(*) FILTER (WHERE event_type='times_view')::int AS times_view,
        COUNT(*) FILTER (WHERE event_type='booking_started')::int AS started,
        COUNT(*) FILTER (WHERE event_type IN ('booking_confirmed','course_booking_click'))::int AS confirmed
      FROM booking_analytics_events
      WHERE occurred_at >= now() - ($1::int || ' days')::interval
        AND event_type IN (
          'course_page_view',
          'times_view',
          'booking_started',
          'booking_confirmed',
          'course_booking_click'
        )
      ${whereSlug}
      `,
      params
    );

    const views = Number(row?.views || 0);
    const times = Number(row?.times_view || 0);
    const started = Number(row?.started || 0);
    const confirmed = Number(row?.confirmed || 0);

    const convViewToConfirmed = views > 0 ? confirmed / views : 0;
    const convTimesToConfirmed = times > 0 ? confirmed / times : 0;
    const convStartedToConfirmed = started > 0 ? confirmed / started : 0;

    return res.json({
      ok: true,
      days,
      filter: { courseSlug: slug || null },
      funnel: { views, times, started, confirmed },
      conversion: {
        view_to_confirmed: convViewToConfirmed,
        times_to_confirmed: convTimesToConfirmed,
        started_to_confirmed: convStartedToConfirmed,
      },
    });
  } catch (e) {
    console.error("admin funnel error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: daily series (custom range) + optional slug
// returns bookings + revenue per day
// -----------------------------
router.get("/api/book/admin/analytics/daily", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).json({ ok: false, error: "Not logged in as booking admin" });
    }

    const slug = normaliseSlug(req.query.slug);
    const start = String(req.query.start || "").trim(); // YYYY-MM-DD
    const end = String(req.query.end || "").trim();     // YYYY-MM-DD

    // default last 30 days if not provided
    const startSql = start ? `$1::date` : `(now()::date - interval '29 days')::date`;
    const endSql = end ? `($2::date + interval '1 day')` : `(now()::date + interval '1 day')`;

    const params = [];
    if (start) params.push(start);
    if (end) params.push(end);

    const slugWhere = slug ? `AND course_slug = $${params.length + 1}` : ``;
    if (slug) params.push(slug);

    const keySql = bookingKeySql();

const rows = await qAll(
  `
  SELECT
    to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,

    -- ✅ bookings = distinct bookings (dedupes click+confirmed if payload has a ref)
    COUNT(DISTINCT ${keySql}) FILTER (
      WHERE event_type = ANY($${params.length + 1}::text[])
    )::int AS bookings,

    -- ✅ revenue = sum of total_cents for booking-type events (no dedupe, assumes only one event carries cents)
    COALESCE(SUM(
      CASE WHEN event_type = ANY($${params.length + 1}::text[])
        THEN NULLIF((payload->>'total_cents')::text,'')::int
        ELSE 0
      END
    ),0)::int AS revenue_cents

  FROM booking_analytics_events
  WHERE occurred_at >= ${startSql}
    AND occurred_at <  ${endSql}
  ${slugWhere}
  GROUP BY 1
  ORDER BY 1 ASC
  `,
  [...params, BOOKING_CONFIRMED_EVENT_TYPES]
);

    return res.json({
      ok: true,
      filter: { courseSlug: slug || null, start: start || null, end: end || null },
      rows: rows || [],
    });
  } catch (e) {
    console.error("admin daily error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: top courses (range) for quick ranking widgets
// -----------------------------
router.get("/api/book/admin/analytics/top", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).json({ ok: false, error: "Not logged in as booking admin" });
    }

    const start = String(req.query.start || "").trim(); // YYYY-MM-DD optional
    const end = String(req.query.end || "").trim();     // YYYY-MM-DD optional

    const startSql = start ? `$1::date` : `(now()::date - interval '29 days')::date`;
    const endSql = end ? `($2::date + interval '1 day')` : `(now()::date + interval '1 day')`;

    const params = [];
    if (start) params.push(start);
    if (end) params.push(end);

    const rows = await qAll(
      `
      SELECT
        course_slug,
        COUNT(*) FILTER (WHERE event_type IN ('booking_confirmed','course_booking_click'))::int AS bookings,
        COALESCE(SUM(
          CASE WHEN event_type IN ('booking_confirmed','course_booking_click')
            THEN (payload->>'total_cents')::int
            ELSE 0
          END
        ),0)::int AS revenue_cents
      FROM booking_analytics_events
      WHERE occurred_at >= ${startSql}
        AND occurred_at <  ${endSql}
      GROUP BY course_slug
      ORDER BY revenue_cents DESC NULLS LAST, bookings DESC
      LIMIT 50
      `,
      params
    );

    return res.json({ ok: true, rows: rows || [] });
  } catch (e) {
    console.error("admin top error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// -----------------------------
// Platform admin: export CSV (range + optional slug)
// -----------------------------
router.get("/api/book/admin/analytics/export.csv", async (req, res) => {
  try {
    if (!isBookingAdminReq(req)) {
      return res.status(401).send("Not logged in as booking admin");
    }

    const slug = normaliseSlug(req.query.slug);
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();

    const startSql = start ? `$1::date` : `(now()::date - interval '29 days')::date`;
    const endSql = end ? `($2::date + interval '1 day')` : `(now()::date + interval '1 day')`;

    const params = [];
    if (start) params.push(start);
    if (end) params.push(end);

    const slugWhere = slug ? `AND course_slug = $${params.length + 1}` : ``;
    if (slug) params.push(slug);

    const rows = await qAll(
      `
      SELECT
        id,
        course_slug,
        event_type,
        occurred_at,
        session_id,
        referrer,
        path,
        COALESCE((payload->>'total_cents')::text,'') AS total_cents
      FROM booking_analytics_events
      WHERE occurred_at >= ${startSql}
        AND occurred_at <  ${endSql}
        AND event_type IN ('booking_confirmed','course_booking_click','booking_started','times_view','course_page_view')
      ${slugWhere}
      ORDER BY occurred_at DESC
      `,
      params
    );

    // CSV
    const header = ["id","course_slug","event_type","occurred_at","session_id","referrer","path","total_cents"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const csv = [
      header.join(","),
      ...(rows || []).map((r) => header.map((k) => esc(r[k])).join(",")),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="booking-analytics.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error("export csv error:", e?.message || e);
    return res.status(500).send("internal_error");
  }
});

export default router;