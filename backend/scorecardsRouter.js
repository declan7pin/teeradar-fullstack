// backend/scorecardsRouter.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js"; // ✅ ADD: read published templates from Postgres for guests

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- helpers ---
function safeJsonParseLoose(text) {
  // remove BOM
  let s = String(text || "").replace(/^\uFEFF/, "");

  // 1) try strict JSON first
  try {
    return JSON.parse(s);
  } catch (e1) {
    // 2) remove trailing commas before } or ]
    const fixed = s.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(fixed);
  }
}

function normalizeStateParam(st) {
  return String(st || "").trim().toUpperCase();
}

function scorecardsFileCandidates(state) {
  const st = normalizeStateParam(state);
  const stLower = st.toLowerCase();

  return [
    path.join(__dirname, "data", "scorecards", `scorecards-${stLower}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards-${st}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${stLower}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${st}.json`),

    path.join(__dirname, "data", `scorecards-${stLower}.json`),
    path.join(__dirname, "data", `scorecards-${st}.json`),
    path.join(__dirname, "data", `scorecards_${stLower}.json`),
    path.join(__dirname, "data", `scorecards_${st}.json`),

    path.join(__dirname, `scorecards-${stLower}.json`),
    path.join(__dirname, `scorecards-${st}.json`),
    path.join(__dirname, `scorecards_${stLower}.json`),
    path.join(__dirname, `scorecards_${st}.json`),

    path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${stLower}.json`),
    path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${st}.json`),
    path.join(__dirname, "..", "public", "data", `scorecards-${stLower}.json`),
    path.join(__dirname, "..", "public", "data", `scorecards-${st}.json`),
  ];
}

function pickExistingFile(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

// ✅ Try DB first (published templates), then fallback to JSON files
async function fetchPublishedScorecardsFromDb(state) {
  const st = normalizeStateParam(state);
  if (!st) return [];

  // helper: does table exist?
  async function tableExists(tableName) {
    try {
      const r = await db.query(`SELECT to_regclass($1) AS t`, [`public.${tableName}`]);
      return !!r.rows?.[0]?.t;
    } catch {
      return false;
    }
  }

  const out = [];

  // 1) Most likely table: scorecard_templates
  if (await tableExists("scorecard_templates")) {
    // Try a few likely column conventions safely
    // We pull rows and normalize in JS so small schema diffs don’t break guests.
    try {
      const r = await db.query(
        `
        SELECT *
        FROM scorecard_templates
        WHERE UPPER(COALESCE(state, '')) = $1
          AND (
            UPPER(COALESCE(status, '')) = 'PUBLISHED'
            OR COALESCE(published, false) = true
            OR COALESCE(is_published, false) = true
          )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        `,
        [st]
      );

      for (const row of r.rows || []) {
        const course =
          row.course ||
          row.course_name ||
          row.name ||
          row.courseTitle ||
          row.title ||
          "";

        const holes = Number(row.holes || row.hole_count || row.num_holes || 0) || null;
        const layout = String(row.layout || row.layout_name || row.nine_name || "").trim();

        const pars =
          row.pars ||
          row.par ||
          row.pars_json ||
          row.pars_arr ||
          row.pars_array ||
          null;

        const distances_m =
          row.distances_m ||
          row.distances ||
          row.distances_json ||
          row.distances_arr ||
          row.distances_array ||
          row.yards_m ||
          null;

        if (!course || !holes) continue;

        out.push({
          course,
          name: course, // some frontends use name
          state: st,
          holes,
          layout,
          pars,
          distances_m,
        });
      }

      if (out.length) return out;
    } catch (e) {
      // keep going to other options / fallback
      console.log("ℹ️ scorecardsRouter: scorecard_templates query failed, falling back:", e?.message || e);
    }
  }

  // 2) Another possible table: scorecard_courses (published master list)
  if (await tableExists("scorecard_courses")) {
    try {
      const r = await db.query(
        `
        SELECT *
        FROM scorecard_courses
        WHERE UPPER(COALESCE(state, '')) = $1
          AND (
            UPPER(COALESCE(status, '')) = 'PUBLISHED'
            OR COALESCE(published, false) = true
            OR COALESCE(is_published, false) = true
          )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        `,
        [st]
      );

      for (const row of r.rows || []) {
        const course =
          row.course ||
          row.course_name ||
          row.name ||
          row.title ||
          "";

        const holes = Number(row.holes || row.hole_count || row.num_holes || 0) || null;
        const layout = String(row.layout || row.layout_name || row.nine_name || "").trim();

        const pars =
          row.pars ||
          row.par ||
          row.pars_json ||
          row.pars_arr ||
          row.pars_array ||
          null;

        const distances_m =
          row.distances_m ||
          row.distances ||
          row.distances_json ||
          row.distances_arr ||
          row.distances_array ||
          null;

        if (!course || !holes) continue;

        out.push({
          course,
          name: course,
          state: st,
          holes,
          layout,
          pars,
          distances_m,
        });
      }

      if (out.length) return out;
    } catch (e) {
      console.log("ℹ️ scorecardsRouter: scorecard_courses query failed, falling back:", e?.message || e);
    }
  }

  return [];
}

// GET /api/scorecards/:state
router.get("/:state", async (req, res) => {
  const state = normalizeStateParam(req.params.state);

  // ✅ 1) DB published templates first (so guests see what logged-in users see)
  try {
    const dbArr = await fetchPublishedScorecardsFromDb(state);
    if (Array.isArray(dbArr) && dbArr.length) {
      return res.json(dbArr);
    }
  } catch (e) {
    // ignore and fallback to file
    console.log("ℹ️ scorecardsRouter: DB fetch failed, falling back to file:", e?.message || e);
  }

  // ✅ 2) File fallback (your existing behavior)
  const tried = scorecardsFileCandidates(state);
  const found = pickExistingFile(tried);

  if (!found) {
    return res.status(404).json({
      error: "scorecards not found (db empty and no file)",
      state,
      expectedExamples: [
        "backend/data/scorecards/scorecards-wa.json",
        "public/data/scorecards/scorecards-wa.json",
      ],
      tried,
      debug: {
        __dirname,
        cwd: process.cwd(),
      },
    });
  }

  try {
    const raw = fs.readFileSync(found, "utf8");
    const parsed = safeJsonParseLoose(raw);

    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.scorecards) ? parsed.scorecards : null);

    if (!arr) {
      return res.status(400).json({
        error: "scorecards file parsed but had unexpected shape",
        state,
        file: found,
        expected: "Array or { scorecards: Array }",
      });
    }

    return res.json(arr);
  } catch (err) {
    return res.status(400).json({
      error: "scorecards file found but could not be parsed",
      state,
      file: found,
      message: String(err?.message || err),
      hint: "If you want strict JSON, remove trailing commas inside arrays/objects.",
    });
  }
});

export default router;