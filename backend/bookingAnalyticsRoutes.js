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

// ✅ NEW: safe wrappers (don’t crash if a table/column doesn’t exist)
async function safeQOne(sql, params = []) {
  try {
    return await qOne(sql, params);
  } catch {
    return null;
  }
}
async function safeQAll(sql, params = []) {
  try {
    return await qAll(sql, params);
  } catch {
    return [];
  }
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
  const bypassKey = String(process.env.COURSE_ADMIN_BYPASS_KEY || "").trim();
  const providedBypass = String(req.headers["x-course-admin-key"] || "").trim();
  if (bypassKey && providedBypass && providedBypass === bypassKey) {
    const slug =
      String(req.headers["x-course-slug"] || "").trim().toLowerCase() ||
      String(req.query.slug || "").trim().toLowerCase();
    return slug || "";
  }

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
  if (!/^[a-z0-9-]+$/.test(slug)) return "";
  return slug;
}

// ✅ booking event types that represent a confirmed ONLINE booking in analytics
const BOOKING_CONFIRMED_EVENT_TYPES = [
  "booking_confirmed",
  "course_booking_click",
  "manual_booking_confirmed",
  "booking_confirmed_manual",
  "booking_manual_confirmed",
];

// ✅ best-effort dedupe key so 1 booking isn't counted twice
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
      CONCAT_WS('|',
        course_slug,
        COALESCE(payload->>'date', payload->>'booking_date', payload->>'day'),
        COALESCE(payload->>'time', payload->>'tee_time', payload->>'teeTime', payload->>'start_time'),
        COALESCE(payload->>'email', payload->>'userEmail'),
        COALESCE(payload->>'holes',''),
        COALESCE(payload->>'players','')
      ),
      id::text
    )
  `;
}

// -----------------------------
// ✅ NEW: auto-detect manual bookings table/columns (Postgres only)
// -----------------------------
let _manualSpecCache = null;

async function getManualSpecPg() {
  if (_manualSpecCache) return _manualSpecCache;
  if (typeof db.query !== "function") return null;

  const hasTable = async (t) => {
    const r = await safeQOne(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
      [t]
    );
    return !!r?.ok;
  };

  const hasCol = async (t, c) => {
    const r = await safeQOne(
      `SELECT 1 AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
      [t, c]
    );
    return !!r?.ok;
  };

  // Try common tables (most likely first)
  const tables = [
    "bookings",
    "booking_bookings",
    "course_bookings",
    "tee_bookings",
    "manual_bookings",
  ];

  for (const table of tables) {
    if (!(await hasTable(table))) continue;

    // time column
    const timeCols = ["created_at", "booked_at", "occurred_at", "date_created"];
    let tcol = null;
    for (const c of timeCols) {
      if (await hasCol(table, c)) { tcol = c; break; }
    }
    if (!tcol) continue;

    // slug column
    const slugCols = ["course_slug", "slug", "course", "course_id"];
    let scol = null;
    for (const c of slugCols) {
      if (await hasCol(table, c)) { scol = c; break; }
    }
    if (!scol) continue;

    // cents column
    const centsCols = ["total_cents", "total_amount_cents", "gross_cents", "amount_cents"];
    let ccol = null;
    for (const c of centsCols) {
      if (await hasCol(table, c)) { ccol = c; break; }
    }
    // revenue is optional; bookings count still useful
    // manual flag/source (optional)
    let manualWhere = "";
    const manualCandidates = [
      ["is_manual", `is_manual = true`],
      ["manual", `manual = true`],
      ["booking_source", `booking_source = 'manual'`],
      ["source", `source = 'manual'`],
      ["type", `type = 'manual'`],
      ["booking_type", `booking_type = 'manual'`],
      ["channel", `channel = 'manual'`],
      ["is_online", `is_online = false`],
    ];
    for (const [col, expr] of manualCandidates) {
      if (await hasCol(table, col)) {
        manualWhere = `AND ${expr}`;
        break;
      }
    }

    _manualSpecCache = { table, tcol, scol, ccol: ccol || null, manualWhere };
    console.log("✅ manual bookings spec detected:", _manualSpecCache);
    return _manualSpecCache;
  }

  _manualSpecCache = null;
  console.log("⚠️ manual bookings spec NOT detected (will show 0 manual bookings)");
  return null;
}

async function getManualBookingsRange({ start, end, slug }) {
  if (!start || !end) return { bookings: 0, revenue_cents: 0 };

  // Postgres path (best)
  const spec = await getManualSpecPg();
  if (spec) {
    const { table, tcol, scol, ccol, manualWhere } = spec;

    // slug filter: only if slug is provided AND slug column is text-ish; if it’s course_id it won’t match.
    // We still apply it; if it errors, safeQOne will null and we fall through to 0.
    const whereSlug = slug ? `AND ${scol} = $3` : ``;
    const params = slug ? [start, end, slug] : [start, end];

    const row = await safeQOne(
      `
      SELECT
        COUNT(*)::int AS bookings,
        ${ccol ? `COALESCE(SUM(COALESCE(${ccol},0)),0)::int` : `0::int`} AS revenue_cents
      FROM ${table}
      WHERE ${tcol} >= $1::date
        AND ${tcol} <  ($2::date + interval '1 day')
        ${manualWhere}
        ${whereSlug}
      `,
      params
    );

    if (row) {
      return {
        bookings: Number(row.bookings || 0),
        revenue_cents: Number(row.revenue_cents || 0),
      };
    }
  }

  // Fallback (no spec) — show 0 manual rather than breaking
  return { bookings: 0, revenue_cents: 0 };
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
    if (courseSlug && !slug) return res.status(400).json({ ok: false, error: "Invalid courseSlug" });

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

    const keySql = bookingKeySql();

    const onlineConfirmed = await qOne(
      `
      SELECT COUNT(DISTINCT ${keySql})::int AS n
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND event_type = ANY($3::text[])
        AND occurred_at >= now() - ($2::int || ' days')::interval
      `,
      [slug, days, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    const onlineRevenue = await qOne(
      `
      SELECT COALESCE(SUM(x.total_cents),0)::int AS total_cents
      FROM (
        SELECT
          ${keySql} AS booking_key,
          MAX(NULLIF((payload->>'total_cents')::text,'')::int) AS total_cents
        FROM booking_analytics_events
        WHERE course_slug = $1
          AND event_type = ANY($3::text[])
          AND occurred_at >= now() - ($2::int || ' days')::interval
        GROUP BY 1
      ) x
      `,
      [slug, days, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    // Note: course-admin summary is “through booking pages” — keep it online-only
    const v = Number(views?.n || 0);
    const c = Number(onlineConfirmed?.n || 0);
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
        revenue_cents: Number(onlineRevenue?.total_cents || 0),
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
        COALESCE(SUM(CASE WHEN event_type = ANY($3::text[]) THEN NULLIF((payload->>'total_cents')::text,'')::int ELSE 0 END),0)::int AS revenue_cents
      FROM booking_analytics_events
      WHERE course_slug = $1
        AND occurred_at >= now() - ($2::int || ' days')::interval
        AND (
          event_type IN ('course_page_view','times_view','booking_started')
          OR event_type = ANY($3::text[])
        )
      GROUP BY 1,2
      ORDER BY 1 ASC
      `,
      [slug, days, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    return res.json({ ok: true, courseSlug: slug, days, rows });
  } catch (e) {
    console.error("course analytics daily error:", e?.message || e);
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

    const eventTypes = BOOKING_CONFIRMED_EVENT_TYPES;
    const keySql = bookingKeySql();

    // Online (analytics) counts
    const onlineTodayParams = slug ? [eventTypes, slug] : [eventTypes];
    const onlineToday = await qOne(
      `
      SELECT COUNT(DISTINCT ${keySql})::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('day', now())
        AND occurred_at <  date_trunc('day', now()) + interval '1 day'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      onlineTodayParams
    );

    const onlineWeekParams = slug ? [eventTypes, slug] : [eventTypes];
    const onlineWeek = await qOne(
      `
      SELECT COUNT(DISTINCT ${keySql})::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('week', now())
        AND occurred_at <  date_trunc('week', now()) + interval '7 days'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      onlineWeekParams
    );

    const onlineMonthParams = slug ? [eventTypes, slug] : [eventTypes];
    const onlineMonth = await qOne(
      `
      SELECT COUNT(DISTINCT ${keySql})::int AS n
      FROM booking_analytics_events
      WHERE event_type = ANY($1::text[])
        AND occurred_at >= date_trunc('month', now())
        AND occurred_at <  date_trunc('month', now()) + interval '1 month'
      ${slug ? "AND course_slug = $2" : ""}
      `,
      onlineMonthParams
    );

    // Manual (real bookings table) — only reliable for custom range without knowing the exact “today/week/month” semantics
    // So we keep those cards online-only and FIX the “selected range” totals (your issue).
    let rangeCount = null;
    let rangeBreakdown = null;

    if (start && end) {
      const onlineRangeParams = slug ? [eventTypes, start, end, slug] : [eventTypes, start, end];
      const onlineRange = await qOne(
        `
        SELECT COUNT(DISTINCT ${keySql})::int AS n
        FROM booking_analytics_events
        WHERE event_type = ANY($1::text[])
          AND occurred_at >= $2::date
          AND occurred_at <  ($3::date + interval '1 day')
        ${slug ? "AND course_slug = $4" : ""}
        `,
        onlineRangeParams
      );

      const manualRange = await getManualBookingsRange({ start, end, slug: slug || null });

      const onlineN = Number(onlineRange?.n || 0);
      const manualN = Number(manualRange.bookings || 0);
      const totalN = onlineN + manualN;

      rangeCount = totalN;
      rangeBreakdown = { online: onlineN, manual: manualN, total: totalN };
    }

    // course list (dropdown) stays online-based (fine)
    const courses = await qAll(
      `
      SELECT
        course_slug,
        COUNT(DISTINCT ${keySql}) FILTER (WHERE event_type = ANY($1::text[]))::int AS bookings
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

      // legacy shape (unchanged)
      bookings: {
        today: Number(onlineToday?.n || 0),
        week: Number(onlineWeek?.n || 0),
        month: Number(onlineMonth?.n || 0),
        range: rangeCount !== null ? Number(rangeCount) : null,
      },

      // ✅ NEW: explicit breakdown (use this for UI)
      breakdown: {
        today: { online: Number(onlineToday?.n || 0), manual: 0, total: Number(onlineToday?.n || 0) },
        week: { online: Number(onlineWeek?.n || 0), manual: 0, total: Number(onlineWeek?.n || 0) },
        month: { online: Number(onlineMonth?.n || 0), manual: 0, total: Number(onlineMonth?.n || 0) },
        range: rangeBreakdown,
      },

      courses: (courses || []).filter((c) => c.course_slug),
    });
  } catch (e) {
    console.error("admin bookings analytics error:", e?.message || e);
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

    const startSql = start ? `$1::date` : `(now()::date - interval '29 days')::date`;
    const endSql = end ? `($2::date + interval '1 day')` : `(now()::date + interval '1 day')`;

    const params = [];
    if (start) params.push(start);
    if (end) params.push(end);

    const slugWhere = slug ? `AND course_slug = $${params.length + 1}` : ``;
    if (slug) params.push(slug);

    const keySql = bookingKeySql();

    // ONLINE rows (analytics)
    const onlineRows = await qAll(
      `
      WITH per_booking AS (
        SELECT
          to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
          ${keySql} AS booking_key,
          MAX(NULLIF((payload->>'total_cents')::text,'')::int) AS total_cents
        FROM booking_analytics_events
        WHERE occurred_at >= ${startSql}
          AND occurred_at <  ${endSql}
          ${slugWhere}
          AND event_type = ANY($${params.length + 1}::text[])
        GROUP BY 1,2
      )
      SELECT
        day,
        COUNT(*)::int AS online_bookings,
        COALESCE(SUM(total_cents),0)::int AS online_revenue_cents
      FROM per_booking
      GROUP BY day
      ORDER BY day ASC
      `,
      [...params, BOOKING_CONFIRMED_EVENT_TYPES]
    );

    // MANUAL totals for range (we add them as separate fields; UI can sum)
    const manualRange = await getManualBookingsRange({
      start: start || null,
      end: end || null,
      slug: slug || null,
    });

    // ✅ For now: add manual totals onto the last day so your existing “sum rows” UI works immediately
    let rows = Array.isArray(onlineRows) ? onlineRows.map((r) => ({ ...r })) : [];
    if ((manualRange.bookings || 0) > 0 || (manualRange.revenue_cents || 0) > 0) {
      if (rows.length === 0) {
        rows.push({
          day: start || "",
          online_bookings: 0,
          online_revenue_cents: 0,
        });
      }
      const last = rows[rows.length - 1];
      last.manual_bookings = Number(manualRange.bookings || 0);
      last.manual_revenue_cents = Number(manualRange.revenue_cents || 0);
    }

    // Fill missing manual fields with 0s + add totals
    rows = rows.map((r) => {
      const onlineB = Number(r.online_bookings || 0);
      const onlineR = Number(r.online_revenue_cents || 0);
      const manualB = Number(r.manual_bookings || 0);
      const manualR = Number(r.manual_revenue_cents || 0);
      return {
        ...r,
        manual_bookings: manualB,
        manual_revenue_cents: manualR,
        bookings: onlineB + manualB,              // legacy compatible
        revenue_cents: onlineR + manualR,         // legacy compatible
        total_bookings: onlineB + manualB,
        total_revenue_cents: onlineR + manualR,
      };
    });

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

    const keySql = bookingKeySql();

    const rows = await qAll(
      `
      WITH per_booking AS (
        SELECT
          course_slug,
          ${keySql} AS booking_key,
          MAX(NULLIF((payload->>'total_cents')::text,'')::int) AS total_cents
        FROM booking_analytics_events
        WHERE occurred_at >= ${startSql}
          AND occurred_at <  ${endSql}
          AND event_type = ANY($${params.length + 1}::text[])
        GROUP BY 1,2
      )
      SELECT
        course_slug,
        COUNT(*)::int AS bookings,
        COALESCE(SUM(total_cents),0)::int AS revenue_cents
      FROM per_booking
      GROUP BY course_slug
      ORDER BY revenue_cents DESC NULLS LAST, bookings DESC
      LIMIT 50
      `,
      [...params, BOOKING_CONFIRMED_EVENT_TYPES]
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
        AND (
          event_type IN ('booking_started','times_view','course_page_view')
          OR event_type = ANY($${params.length + 1}::text[])
        )
      ${slugWhere}
      ORDER BY occurred_at DESC
      `,
      [...params, BOOKING_CONFIRMED_EVENT_TYPES]
    );

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