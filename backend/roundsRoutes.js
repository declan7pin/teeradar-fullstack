// backend/roundsRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

// ✅ ADDED: record round_played into Postgres analytics
import { recordEvent } from "./analytics.js";

// ✅ OPTIONAL: email admin when a new course is submitted
import { Resend } from "resend";

const router = express.Router();
router.use(express.json());

// -------------------------------------------------
// ✅ OPTIONAL: Admin email alerts (Resend)
// -------------------------------------------------
const resendKey = (process.env.RESEND_API_KEY || "").trim();
const resend = resendKey ? new Resend(resendKey) : null;
const ADMIN_ALERT_EMAIL = (process.env.ADMIN_ALERT_EMAIL || "").trim(); // set to your TeeRadar inbox

async function sendAdminAlert(subject, html) {
  if (!resend || !ADMIN_ALERT_EMAIL) return;
  try {
    await resend.emails.send({
      from: "TeeRadar <no-reply@teeradar.com.au>", // must be a verified sender in Resend
      to: [ADMIN_ALERT_EMAIL],
      subject,
      html,
    });
  } catch (e) {
    console.warn("Admin alert email failed:", e?.message || e);
  }
}

// -------------------------------------------------
// ✅ Admin guard (uses req.isSuperAdmin set in server.js)
// -------------------------------------------------
function requireSuperAdmin(req, res, next) {
  try {
    const email = String(req.user?.email || "").trim().toLowerCase();
    const fn = req.isSuperAdmin;
    const ok = typeof fn === "function" ? !!fn(email) : false;
    if (!ok) return res.status(403).json({ ok: false, error: "forbidden" });
    return next();
  } catch {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
}

// -------------------------------------------------
// ✅ Normalisers (kept because DB template + pending submissions use them)
// -------------------------------------------------
function normalise(s) {
  return (s || "").toString().trim().toLowerCase();
}

// ✅ NEW: normalise course names so they match DB templates
// Removes trailing "(18 holes)" / "(9 holes)" etc.
function normaliseCourseName(s) {
  let x = (s || "").toString().trim().toLowerCase();

  x = x.replace(/\s*\(\s*\d+\s*holes?\s*\)\s*$/i, "");
  x = x.replace(/\s*\(\s*\d+\s*hole\s*\)\s*$/i, "");

  // ✅ make "front / back" match "front/back"
  x = x.replace(/\s*\/\s*/g, "/");

  // ✅ collapse whitespace
  x = x.replace(/\s+/g, " ").trim();

  return x;
}

async function getTemplateFromDbAnyState(course, holes, layout = null) {
  const baseName = normaliseCourseName(course);
  const layoutName = normaliseCourseName(layout);
  const h = Number(holes);

  if (!baseName || !h) return null;

  const possibleNames = new Set();
  possibleNames.add(baseName);

  if (layoutName) {
    possibleNames.add(normaliseCourseName(`${baseName} - ${layoutName}`));
    possibleNames.add(normaliseCourseName(`${baseName}-${layoutName}`));
  }

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json
    FROM scorecard_courses
    WHERE holes = $1
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [h]
  );

  const matches = (rows || []).filter((r) => {
    const n = normaliseCourseName(r.name);
    return possibleNames.has(n);
  });

  if (matches.length !== 1) {
    console.log("⚠️ getTemplateFromDbAnyState no single match:", {
      course,
      layout,
      holes: h,
      possibleNames: Array.from(possibleNames),
      matches: matches.map((m) => ({
        id: m.id,
        name: m.name,
        state: m.state,
        holes: m.holes,
      })),
    });
    return null;
  }

  const match = matches[0];

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
  };
}

// -------------------------------------------------
// ✅ NEW: Multi-player helpers (only adds support; doesn't break existing)
// -------------------------------------------------
function clampPlayers(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 1;
  return Math.max(1, Math.min(4, Math.floor(x)));
}

function cleanPlayerMap(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (let i = 1; i <= 4; i++) {
    const v = obj[String(i)];
    if (v === null || typeof v === "undefined" || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[String(i)] = n;
  }
  return out;
}

// -------------------------------------------------
// ✅ ensure rounds.player_names exists (Postgres)
// -------------------------------------------------
async function ensurePlayerNamesColumn() {
  try {
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS player_names jsonb DEFAULT '[]'::jsonb;
    `);
  } catch (e) {
    console.warn("ensurePlayerNamesColumn failed:", e?.message || e);
  }
}

// -------------------------------------------------
// ✅ "complete" heuristic to count a round as played
// -------------------------------------------------
function isCompleteFromPayload(holesArr, holesCount) {
  if (!Array.isArray(holesArr)) return false;
  if (!Number.isFinite(Number(holesCount))) return false;

  if (holesArr.length < Number(holesCount)) return false;

  const strokesByHole = new Map();

  for (const h of holesArr) {
    const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
    if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

    const strokesMap = cleanPlayerMap(h?.strokes_by_player || h?.strokesByPlayer || {});
    let strokesVal =
      typeof strokesMap["1"] !== "undefined"
        ? strokesMap["1"]
        : h?.strokes === null || typeof h?.strokes === "undefined" || h?.strokes === ""
          ? null
          : Number(h.strokes);

    strokesByHole.set(holeNum, Number.isFinite(Number(strokesVal)) ? Number(strokesVal) : null);
  }

  for (let i = 1; i <= Number(holesCount); i++) {
    const v = strokesByHole.get(i);
    if (!Number.isFinite(v)) return false;
  }

  return true;
}

// -------------------------------------------------
// ✅ Scorecard templates in DB (APPROVED only)
// -------------------------------------------------
async function getTemplateFromDb(course, state, holes) {
  const nameNorm = normaliseCourseName(course);
  const st = String(state || "").trim().toUpperCase();
  const h = Number(holes);

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json
    FROM scorecard_courses
    WHERE LOWER(name) = $1 AND state = $2 AND holes = $3
    LIMIT 1;
    `,
    [nameNorm, st, h]
  );

  if (!rows.length) return null;

  const r = rows[0];
  const pars = Array.isArray(r.pars_json) ? r.pars_json : null;
  const dists = Array.isArray(r.dists_json) ? r.dists_json : null;

  return { id: r.id, name: r.name, state: r.state, holes: r.holes, pars, dists };
}

function isCompleteTemplateArrays(pars, dists, holes) {
  if (!Array.isArray(pars) || pars.length !== holes) return false;
  if (!Array.isArray(dists) || dists.length !== holes) return false;

  for (let i = 0; i < holes; i++) {
    const p = Number(pars[i]);
    const d = Number(dists[i]);
    if (!Number.isFinite(p) || p < 3 || p > 6) return false;
    if (!Number.isFinite(d) || d < 40 || d > 800) return false;
  }
  return true;
}

async function getTemplateFromDbLoose(course, state, holes) {
  const wanted = normaliseCourseName(course);
  const st = String(state || "").trim().toUpperCase();
  const h = Number(holes);

  if (!wanted || !st || !h) return null;

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json
    FROM scorecard_courses
    WHERE state = $1 AND holes = $2
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [st, h]
  );

  const match = (rows || []).find((r) => normaliseCourseName(r.name) === wanted);
  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
  };
}

function splitLayoutParts(layout) {
  return String(layout || "")
    .split("/")
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

async function getNineHoleTemplateForLayout(course, state, layoutPart) {
  const wantedCourse = normaliseCourseName(course);
  const wantedPart = String(layoutPart || "").trim().toLowerCase();
  const st = String(state || "").trim().toUpperCase();

  if (!wantedCourse || !wantedPart || !st) return null;

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json
    FROM scorecard_courses
    WHERE state = $1 AND holes = 9
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [st]
  );

  const match = (rows || []).find((r) => {
    const n = normaliseCourseName(r.name);
    return n.includes(wantedCourse) && n.includes(wantedPart);
  });

  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
  };
}
// -------------------------------------------------
// Helpers
// -------------------------------------------------
async function getRoundOwner(roundId) {
  const { rows } = await db.query(
    `SELECT id, user_id, course, state, holes, players_count FROM rounds WHERE id = $1 LIMIT 1`,
    [Number(roundId)]
  );
  return rows[0] || null;
}

async function getRoundWithHoles(roundId) {
  const roundRow = await db.query(
    `
    SELECT id, user_id, course, layout, state, holes, par_mode, created_at,
           players_count, player_names
    FROM rounds
    WHERE id = $1
    LIMIT 1;
    `,
    [Number(roundId)]
  );

  if (!roundRow.rows.length) return null;

  const holesRows = await db.query(
    `
    SELECT hole_number, par, distance_m, strokes, putts,
           strokes_by_player, putts_by_player
    FROM round_holes
    WHERE round_id = $1
    ORDER BY hole_number ASC;
    `,
    [Number(roundId)]
  );

  return { round: roundRow.rows[0], holes: holesRows.rows || [] };
}
function isValidEmail(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function normaliseStateCode(v) {
  const s = String(v || "").trim().toUpperCase();
  const allowed = new Set(["WA", "NT", "QLD", "NSW", "VIC", "SA", "TAS", "ACT"]);
  return allowed.has(s) ? s : "";
}
// -------------------------------------------------
// ✅ Template endpoints
// Mounted at /api/rounds, so:
// - GET  /api/rounds/templates
// - POST /api/rounds/templates/submit/:roundId
// - Admin: GET  /api/rounds/admin/pending-courses
// - Admin: POST /api/rounds/admin/pending-courses/:id/approve
// -------------------------------------------------
router.get("/templates", async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, pars_json, dists_json, updated_at
      FROM scorecard_courses
      ORDER BY state ASC, name ASC, holes ASC;
      `
    );

    return res.json({
      ok: true,
      courses: rows.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        holes: r.holes,
        pars: Array.isArray(r.pars_json) ? r.pars_json : [],
        dists: Array.isArray(r.dists_json) ? r.dists_json : [],
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("GET /api/rounds/templates error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// User submits a course template based on their saved round
router.post("/templates/submit/:roundId", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.roundId);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const owner = await getRoundOwner(roundId);
    if (!owner) return res.status(404).json({ ok: false, error: "round not found" });
    if (owner.user_id !== userId) return res.status(403).json({ ok: false, error: "forbidden" });

    const holesCount = Number(owner.holes);
    const courseName = String(owner.course || "").trim();
    const stateCode = String(owner.state || "").trim().toUpperCase();

    const { rows } = await db.query(
      `
      SELECT hole_number, par, distance_m
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [roundId]
    );

    const pars = new Array(holesCount).fill(null);
    const dists = new Array(holesCount).fill(null);

    for (const r of rows) {
      const i = Number(r.hole_number) - 1;
      if (i < 0 || i >= holesCount) continue;
      pars[i] = r.par === null || typeof r.par === "undefined" ? null : Number(r.par);
      dists[i] =
        r.distance_m === null || typeof r.distance_m === "undefined" ? null : Number(r.distance_m);
    }

    if (!isCompleteTemplateArrays(pars, dists, holesCount)) {
      return res.status(400).json({
        ok: false,
        error: "template_incomplete",
        message: "Please enter par + distance for every hole before submitting this course.",
      });
    }

    // If already approved template exists, short-circuit
    const existing = await getTemplateFromDb(courseName, stateCode, holesCount);
    if (existing?.id) {
      return res.json({ ok: true, alreadyApproved: true, courseId: existing.id });
    }

    // ✅ NO DUPES + capture *submitted* email (user must type it)
const nameNorm = normaliseCourseName(courseName);

const submittedEmailRaw = String(req.body?.email || "").trim().toLowerCase();
const submittedEmail = submittedEmailRaw ? submittedEmailRaw : null;

if (!submittedEmail || !isValidEmail(submittedEmail)) {
  return res.status(400).json({
    ok: false,
    error: "email_required",
    message: "Please enter a valid email address before submitting.",
  });
}

    // ✅ IMPORTANT:
    // courses_pending has a PARTIAL unique index for OPEN rows:
    // (name, state, holes) WHERE approved_at IS NULL AND rejected_at IS NULL
    // So ON CONFLICT must include the same WHERE clause.
    const ins = await db.query(
      `
      INSERT INTO courses_pending (
        name, state, holes, pars_json, dists_json,
        submitted_by_user_id, submitted_by_email
      )
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
      ON CONFLICT (name, state, holes)
      WHERE approved_at IS NULL AND rejected_at IS NULL
      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,
        dists_json = EXCLUDED.dists_json,
        submitted_by_user_id = COALESCE(courses_pending.submitted_by_user_id, EXCLUDED.submitted_by_user_id),
        submitted_by_email   = COALESCE(courses_pending.submitted_by_email,   EXCLUDED.submitted_by_email)
      RETURNING id;
      `,
      [
        nameNorm,
        stateCode,
        holesCount,
        JSON.stringify(pars),
        JSON.stringify(dists),
        Number(userId),
        submittedEmail,
      ]
    );

    const pendingId = ins.rows[0]?.id;

    // ✅ contributor history (auto-linked)
    try {
      await db.query(
        `
        INSERT INTO scorecard_course_contributions
          (action, name, state, holes, pending_id, actor_user_id, actor_email)
        VALUES
          ('SUBMITTED', $1, $2, $3, $4, $5, $6);
        `,
        [nameNorm, stateCode, holesCount, Number(pendingId), Number(userId), submittedEmail]
      );
    } catch (e) {
      console.warn("contribution log (SUBMITTED) failed:", e?.message || e);
    }

    await sendAdminAlert(
      `New user course submitted: ${courseName} (${holesCount})`,
      `
        <p><b>New course submitted</b></p>
        <p>
          <b>Name:</b> ${courseName}<br/>
          <b>State:</b> ${stateCode}<br/>
          <b>Holes:</b> ${holesCount}<br/>
          <b>Pending ID:</b> ${pendingId}<br/>
          <b>Submitted by user_id:</b> ${userId}<br/>
<b>User email:</b> ${submittedEmail}
        </p>
        <p>Approve it in Analytics → Pending Courses.</p>
      `
    );

    return res.json({ ok: true, pendingId });
  } catch (err) {
    console.error("POST /api/rounds/templates/submit/:roundId error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Admin: list pending submissions
router.get("/admin/pending-courses", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, submitted_by_user_id, submitted_by_email, created_at
      FROM courses_pending
      WHERE approved_at IS NULL AND rejected_at IS NULL
      ORDER BY created_at DESC
      LIMIT 500;
      `
    );
    return res.json({ ok: true, pending: rows });
  } catch (err) {
    console.error("GET /api/rounds/admin/pending-courses error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// ✅ Admin: get ONE pending submission (detail for modal)
router.get("/admin/pending-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const { rows } = await db.query(
      `
      SELECT
        id, name, state, holes,
        pars_json, dists_json,
        submitted_by_user_id, submitted_by_email,
        created_at
      FROM courses_pending
      WHERE id = $1 AND approved_at IS NULL AND rejected_at IS NULL
      LIMIT 1;
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

    const p = rows[0];

    // ✅ shape matches your frontend normaliser: (data.ok && data.template)
    return res.json({
      ok: true,
      template: {
        id: p.id,
        name: p.name,
        state: p.state,
        holes: p.holes,
        pars: Array.isArray(p.pars_json) ? p.pars_json : [],
        distances_m: Array.isArray(p.dists_json) ? p.dists_json : [], // flat distances array
        submitted_by_user_id: p.submitted_by_user_id,
        submitted_by_email: p.submitted_by_email,
        created_at: p.created_at,
      },
    });
  } catch (err) {
    console.error("GET /api/rounds/admin/pending-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// -------------------------------------------------
// ✅ Admin: manage APPROVED scorecard courses (edit / delete)
// -------------------------------------------------

// List approved scorecard courses
router.get("/admin/scorecard-courses", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, updated_at
      FROM scorecard_courses
      ORDER BY state ASC, name ASC, holes ASC;
      `
    );
    return res.json({ ok: true, courses: rows });
  } catch (err) {
    console.error("GET /api/rounds/admin/scorecard-courses error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Edit an approved scorecard course (name + state)
router.patch("/admin/scorecard-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const cur = await db.query(
      `SELECT id, name, state, holes FROM scorecard_courses WHERE id = $1 LIMIT 1;`,
      [id]
    );
    if (!cur.rows.length) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const existing = cur.rows[0];

    const nameRaw = String(req.body?.name || "").trim();
    const stateRaw = String(req.body?.state || "").trim().toUpperCase();

    const newName = nameRaw ? normaliseCourseName(nameRaw) : String(existing.name || "").trim();
    const newState = stateRaw ? normaliseStateCode(stateRaw) : String(existing.state || "").trim().toUpperCase();

    if (!newName) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    if (!newState) {
      return res.status(400).json({ ok: false, error: "state_required" });
    }

    try {
      const up = await db.query(
        `
        UPDATE scorecard_courses
        SET
          name = $2,
          state = $3,
          updated_at = now()
        WHERE id = $1
        RETURNING id, name, state, holes, updated_at;
        `,
        [id, newName, newState]
      );

      return res.json({ ok: true, course: up.rows[0] });
    } catch (e) {
      const msg = String(e?.message || "").toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return res.status(409).json({ ok: false, error: "name_conflict" });
      }
      throw e;
    }
  } catch (err) {
    console.error("PATCH /api/rounds/admin/scorecard-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Delete an approved scorecard course
router.delete("/admin/scorecard-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const del = await db.query(`DELETE FROM scorecard_courses WHERE id = $1;`, [id]);
    return res.json({ ok: true, deleted: del.rowCount || 0 });
  } catch (err) {
    console.error("DELETE /api/rounds/admin/scorecard-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// Admin: approve pending -> upsert into scorecard_courses + log contribution
router.post("/admin/pending-courses/:id/approve", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, pars_json, dists_json, submitted_by_user_id, submitted_by_email
      FROM courses_pending
      WHERE id = $1 AND approved_at IS NULL AND rejected_at IS NULL
      LIMIT 1;
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

    const p = rows[0];

    // ✅ allow admin overrides before approval
    const overrideNameRaw = String(req.body?.name || "").trim();
    const overrideStateRaw = String(req.body?.state || "").trim().toUpperCase();

    const approvedName = overrideNameRaw ? normaliseCourseName(overrideNameRaw) : String(p.name || "").trim();
    const approvedState = overrideStateRaw || String(p.state || "").trim().toUpperCase();
    const approvedHoles = Number(p.holes);

    if (!approvedName) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    if (!approvedState) {
      return res.status(400).json({ ok: false, error: "state_required" });
    }

    await db.query("BEGIN");

    const up = await db.query(
      `
      INSERT INTO scorecard_courses (name, state, holes, pars_json, dists_json)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
      ON CONFLICT (name, state, holes)
      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,
        dists_json = EXCLUDED.dists_json,
        updated_at = now()
      RETURNING id;
      `,
      [
        approvedName,
        approvedState,
        approvedHoles,
        JSON.stringify(p.pars_json),
        JSON.stringify(p.dists_json)
      ]
    );

    const approvedCourseId = up.rows[0]?.id || null;

    const approverId = Number(req.user?.id || 0) || null;
    const approverEmail = String(req.user?.email || "").trim().toLowerCase() || null;

    await db.query(
      `
      UPDATE courses_pending
      SET
        name = $2,
        state = $3,
        approved_at = now(),
        approved_by_user_id = $4,
        approved_by_email = $5
      WHERE id = $1;
      `,
      [id, approvedName, approvedState, approverId, approverEmail]
    );

    try {
      await db.query(
        `
        INSERT INTO scorecard_course_contributions
          (action, name, state, holes, pending_id, approved_course_id, actor_user_id, actor_email)
        VALUES
          ('APPROVED', $1, $2, $3, $4, $5, $6, $7);
        `,
        [
          approvedName,
          approvedState,
          approvedHoles,
          Number(id),
          approvedCourseId,
          approverId,
          approverEmail
        ]
      );
    } catch (e) {
      console.warn("contribution log (APPROVED) failed:", e?.message || e);
    }

    await db.query("COMMIT");

    return res.json({
      ok: true,
      approvedCourseId,
      name: approvedName,
      state: approvedState,
      holes: approvedHoles
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("POST /api/rounds/admin/pending-courses/:id/approve error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// -------------------------------------------------
// ✅ Reusable round creator
// Used by POST /api/rounds and later by bookingRoutes.js
// -------------------------------------------------
export async function createRoundWithSeededHoles({
  userId,
  course,
  layout = null,
  state = null,
  holes = 18,
  par_mode = "published", // "published" | "blank"
  publishedPars = null,   // optional legacy support
  players_count = 1,
  player_names = null,
}) {
  const holesNum = Number(holes);

  if (!userId) {
    return { ok: false, status: 401, error: "unauthorised" };
  }
  if (!course || !String(course).trim()) {
    return { ok: false, status: 400, error: "course is required" };
  }
  if (![9, 18].includes(holesNum)) {
    return { ok: false, status: 400, error: "holes must be 9 or 18" };
  }

  let stateCode = (state || "").toString().trim().toUpperCase() || null;
  const layoutName = (layout || "").toString().trim() || null;
  const mode = (par_mode || "").toString().trim().toLowerCase() || "published";

  const playersCount = clampPlayers(players_count);

  let playerNames = [];
  if (Array.isArray(player_names)) {
    playerNames = player_names.map((x) => String(x || "").trim());
  }
  playerNames.length = playersCount;
  if (typeof playerNames[0] !== "string") playerNames[0] = "";

  let pars = null;
  let dists = null;

    // ✅ Try approved templates first
  if (mode === "published") {
    let t = null;

    if (stateCode) {
      // 1) exact course/state/holes match
      t = await getTemplateFromDb(String(course), stateCode, holesNum);

      // 2) looser name match if exact failed
      if (!t) {
        t = await getTemplateFromDbLoose(String(course), stateCode, holesNum);
      }
    }

    // ✅ 3) If booking-created round has no state, auto-find the approved template
    if (!t && !stateCode) {
      t = await getTemplateFromDbAnyState(String(course), holesNum, layoutName);
      if (t?.state) stateCode = String(t.state || "").trim().toUpperCase() || null;
    }

    if (t && Array.isArray(t.pars) && t.pars.length === holesNum) {
      pars = t.pars.slice(0, holesNum);
    }

    if (t && Array.isArray(t.dists) && t.dists.length === holesNum) {
      dists = t.dists.slice(0, holesNum);
    }

    // 4) 18-hole routed fallback from two approved 9-hole templates
    if ((!pars || !dists) && holesNum === 18 && layoutName && stateCode) {
      const parts = splitLayoutParts(layoutName);
      if (parts.length === 2) {
        const frontT = await getNineHoleTemplateForLayout(course, stateCode, parts[0]);
        const backT = await getNineHoleTemplateForLayout(course, stateCode, parts[1]);

        if (
          frontT && backT &&
          Array.isArray(frontT.pars) && frontT.pars.length === 9 &&
          Array.isArray(backT.pars) && backT.pars.length === 9
        ) {
          pars = frontT.pars.slice(0, 9).concat(backT.pars.slice(0, 9));
        }

        if (
          frontT && backT &&
          Array.isArray(frontT.dists) && frontT.dists.length === 9 &&
          Array.isArray(backT.dists) && backT.dists.length === 9
        ) {
          dists = frontT.dists.slice(0, 9).concat(backT.dists.slice(0, 9));
        }
      }
    }

    // 5) 9-hole routed fallback
    if ((!pars || !dists) && holesNum === 9 && layoutName && stateCode) {
      const t9 = await getNineHoleTemplateForLayout(course, stateCode, layoutName);

      if (t9 && Array.isArray(t9.pars) && t9.pars.length === 9) {
        pars = t9.pars.slice(0, 9);
      }

      if (t9 && Array.isArray(t9.dists) && t9.dists.length === 9) {
        dists = t9.dists.slice(0, 9);
      }
    }

    console.log("🧩 createRoundWithSeededHoles template lookup:", {
      course: String(course).trim(),
      layout: layoutName,
      state: stateCode,
      holes: holesNum,
      foundPars: !!pars,
      foundDists: !!dists,
      parsCount: Array.isArray(pars) ? pars.length : 0,
      distsCount: Array.isArray(dists) ? dists.length : 0,
    });
  }

  // ✅ legacy optional fallback
  if (mode === "published" && !pars && Array.isArray(publishedPars) && publishedPars.length === holesNum) {
    const tmp = publishedPars.map((p) => (p === null || p === undefined || p === "" ? null : Number(p)));
    if (tmp.every((p) => p === null || Number.isFinite(p))) pars = tmp;
  }

  const finalParMode = (Array.isArray(pars) && pars.length === holesNum) ? "published" : "blank";

  await ensurePlayerNamesColumn();

  let insertedRoundId = null;

  try {
    await db.query("BEGIN");

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode, players_count, player_names)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id, user_id, course, layout, state, holes, par_mode, created_at, players_count, player_names;
      `,
      [
        Number(userId),
        String(course).trim(),
        layoutName,
        stateCode,
        holesNum,
        finalParMode,
        playersCount,
        JSON.stringify(playerNames),
      ]
    );

    const round = roundInsert.rows?.[0] || null;
    if (!round || !round.id) {
      await db.query("ROLLBACK");
      return { ok: false, status: 500, error: "round_insert_failed" };
    }

    insertedRoundId = Number(round.id);

    for (let i = 1; i <= holesNum; i++) {
      const parVal = pars ? (Number.isFinite(Number(pars[i - 1])) ? Number(pars[i - 1]) : null) : null;
      const distVal = dists ? (Number.isFinite(Number(dists[i - 1])) ? Number(dists[i - 1]) : null) : null;

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
        VALUES ($1, $2, $3, $4, NULL, NULL, '{}'::jsonb, '{}'::jsonb)
        ON CONFLICT (round_id, hole_number) DO NOTHING;
        `,
        [insertedRoundId, i, parVal, distVal]
      );
    }

    await db.query("COMMIT");

    const verifyRound = await db.query(
      `
      SELECT id, user_id, course, layout, state, holes, par_mode, created_at, players_count, player_names
      FROM rounds
      WHERE id = $1
      LIMIT 1;
      `,
      [insertedRoundId]
    );

    if (!verifyRound.rows.length) {
      console.error("createRoundWithSeededHoles: round missing after commit", {
        insertedRoundId,
        userId,
        course,
        layoutName,
        stateCode,
        holesNum,
      });

      return { ok: false, status: 500, error: "round_not_found_after_commit" };
    }

    const holesRows = await db.query(
      `
      SELECT hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [insertedRoundId]
    );

    console.log("✅ createRoundWithSeededHoles created round:", {
      roundId: insertedRoundId,
      userId,
      course: String(course).trim(),
      layout: layoutName,
      state: stateCode,
      holes: holesNum,
      par_mode: finalParMode,
      templateUsed: !!(pars && dists),
    });

    return {
      ok: true,
      status: 200,
      round: verifyRound.rows[0],
      holes: holesRows.rows || [],
      scorecardUsed: !!pars,
      templateUsed: !!(pars && dists),
    };
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("createRoundWithSeededHoles failed:", err?.message || err, {
      insertedRoundId,
      userId,
      course,
      layoutName,
      stateCode,
      holesNum,
    });
    return {
      ok: false,
      status: 500,
      error: "create_round_with_seeded_holes_failed",
      detail: err?.message || String(err || ""),
    };
  }
}
// -------------------------------------------------
// Routes (mounted at /api/rounds)
// -------------------------------------------------

// Create a new round + seed holes (pars + dists if approved template exists; otherwise blank)
router.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.id;

  try {
    const {
      course,
      layout = null,
      state = null,
      holes = 18,
      par_mode = "published",
      publishedPars = null,
      players_count = 1,
      player_names = null,
    } = req.body || {};

    const result = await createRoundWithSeededHoles({
      userId,
      course,
      layout,
      state,
      holes,
      par_mode,
      publishedPars,
      players_count,
      player_names,
    });

    if (!result?.ok) {
      return res.status(result?.status || 400).json({
        ok: false,
        error: result?.error || "invalid_request",
      });
    }

    return res.json(result);
  } catch (err) {
    console.error("POST /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Alias for older frontend
router.post("/create", requireAuth, async (req, res) => {
  req.url = "/";
  return router.handle(req, res);
});

// List my rounds
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    const { rows } = await db.query(
      `
      SELECT id, course, layout, state, holes, par_mode, created_at,
             players_count, player_names
      FROM rounds
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200;
      `,
      [userId]
    );

    return res.json({ ok: true, rounds: rows });
  } catch (err) {
    console.error("GET /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  req.url = "/";
  return router.handle(req, res);
});

// Get one round + holes (must own it)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const data = await getRoundWithHoles(roundId);
    if (!data) return res.status(404).json({ ok: false, error: "round not found" });

    if (data.round.user_id !== userId) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    return res.json({ ok: true, round: data.round, holes: data.holes });
  } catch (err) {
    console.error("GET /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Bulk save all holes
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const owner = await getRoundOwner(roundId);
    if (!owner) return res.status(404).json({ ok: false, error: "round not found" });
    if (owner.user_id !== userId) return res.status(403).json({ ok: false, error: "forbidden" });

    const holes = req.body?.holes;
    if (!Array.isArray(holes)) {
      return res.status(400).json({ ok: false, error: "holes array is required" });
    }

    const newPlayersCount = clampPlayers(
      req.body?.players_count ?? req.body?.playersCount ?? owner.players_count ?? 1
    );

    let newPlayerNames = [];
    if (Array.isArray(req.body?.player_names)) {
      newPlayerNames = req.body.player_names.map((x) => String(x || "").trim());
    }
    newPlayerNames.length = newPlayersCount;

    await ensurePlayerNamesColumn();

    await db.query("BEGIN");

    // ✅ FIX: update round metadata INSIDE the transaction
    await db.query(
      `
      UPDATE rounds
      SET players_count = $2,
          player_names = $3::jsonb
      WHERE id = $1;
      `,
      [roundId, newPlayersCount, JSON.stringify(newPlayerNames)]
    );

    for (const h of holes) {
      const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
      if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

      const parVal =
        h?.par === null || typeof h?.par === "undefined" || h?.par === ""
          ? null
          : Number(h.par);

      const distVal =
        h?.distance_m === null || typeof h?.distance_m === "undefined" || h?.distance_m === ""
          ? h?.distance === null || typeof h?.distance === "undefined" || h?.distance === ""
            ? null
            : Number(h.distance)
          : Number(h.distance_m);

      const strokesMap = cleanPlayerMap(h?.strokes_by_player || h?.strokesByPlayer || {});
      const puttsMap = cleanPlayerMap(h?.putts_by_player || h?.puttsByPlayer || {});

      // keep old compatibility: strokes/putts represent Player 1
      const strokesVal =
        typeof strokesMap["1"] !== "undefined"
          ? strokesMap["1"]
          : h?.strokes === null || typeof h?.strokes === "undefined" || h?.strokes === ""
            ? null
            : Number(h.strokes);

      const puttsVal =
        typeof puttsMap["1"] !== "undefined"
          ? puttsMap["1"]
          : h?.putts === null || typeof h?.putts === "undefined" || h?.putts === ""
            ? null
            : Number(h.putts);

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        ON CONFLICT (round_id, hole_number) DO UPDATE SET
          par = EXCLUDED.par,
          distance_m = EXCLUDED.distance_m,
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts,
          strokes_by_player = EXCLUDED.strokes_by_player,
          putts_by_player = EXCLUDED.putts_by_player;
        `,
        [
          roundId,
          holeNum,
          Number.isFinite(parVal) ? parVal : null,
          Number.isFinite(distVal) ? distVal : null,
          Number.isFinite(strokesVal) ? strokesVal : null,
          Number.isFinite(puttsVal) ? puttsVal : null,
          JSON.stringify(strokesMap),
          JSON.stringify(puttsMap),
        ]
      );
    }

    await db.query("COMMIT");

    const data = await getRoundWithHoles(roundId);

    // ✅ ADDED: if the payload looks "complete", record round_played once (deduped by round_id)
    try {
      const holesCount = Number(data?.round?.holes);
      const complete = isCompleteFromPayload(holes, holesCount);

      if (complete) {
        await recordEvent({
          type: "round_played",
          userId: String(userId),
          courseName: data?.round?.course || null,
          roundId: Number(roundId),
        });
      }
    } catch (e) {
      console.warn("round_played analytics failed:", e?.message || e);
    }

    return res.json({ ok: true, round: data.round, holes: data.holes });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("PUT /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Single-hole update (older route)
router.put("/:id/hole/:n", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);
    const holeNum = Number(req.params.n);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }
    if (!Number.isFinite(holeNum) || holeNum <= 0) {
      return res.status(400).json({ ok: false, error: "invalid hole number" });
    }

    const owner = await getRoundOwner(roundId);
    if (!owner) return res.status(404).json({ ok: false, error: "round not found" });
    if (owner.user_id !== userId) return res.status(403).json({ ok: false, error: "forbidden" });

    const { strokes, putts, par, distance_m, distance } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === "" ? null : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === "" ? null : Number(putts);

    const parVal = par === null || typeof par === "undefined" || par === "" ? null : Number(par);

    const distValRaw = typeof distance_m !== "undefined" ? distance_m : distance;
    const distVal =
      distValRaw === null || typeof distValRaw === "undefined" || distValRaw === ""
        ? null
        : Number(distValRaw);

    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
      VALUES ($1, $2, NULL, NULL, NULL, NULL, '{}'::jsonb, '{}'::jsonb)
      ON CONFLICT (round_id, hole_number) DO NOTHING;
      `,
      [roundId, holeNum]
    );

    const result = await db.query(
      `
      UPDATE round_holes
      SET
        strokes = $3,
        putts = $4,
        par = COALESCE($5, par),
        distance_m = COALESCE($6, distance_m)
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player;
      `,
      [
        roundId,
        holeNum,
        Number.isFinite(strokesVal) ? strokesVal : null,
        Number.isFinite(puttsVal) ? puttsVal : null,
        Number.isFinite(parVal) ? parVal : null,
        Number.isFinite(distVal) ? distVal : null,
      ]
    );

    return res.json({ ok: true, hole: result.rows[0] || null });
  } catch (err) {
    console.error("PUT /api/rounds/:id/hole/:n error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Delete a round (must own it)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const owner = await getRoundOwner(roundId);
    if (!owner) return res.status(404).json({ ok: false, error: "round not found" });
    if (owner.user_id !== userId) return res.status(403).json({ ok: false, error: "forbidden" });

    const result = await db.query(`DELETE FROM rounds WHERE id = $1`, [roundId]);

    return res.json({ ok: true, deleted: result.rowCount || 0 });
  } catch (err) {
    console.error("DELETE /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;