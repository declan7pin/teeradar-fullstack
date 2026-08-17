// backend/scorecardsRouter.js

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js"; // ✅ read from Postgres

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================
// Helpers
// =========================================================

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
    path.join(
      __dirname,
      "data",
      "scorecards",
      `scorecards-${stLower}.json`
    ),

    path.join(
      __dirname,
      "data",
      "scorecards",
      `scorecards-${st}.json`
    ),

    path.join(
      __dirname,
      "data",
      "scorecards",
      `scorecards_${stLower}.json`
    ),

    path.join(
      __dirname,
      "data",
      "scorecards",
      `scorecards_${st}.json`
    ),

    path.join(
      __dirname,
      "data",
      `scorecards-${stLower}.json`
    ),

    path.join(
      __dirname,
      "data",
      `scorecards-${st}.json`
    ),

    path.join(
      __dirname,
      "data",
      `scorecards_${stLower}.json`
    ),

    path.join(
      __dirname,
      "data",
      `scorecards_${st}.json`
    ),

    path.join(
      __dirname,
      `scorecards-${stLower}.json`
    ),

    path.join(
      __dirname,
      `scorecards-${st}.json`
    ),

    path.join(
      __dirname,
      `scorecards_${stLower}.json`
    ),

    path.join(
      __dirname,
      `scorecards_${st}.json`
    ),

    path.join(
      __dirname,
      "..",
      "public",
      "data",
      "scorecards",
      `scorecards-${stLower}.json`
    ),

    path.join(
      __dirname,
      "..",
      "public",
      "data",
      "scorecards",
      `scorecards-${st}.json`
    ),

    path.join(
      __dirname,
      "..",
      "public",
      "data",
      `scorecards-${stLower}.json`
    ),

    path.join(
      __dirname,
      "..",
      "public",
      "data",
      `scorecards-${st}.json`
    ),
  ];
}

function pickExistingFile(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {}
  }

  return null;
}

function safeIdent(x) {
  const s = String(x || "");

  if (!/^[a-zA-Z0-9_]+$/.test(s)) {
    return null;
  }

  return s;
}

// =========================================================
// AUTO detect published scorecard table + columns
// =========================================================

async function fetchScorecardsFromDbAuto(state) {
  const st = normalizeStateParam(state);

  if (!st) {
    return {
      rows: [],
      debug: {
        reason: "no_state",
      },
    };
  }

  // Find candidate scorecard tables + columns
  const colRes = await db.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name ILIKE '%scorecard%'
    ORDER BY table_name, column_name
  `);

  const byTable = new Map();

  for (const r of colRes.rows || []) {
    const t = r.table_name;
    const c = r.column_name;

    if (!byTable.has(t)) {
      byTable.set(t, new Set());
    }

    byTable.get(t).add(c);
  }

  // =========================================================
  // Candidate column names
  // =========================================================

  const courseCols = [
    "course",
    "course_name",
    "name",
    "title",
  ];

  const holesCols = [
    "holes",
    "hole_count",
    "num_holes",
  ];

  const layoutCols = [
    "layout",
    "layout_name",
    "nine_name",
  ];

  const ratingCols = [
    "rating",
    "course_rating",
    "scratch_rating",
  ];

  const slopeCols = [
    "slope",
    "slope_rating",
  ];

  const teeCols = [
    "tee",
    "tee_name",
    "tee_colour",
    "tee_color",
  ];

  const parsCols = [
    "pars",
    "pars_json",
    "pars_arr",
    "pars_array",
    "par_json",
    "par",
    "hole_pars",
    "par_by_hole",
  ];

  const distCols = [
    "distances_m",
    "distances",
    "distances_json",
    "distances_arr",
    "distances_array",
    "distance_m",
    "distance",
    "dist_m",
    "dist",
    "meters",
    "metres",
    "yards",
    "tee_distances",
    "tee_distances_m",
    "hole_distances",
    "hole_distances_m",
    "distance_by_hole",
    "distances_by_hole",
    "distances_meters",
    "distance_meters",
  ];

  const stateCols = [
    "state",
  ];

  const pubCols = [
    "status",
    "published",
    "is_published",
  ];

  // =========================================================
  // Find best table
  // =========================================================

  const candidates = [];

  for (const [table, colsSet] of byTable.entries()) {
    const cols = colsSet;

    const hasState =
      stateCols.some((c) => cols.has(c));

    const hasCourse =
      courseCols.some((c) => cols.has(c));

    const hasHoles =
      holesCols.some((c) => cols.has(c));

    const hasPars =
      parsCols.some((c) => cols.has(c));

    const hasDistExplicit =
      distCols.some((c) => cols.has(c));

    const hasDistRegex =
      Array.from(cols).some((c) =>
        /(dist|metre|meter|yard)/i.test(c)
      );

    const hasDist =
      hasDistExplicit || hasDistRegex;

    if (
      hasState &&
      hasCourse &&
      hasHoles &&
      (hasPars || hasDist)
    ) {
      candidates.push({
        table,
        cols: Array.from(cols),

        score:
          (hasPars ? 2 : 0) +
          (hasDist ? 3 : 0) +
          (layoutCols.some((c) => cols.has(c)) ? 1 : 0) +
          (ratingCols.some((c) => cols.has(c)) ? 1 : 0) +
          (slopeCols.some((c) => cols.has(c)) ? 1 : 0) +
          (teeCols.some((c) => cols.has(c)) ? 1 : 0) +
          (pubCols.some((c) => cols.has(c)) ? 1 : 0),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return {
      rows: [],

      debug: {
        reason: "no_candidate_scorecard_tables",

        seenScorecardTables:
          Array.from(byTable.keys()).slice(0, 50),
      },
    };
  }

  const chosen = candidates[0];

  const table = safeIdent(chosen.table);

  if (!table) {
    return {
      rows: [],

      debug: {
        reason: "unsafe_table_name",
        chosen: chosen.table,
      },
    };
  }

  const colsSet = new Set(chosen.cols);

  const pickCol = (options) =>
    options.find((c) => colsSet.has(c)) || null;

  // =========================================================
  // Pick actual columns
  // =========================================================

  const colCourse =
    pickCol(courseCols);

  const colHoles =
    pickCol(holesCols);

  const colLayout =
    pickCol(layoutCols);

  const colPars =
    pickCol(parsCols);

  const colRating =
    pickCol(ratingCols);

  const colSlope =
    pickCol(slopeCols);

  const colTee =
    pickCol(teeCols);

  const colStatus =
    colsSet.has("status")
      ? "status"
      : null;

  const colPublished =
    colsSet.has("published")
      ? "published"
      : null;

  const colIsPublished =
    colsSet.has("is_published")
      ? "is_published"
      : null;

  // =========================================================
  // Published filter
  // =========================================================

  const pubWheres = [];

  if (colStatus) {
    pubWheres.push(
      `UPPER(COALESCE("${colStatus}", '')) = 'PUBLISHED'`
    );
  }

  if (colPublished) {
    pubWheres.push(
      `COALESCE("${colPublished}", false) = true`
    );
  }

  if (colIsPublished) {
    pubWheres.push(
      `COALESCE("${colIsPublished}", false) = true`
    );
  }

  const wherePublished =
    pubWheres.length
      ? `AND (${pubWheres.join(" OR ")})`
      : "";

  // =========================================================
  // Detect distance columns
  // =========================================================

  const distanceColNames = chosen.cols
    .filter((c) => safeIdent(c))
    .filter((c) =>
      /(dist|metre|meter|yard)/i.test(c)
    )
    .sort((a, b) => {
      const aM =
        /(_m\b|meters|metres|meter|metre)/i.test(a)
          ? 1
          : 0;

      const bM =
        /(_m\b|meters|metres|meter|metre)/i.test(b)
          ? 1
          : 0;

      if (aM !== bM) {
        return bM - aM;
      }

      return a.localeCompare(b);
    })
    .slice(0, 12);

  // =========================================================
  // Loose number parsing
  // =========================================================

  function toNumLoose(v) {
    if (v == null) {
      return null;
    }

    if (typeof v === "number") {
      return Number.isFinite(v)
        ? v
        : null;
    }

    if (typeof v === "string") {
      const s = v.trim();

      if (!s) {
        return null;
      }

      const m =
        s.match(/-?\d+(\.\d+)?/);

      if (!m) {
        return null;
      }

      const n =
        Number(m[0]);

      return Number.isFinite(n)
        ? n
        : null;
    }

    if (typeof v === "object") {
      const keys = [
        "m",
        "meters",
        "metres",
        "distance_m",
        "distance",
        "dist_m",
        "dist",
        "yards",
        "y",
      ];

      for (const k of keys) {
        if (
          Object.prototype.hasOwnProperty.call(v, k)
        ) {
          const n =
            toNumLoose(v[k]);

          if (n != null) {
            return n;
          }
        }
      }
    }

    return null;
  }

  // =========================================================
  // Normalize array formats
  // =========================================================

  function toArr(val) {
    if (val == null) {
      return null;
    }

    if (Array.isArray(val)) {
      return val;
    }

    if (typeof val === "object") {
      const inner =
        val.distances_m ??
        val.distances ??
        val.distance_m ??
        val.distance ??
        val.dist_m ??
        val.dist ??
        val.m ??
        val.meters ??
        val.metres ??
        val.y ??
        val.yards ??
        val.hole_distances ??
        val.hole_distances_m ??
        val.distance_by_hole ??
        val.distances_by_hole ??
        null;

      if (Array.isArray(inner)) {
        return inner;
      }

      // Handles:
      // {
      //   "1": 4,
      //   "2": 5,
      //   ...
      // }

      const numKeys =
        Object.keys(val).filter((k) =>
          /^\d+$/.test(k)
        );

      if (numKeys.length) {
        numKeys.sort(
          (a, b) =>
            Number(a) - Number(b)
        );

        return numKeys.map(
          (k) => val[k]
        );
      }
    }

    if (typeof val === "string") {
      const s = val.trim();

      if (!s) {
        return null;
      }

      try {
        const parsed =
          JSON.parse(s);

        return toArr(parsed);
      } catch {
        return null;
      }
    }

    return null;
  }

  function normalizeNumberArray(arr, holes) {
    if (!Array.isArray(arr)) {
      return null;
    }

    let parsedAny = false;

    const out = [];

    for (let i = 0; i < holes; i++) {
      const n =
        toNumLoose(arr[i]);

      if (n != null) {
        parsedAny = true;
      }

      out.push(
        n != null
          ? n
          : 0
      );
    }

    return parsedAny
      ? out
      : null;
  }

  // =========================================================
  // Build SELECT
  // =========================================================

  const selectCols = [
    `"${colCourse}" AS course`,

    `"${colHoles}" AS holes`,

    colLayout
      ? `"${colLayout}" AS layout`
      : `''::text AS layout`,

    colPars
      ? `"${colPars}" AS pars`
      : `NULL AS pars`,

    colRating
      ? `"${colRating}" AS rating`
      : `NULL AS rating`,

    colSlope
      ? `"${colSlope}" AS slope`
      : `NULL AS slope`,

    colTee
      ? `"${colTee}" AS tee`
      : `'White'::text AS tee`,

    ...distanceColNames.map(
      (c) =>
        `"${c}" AS "__dist__${c}"`
    ),

    `"state" AS state`,
  ].join(", ");

  const q = `
    SELECT ${selectCols}
    FROM "${table}"
    WHERE UPPER(COALESCE("state", '')) = $1
    ${wherePublished}
    ORDER BY 1
  `;

  const res =
    await db.query(q, [st]);

  // =========================================================
  // Normalize results
  // =========================================================

  const out = (res.rows || [])
    .map((r) => {
      const course =
        String(r.course || "").trim();

      const holes =
        Number(r.holes) || null;

      if (!course || !holes) {
        return null;
      }

      const parsArr =
        normalizeNumberArray(
          toArr(r.pars),
          holes
        );

      let distArr = null;
      let usedDistCol = null;

      for (const c of distanceColNames) {
        const key =
          `__dist__${c}`;

        const candidate =
          normalizeNumberArray(
            toArr(r[key]),
            holes
          );

        if (
          candidate &&
          candidate.some(
            (n) => Number(n) > 0
          )
        ) {
          distArr =
            candidate;

          usedDistCol =
            c;

          break;
        }
      }

      const rating =
        r.rating != null &&
        r.rating !== ""
          ? Number(r.rating)
          : null;

      const slope =
        r.slope != null &&
        r.slope !== ""
          ? Number(r.slope)
          : null;

      const tee =
        String(
          r.tee || "White"
        ).trim() || "White";

      return {
        course,
        name: course,
        state: st,
        holes,

        layout:
          String(
            r.layout || ""
          ).trim(),

        rating:
          Number.isFinite(rating)
            ? rating
            : null,

        slope:
          Number.isFinite(slope)
            ? slope
            : null,

        tee,

        pars:
          parsArr,

        distances_m:
          distArr,

        distances:
          distArr,

        // ✅ debug only
        __used_distance_col:
          usedDistCol,
      };
    })
    .filter(Boolean);

  return {
    rows: out,

    debug: {
      chosenTable:
        chosen.table,

      chosenCols:
        chosen.cols,

      distanceCandidates:
        distanceColNames,

      used: {
        colCourse,
        colHoles,
        colLayout,
        colPars,
        colRating,
        colSlope,
        colTee,
        colStatus,
        colPublished,
        colIsPublished,
      },

      publishFilterApplied:
        !!wherePublished,

      candidateCount:
        candidates.length,
    },
  };
}

// =========================================================
// GET /api/scorecards/:state
// =========================================================

router.get("/:state", async (req, res) => {
  const state =
    normalizeStateParam(
      req.params.state
    );

  const debugMode =
    String(
      req.query.debug || ""
    ) === "1";

  // =========================================================
  // 1) Database first
  // =========================================================

  try {
    const dbRes =
      await fetchScorecardsFromDbAuto(
        state
      );

    if (
      Array.isArray(dbRes.rows) &&
      dbRes.rows.length
    ) {
      if (debugMode) {
        return res.json({
          ok: true,
          source: "db",
          debug:
            dbRes.debug || null,

          sample:
            dbRes.rows.slice(
              0,
              3
            ),
        });
      }

      // Remove internal debug field
      const clean =
        dbRes.rows.map((x) => {
          const {
            __used_distance_col,
            ...rest
          } = x || {};

          return rest;
        });

      return res.json(clean);
    }
  } catch (e) {
    console.log(
      "ℹ️ scorecardsRouter DB failed, falling back:",
      e?.message || e
    );
  }

  // =========================================================
  // 2) JSON file fallback
  // =========================================================

  const tried =
    scorecardsFileCandidates(
      state
    );

  const found =
    pickExistingFile(
      tried
    );

  if (!found) {
    let dbDebug = null;

    try {
      const dbg =
        await fetchScorecardsFromDbAuto(
          state
        );

      dbDebug =
        dbg.debug || null;
    } catch {
      dbDebug = null;
    }

    return res
      .status(404)
      .json({
        error:
          "scorecards not found (db empty and no file)",

        state,

        expectedExamples: [
          "backend/data/scorecards/scorecards-wa.json",
          "public/data/scorecards/scorecards-wa.json",
        ],

        tried,

        debug: {
          __dirname,
          cwd: process.cwd(),
          dbAutoDetect:
            dbDebug,
        },
      });
  }

  try {
    const raw =
      fs.readFileSync(
        found,
        "utf8"
      );

    const parsed =
      safeJsonParseLoose(
        raw
      );

    const arr =
      Array.isArray(parsed)
        ? parsed
        : (
            parsed &&
            Array.isArray(
              parsed.scorecards
            )
          )
          ? parsed.scorecards
          : null;

    if (!arr) {
      return res
        .status(400)
        .json({
          error:
            "scorecards file parsed but had unexpected shape",

          state,

          file:
            found,

          expected:
            "Array or { scorecards: Array }",
        });
    }

    return res.json(arr);
  } catch (err) {
    return res
      .status(400)
      .json({
        error:
          "scorecards file found but could not be parsed",

        state,

        file:
          found,

        message:
          String(
            err?.message ||
              err
          ),
      });
  }
});

export default router;