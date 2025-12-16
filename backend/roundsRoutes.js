// backend/roundsRoutes.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// -------------------------------------------------
// Scorecards loader (static JSON files in backend/data/scorecards)
// -------------------------------------------------
let __scorecardsCache = null;

function safeJsonParse(raw, fallback) {
  // 1) Normal JSON parse
  try {
    return JSON.parse(raw);
  } catch {}

  // 2) Tolerate common “JSON with trailing commas” + BOM
  try {
    const cleaned = String(raw)
      .replace(/^\uFEFF/, "") // BOM
      .replace(/,\s*([}\]])/g, "$1"); // trailing commas before } or ]
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function normalise(s) {
  return (s || "").toString().trim().toLowerCase();
}

// ✅ NEW: normalise course names so they match scorecards JSON
// Removes trailing "(18 holes)" / "(9 holes)" etc.
function normaliseCourseName(s) {
  let x = (s || "").toString().trim().toLowerCase();

  // remove trailing "(...holes...)" e.g. "Whaleback Golf Course (18 holes)"
  x = x.replace(/\s*\(\s*\d+\s*holes?\s*\)\s*$/i, "");

  // also handle "(9 hole)" just in case
  x = x.replace(/\s*\(\s*\d+\s*hole\s*\)\s*$/i, "");

  // collapse whitespace
  x = x.replace(/\s+/g, " ").trim();

  return x;
}

function loadScorecardsOnce() {
  if (__scorecardsCache) return __scorecardsCache;

  const baseDir = path.join(__dirname, "data", "scorecards");
  const out = [];

  try {
    if (!fs.existsSync(baseDir)) {
      console.warn("⚠️ scorecards folder missing:", baseDir);
      __scorecardsCache = [];
      return __scorecardsCache;
    }

    const files = fs
      .readdirSync(baseDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));

    for (const file of files) {
      const full = path.join(baseDir, file);
      const raw = fs.readFileSync(full, "utf8");
      const data = safeJsonParse(raw, null);

      if (!Array.isArray(data)) {
        console.warn("⚠️ scorecards file failed to parse as array:", file);
        continue;
      }

      for (const item of data) out.push(item);
    }

    console.log(`✅ loaded ${out.length} scorecards from ${baseDir}`);
  } catch (err) {
    console.error("❌ failed loading scorecards:", err?.message || err);
  }

  __scorecardsCache = out;
  return __scorecardsCache;
}

function sliceParsForNineFromEighteen(pars18, nineLoop) {
  if (!Array.isArray(pars18) || pars18.length !== 18) return null;

  const loop = (nineLoop || "front").toString().trim().toLowerCase();
  if (loop === "back") return pars18.slice(9, 18);
  return pars18.slice(0, 9);
}

function findScorecard({ course, layout, state, holes }) {
  const cards = loadScorecardsOnce();

  // ✅ use course normaliser that strips "(18 holes)"
  const wantCourse = normaliseCourseName(course);
  const wantLayout = normalise(layout);
  const wantState = normalise(state);
  const wantHoles = Number(holes);

  // 1) Try exact match: course + state + layout + holes
  let match =
    cards.find((c) => {
      const cCourse = normaliseCourseName(c.course);
      const cLayout = normalise(c.layout);
      const cState = normalise(c.state);
      const cHoles = Number(c.holes);

      return (
        cCourse === wantCourse &&
        cState === wantState &&
        cLayout === wantLayout &&
        Number.isFinite(cHoles) &&
        cHoles === wantHoles
      );
    }) || null;

  if (match) return match;

  // 2) Try: course + state + holes (ignore layout)
  match =
    cards.find((c) => {
      const cCourse = normaliseCourseName(c.course);
      const cState = normalise(c.state);
      const cHoles = Number(c.holes);

      return (
        cCourse === wantCourse &&
        cState === wantState &&
        Number.isFinite(cHoles) &&
        cHoles === wantHoles
      );
    }) || null;

  return match;
}

// -------------------------------------------------
// Helpers
// -------------------------------------------------
async function getRoundOwner(roundId) {
  const { rows } = await db.query(
    `SELECT id, user_id FROM rounds WHERE id = $1 LIMIT 1`,
    [Number(roundId)]
  );
  return rows[0] || null;
}

async function getRoundWithHoles(roundId) {
  const roundRow = await db.query(
    `
    SELECT id, user_id, course, layout, state, holes, par_mode, created_at
    FROM rounds
    WHERE id = $1
    LIMIT 1;
    `,
    [Number(roundId)]
  );

  if (!roundRow.rows.length) return null;

  const holesRows = await db.query(
    `
    SELECT hole_number, par, strokes, putts
    FROM round_holes
    WHERE round_id = $1
    ORDER BY hole_number ASC;
    `,
    [Number(roundId)]
  );

  return { round: roundRow.rows[0], holes: holesRows.rows || [] };
}

// -------------------------------------------------
// Routes (mounted at /api/rounds)
// -------------------------------------------------

// Create a new round + seed holes (pars if available; otherwise blank)
router.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.id;

  try {
    const {
      course,
      layout = null,
      state = null,
      holes = 18,
      par_mode = "published", // "published" | "blank"
      nineLoop = "front",     // "front" | "back" (only relevant for 9 holes)
      publishedPars = null,
    } = req.body || {};

    const holesNum = Number(holes);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!course || !String(course).trim()) {
      return res.status(400).json({ ok: false, error: "course is required" });
    }
    if (![9, 18].includes(holesNum)) {
      return res.status(400).json({ ok: false, error: "holes must be 9 or 18" });
    }

    const stateCode = (state || "").toString().trim().toUpperCase() || null;
    const layoutName = (layout || "").toString().trim() || null;
    const mode = (par_mode || "").toString().trim().toLowerCase() || "published";

    let pars = null;

    // 1) If frontend supplied publishedPars and it's valid length, accept it (optional)
    if (mode === "published" && Array.isArray(publishedPars) && publishedPars.length === holesNum) {
      pars = publishedPars.map((p) => (p === null || p === undefined || p === "" ? null : Number(p)));
      if (!pars.every((p) => p === null || Number.isFinite(p))) pars = null;
    }

    // 2) Otherwise, load from backend/data/scorecards/*.json
    if (mode === "published" && !pars) {
      // Try direct match (same holes)
      const cardSame = findScorecard({
        course: String(course),
        layout: layoutName || "",
        state: stateCode || "",
        holes: holesNum,
      });

      if (cardSame && Array.isArray(cardSame.pars)) {
        const cleaned = cardSame.pars.map((p) =>
          p === null || p === undefined || p === "" ? null : Number(p)
        );
        if (cleaned.length === holesNum) pars = cleaned;
      }

      // If 9-hole requested but only 18-hole scorecard exists, slice front/back
      if (!pars && holesNum === 9) {
        const card18 = findScorecard({
          course: String(course),
          layout: layoutName || "",
          state: stateCode || "",
          holes: 18,
        });

        if (card18 && Array.isArray(card18.pars) && card18.pars.length === 18) {
          pars = sliceParsForNineFromEighteen(card18.pars, nineLoop);
        } else {
          // Try ignore layout for 18-hole
          const card18NoLayout = findScorecard({
            course: String(course),
            layout: "",
            state: stateCode || "",
            holes: 18,
          });
          if (card18NoLayout && Array.isArray(card18NoLayout.pars) && card18NoLayout.pars.length === 18) {
            pars = sliceParsForNineFromEighteen(card18NoLayout.pars, nineLoop);
          }
        }

        if (pars) {
          pars = pars.map((p) => (p === null || p === undefined || p === "" ? null : Number(p)));
        }
      }
    }

    const finalParMode = pars ? "published" : "blank";

    await db.query("BEGIN");

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, course, layout, state, holes, par_mode, created_at;
      `,
      [userId, String(course).trim(), layoutName, stateCode, holesNum, finalParMode]
    );

    const round = roundInsert.rows[0];

    for (let i = 1; i <= holesNum; i++) {
      const parVal = pars ? (Number.isFinite(Number(pars[i - 1])) ? Number(pars[i - 1]) : null) : null;

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
        VALUES ($1, $2, $3, NULL, NULL)
        ON CONFLICT (round_id, hole_number) DO NOTHING;
        `,
        [round.id, i, parVal]
      );
    }

    await db.query("COMMIT");

    const holesRows = await db.query(
      `
      SELECT hole_number, par, strokes, putts
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [round.id]
    );

    return res.json({
      ok: true,
      round,
      holes: holesRows.rows,
      scorecardUsed: !!pars,
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
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
      SELECT id, course, layout, state, holes, par_mode, created_at
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

    await db.query("BEGIN");

    for (const h of holes) {
      const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
      if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

      const parVal =
        h?.par === null || typeof h?.par === "undefined" || h?.par === ""
          ? null
          : Number(h.par);

      const strokesVal =
        h?.strokes === null || typeof h?.strokes === "undefined" || h?.strokes === ""
          ? null
          : Number(h.strokes);

      const puttsVal =
        h?.putts === null || typeof h?.putts === "undefined" || h?.putts === ""
          ? null
          : Number(h.putts);

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (round_id, hole_number) DO UPDATE SET
          par = EXCLUDED.par,
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts;
        `,
        [
          roundId,
          holeNum,
          Number.isFinite(parVal) ? parVal : null,
          Number.isFinite(strokesVal) ? strokesVal : null,
          Number.isFinite(puttsVal) ? puttsVal : null,
        ]
      );
    }

    await db.query("COMMIT");

    const data = await getRoundWithHoles(roundId);
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

    const { strokes, putts, par } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === ""
        ? null
        : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === ""
        ? null
        : Number(putts);

    const parVal =
      par === null || typeof par === "undefined" || par === ""
        ? null
        : Number(par);

    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
      VALUES ($1, $2, NULL, NULL, NULL)
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
        par = COALESCE($5, par)
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, strokes, putts;
      `,
      [
        roundId,
        holeNum,
        Number.isFinite(strokesVal) ? strokesVal : null,
        Number.isFinite(puttsVal) ? puttsVal : null,
        Number.isFinite(parVal) ? parVal : null,
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