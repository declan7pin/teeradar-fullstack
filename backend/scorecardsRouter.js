// backend/scorecardsRouter.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js"; // ✅ read from Postgres

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- helpers ---
function safeJsonParseLoose(text) {
  let s = String(text || "").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(s);
  } catch {
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
    } catch {}
  }
  return null;
}

function safeIdent(x) {
  // allow only safe SQL identifiers
  const s = String(x || "");
  if (!/^[a-zA-Z0-9_]+$/.test(s)) return null;
  return s;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

// ✅ AUTO detect the real table/columns where you store published templates
async function fetchScorecardsFromDbAuto(state) {
  const st = normalizeStateParam(state);
  if (!st) return { rows: [], debug: { reason: "no_state" } };

  // Find candidate tables + columns (public schema only)
  const colRes = await db.query(
    `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name ILIKE '%scorecard%'
    ORDER BY table_name, column_name
    `
  );

  const byTable = new Map();
  for (const r of colRes.rows || []) {
    const t = r.table_name;
    const c = r.column_name;
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(c);
  }

  const courseCols = ["course", "course_name", "name", "title"];
  const holesCols = ["holes", "hole_count", "num_holes"];
  const layoutCols = ["layout", "layout_name", "nine_name"];
  const parsCols = ["pars", "pars_json", "pars_arr", "pars_array", "par_json", "par"];
  const distCols = ["distances_m", "distances", "distances_json", "distances_arr", "distances_array"];
  const stateCols = ["state"];
  const pubCols = ["status", "published", "is_published"];

  const candidates = [];
  for (const [table, colsSet] of byTable.entries()) {
    const cols = colsSet;

    const hasState = stateCols.some((c) => cols.has(c));
    const hasCourse = courseCols.some((c) => cols.has(c));
    const hasHoles = holesCols.some((c) => cols.has(c));
    const hasPars = parsCols.some((c) => cols.has(c));
    const hasDist = distCols.some((c) => cols.has(c));

    // We want at least state+course+holes and (pars OR distances)
    if (hasState && hasCourse && hasHoles && (hasPars || hasDist)) {
      candidates.push({
        table,
        cols: Array.from(cols),
        score:
          (hasPars ? 2 : 0) +
          (hasDist ? 2 : 0) +
          (layoutCols.some((c) => cols.has(c)) ? 1 : 0) +
          (pubCols.some((c) => cols.has(c)) ? 1 : 0),
      });
    }
  }

  // Prefer best match
  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return {
      rows: [],
      debug: {
        reason: "no_candidate_scorecard_tables",
        seenScorecardTables: Array.from(byTable.keys()).slice(0, 50),
      },
    };
  }

  // Use the top candidate
  const chosen = candidates[0];
  const table = safeIdent(chosen.table);
  if (!table) {
    return { rows: [], debug: { reason: "unsafe_table_name", chosen: chosen.table } };
  }

  const colsSet = new Set(chosen.cols);

  const pickCol = (options) => options.find((c) => colsSet.has(c)) || null;

  const colCourse = pickCol(courseCols);
  const colHoles = pickCol(holesCols);
  const colLayout = pickCol(layoutCols);
  const colPars = pickCol(parsCols);
  const colDist = pickCol(distCols);

  const colStatus = colsSet.has("status") ? "status" : null;
  const colPublished = colsSet.has("published") ? "published" : null;
  const colIsPublished = colsSet.has("is_published") ? "is_published" : null;

  // Build WHERE for "published" if you have any publish flags
  const pubWheres = [];
  if (colStatus) pubWheres.push(`UPPER(COALESCE("${colStatus}", '')) = 'PUBLISHED'`);
  if (colPublished) pubWheres.push(`COALESCE("${colPublished}", false) = true`);
  if (colIsPublished) pubWheres.push(`COALESCE("${colIsPublished}", false) = true`);

  const wherePublished = pubWheres.length ? `AND (${pubWheres.join(" OR ")})` : "";

  // Select only needed columns (that exist)
  const selectCols = [
    `"${colCourse}" AS course`,
    `"${colHoles}" AS holes`,
    colLayout ? `"${colLayout}" AS layout` : `''::text AS layout`,
    colPars ? `"${colPars}" AS pars` : `NULL AS pars`,
    colDist ? `"${colDist}" AS distances_m` : `NULL AS distances_m`,
    `"state" AS state`,
  ].join(", ");

  const q = `
    SELECT ${selectCols}
    FROM "${table}"
    WHERE UPPER(COALESCE("state", '')) = $1
    ${wherePublished}
    ORDER BY 1
  `;

  const res = await db.query(q, [st]);

  // Normalize into the shape your frontend expects
  const out = (res.rows || [])
    .map((r) => {
      const course = String(r.course || "").trim();
      const holes = Number(r.holes) || null;
      if (!course || !holes) return null;

      return {
        course,
        name: course,
        state: st,
        holes,
        layout: String(r.layout || "").trim(),
        pars: r.pars ?? null,
        distances_m: r.distances_m ?? null,
      };
    })
    .filter(Boolean);

  return {
    rows: out,
    debug: {
      chosenTable: chosen.table,
      chosenCols: chosen.cols,
      used: { colCourse, colHoles, colLayout, colPars, colDist, colStatus, colPublished, colIsPublished },
      publishFilterApplied: !!wherePublished,
      candidateCount: candidates.length,
    },
  };
}

// GET /api/scorecards/:state
router.get("/:state", async (req, res) => {
  const state = normalizeStateParam(req.params.state);

  // ✅ 1) DB first (so guests see published templates)
  try {
    const dbRes = await fetchScorecardsFromDbAuto(state);
    if (Array.isArray(dbRes.rows) && dbRes.rows.length) {
      return res.json(dbRes.rows);
    }
    // no DB rows, continue to file fallback
  } catch (e) {
    console.log("ℹ️ scorecardsRouter DB failed, falling back:", e?.message || e);
  }

  // ✅ 2) File fallback
  const tried = scorecardsFileCandidates(state);
  const found = pickExistingFile(tried);

  if (!found) {
    // return a helpful error + DB auto-detect debug
    let dbDebug = null;
    try {
      const dbg = await fetchScorecardsFromDbAuto(state);
      dbDebug = dbg.debug || null;
    } catch {
      dbDebug = null;
    }

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
        dbAutoDetect: dbDebug,
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
    });
  }
});

export default router;