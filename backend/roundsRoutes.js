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
// ✅ Ensure optional rounds columns exist (front/back 9 support)
// (kept here so you don't have to touch server.js)
// -------------------------------------------------
let __roundsColsEnsured = false;
async function ensureRoundsExtraColumnsOnce() {
  if (__roundsColsEnsured) return;
  __roundsColsEnsured = true;
  try {
    // Used only when holes=9 and scorecard only has 18 pars
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS nine_loop TEXT;
    `);
  } catch (e) {
    // don't crash if permissions differ; feature will just fallback to front 9
  }
}

// -------------------------------------------------
// Scorecards loader (static JSON files in backend/data/scorecards)
// -------------------------------------------------
let __scorecardsCache = null;

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalise(s) {
  return (s || "").toString().trim().toLowerCase();
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
      const data = safeJsonParse(raw, []);

      if (Array.isArray(data)) {
        for (const item of data) out.push(item);
      }
    }

    console.log(`✅ loaded ${out.length} scorecards from ${baseDir}`);
  } catch (err) {
    console.error("❌ failed loading scorecards:", err?.message || err);
  }

  __scorecardsCache = out;
  return __scorecardsCache;
}

function findScorecard({ course, layout, state, holes }) {
  const cards = loadScorecardsOnce();

  const wantCourse = normalise(course);
  const wantLayout = normalise(layout);
  const wantState = normalise(state);
  const wantHoles = Number(holes);

  // 1) Try exact match: course + state + layout + holes
  let match =
    cards.find((c) => {
      const cCourse = normalise(c.course);
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
      const cCourse = normalise(c.course);
      const cState = normalise(c.state);
      const cHoles = Number(c.holes);

      return (
        cCourse === wantCourse &&
        cState === wantState &&
        Number.isFinite(cHoles) &&
        cHoles === wantHoles
      );
    }) || null;

  if (match) return match;

  // 3) Special: if user wants 9, but only 18 exists in scorecards, allow that (we'll slice front/back)
  if (wantHoles === 9) {
    match =
      cards.find((c) => {
        const cCourse = normalise(c.course);
        const cState = normalise(c.state);
        const cHoles = Number(c.holes);

        return (
          cCourse === wantCourse &&
          cState === wantState &&
          Number.isFinite(cHoles) &&
          cHoles === 18
        );
      }) || null;

    if (match) return match;
  }

  return null;
}

function coerceParsArray(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.map((p) => (p === null || p === undefined || p === "" ? null : Number(p)));
}

function sliceParsForNineLoop(pars18, nineLoop) {
  // nineLoop: "front" | "back"
  const loop = (nineLoop || "").toString().trim().toLowerCase();
  if (!Array.isArray(pars18) || pars18.length !== 18) return null;
  if (loop === "back") return pars18.slice(9, 18);
  return pars18.slice(0, 9); // default front
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

async function listRoundsWithHoles(userId) {
  const { rows } = await db.query(
    `
    SELECT
      r.id,
      r.course,
      r.layout,
      r.state,
      r.holes,
      r.par_mode,
      r.nine_loop,
      r.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'hole_number', h.hole_number,
            'par', h.par,
            'strokes', h.strokes,
            'putts', h.putts
          )
          ORDER BY h.hole_number
        ) FILTER (WHERE h.id IS NOT NULL),
        '[]'::json
      ) AS "holesData"
    FROM rounds r
    LEFT JOIN round_holes h
      ON h.round_id = r.id
    WHERE r.user_id = $1
    GROUP BY r.id
    ORDER BY r.created_at DESC
    LIMIT 200;
    `,
    [userId]
  );

  // Ensure holesData is a real array for the frontend
  return (rows || []).map((r) => ({
    ...r,
    holesData: Array.isArray(r.holesData) ? r.holesData : safeJsonParse(r.holesData, []),
  }));
}

async function getRoundWithHoles(roundId) {
  const roundRow = await db.query(
    `
    SELECT id, user_id, course, layout, state, holes, par_mode, nine_loop, created_at
    FROM rounds
    WHERE id = $1
    LIMIT 1;
    `,
    [Number(roundId)]
  );

  if (!roundRow.rows.length) return { round: null, holes: [] };

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
// Routes (ALL require login)
// -------------------------------------------------

// ✅ NEW: List my rounds (matches frontend: GET /api/rounds)
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    await ensureRoundsExtraColumnsOnce();
    const rounds = await listRoundsWithHoles(userId);
    return res.json({ ok: true, rounds });
  } catch (err) {
    console.error("rounds GET / error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Backwards compat: /mine (older clients)
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    await ensureRoundsExtraColumnsOnce();
    const rounds = await listRoundsWithHoles(userId);
    return res.json({ ok: true, rounds });
  } catch (err) {
    console.error("rounds/mine error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ✅ NEW: Create a round (matches frontend: POST /api/rounds)
// Accepts either:
// - publishedPars: array from frontend (your my-rounds.html sends this when available)
// - OR backend will look up scorecards and seed pars automatically
router.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.id;

  try {
    await ensureRoundsExtraColumnsOnce();

    const {
      course,
      layout = null,
      state = null,
      holes = 18,

      // frontend may send this:
      publishedPars = null,

      // optional: if holes=9 but scorecard only has 18 pars
      // "front" | "back"
      nineLoop = null,

      // optional (if you later send it)
      par_mode = null,
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
    const nineLoopVal = (nineLoop || "").toString().trim().toLowerCase() || null;

    // 1) Prefer pars provided by frontend
    let pars = null;
    if (Array.isArray(publishedPars)) {
      const coerced = coerceParsArray(publishedPars);
      if (coerced && coerced.length === holesNum) pars = coerced;
    }

    // 2) Otherwise load from scorecards on backend
    if (!pars) {
      const card = findScorecard({
        course: String(course),
        layout: layoutName || "",
        state: stateCode || "",
        holes: holesNum,
      });

      if (card && Array.isArray(card.pars)) {
        const coerced = coerceParsArray(card.pars);

        // If the matched card is 18 but the user created 9, slice front/back
        if (holesNum === 9 && Array.isArray(coerced) && coerced.length === 18) {
          pars = sliceParsForNineLoop(coerced, nineLoopVal);
        } else if (Array.isArray(coerced) && coerced.length === holesNum) {
          pars = coerced;
        }
      }
    }

    const parMode =
      (par_mode || "").toString().trim().toLowerCase() ||
      (pars ? "published" : "blank");

    await db.query("BEGIN");

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode, nine_loop)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id, course, layout, state, holes, par_mode, nine_loop, created_at;
      `,
      [
        userId,
        String(course).trim(),
        layoutName,
        stateCode,
        holesNum,
        parMode,
        holesNum === 9 ? (nineLoopVal || "front") : null,
      ]
    );

    const round = roundInsert.rows[0];

    // Seed holes 1..holes
    for (let i = 1; i <= holesNum; i++) {
      const parVal = pars ? (Number.isFinite(pars[i - 1]) ? pars[i - 1] : null) : null;

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
      roundId: round.id, // nice-to-have alias
      scorecardUsed: !!pars,
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("rounds POST / error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err.message });
  }
});

// Backwards compat: /create (older clients)
router.post("/create", requireAuth, async (req, res) => {
  // just forward to the new POST "/"
  req.url = "/";
  return router.handle(req, res);
});

// Get one round + holes (must own it)  (matches frontend: GET /api/rounds/:id)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    await ensureRoundsExtraColumnsOnce();

    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const { round, holes } = await getRoundWithHoles(roundId);

    if (!round) {
      return res.status(404).json({ ok: false, error: "round not found" });
    }
    if (round.user_id !== userId) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    return res.json({ ok: true, round, holes, holesData: holes });
  } catch (err) {
    console.error("rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ✅ NEW: Bulk save (matches frontend: PUT /api/rounds/:id with {holes:[...]})
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

    const { holes = [] } = req.body || {};
    const arr = Array.isArray(holes) ? holes : [];

    await db.query("BEGIN");

    for (const h of arr) {
      const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
      if (!Number.isFinite(holeNum) || holeNum <= 0 || holeNum > 18) continue;

      // allow 0 (pickup/chipped in mapped to 0)
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

      if (parVal !== null && !Number.isFinite(parVal)) continue;
      if (strokesVal !== null && (!Number.isFinite(strokesVal) || strokesVal < 0 || strokesVal > 25)) continue;
      if (puttsVal !== null && (!Number.isFinite(puttsVal) || puttsVal < 0 || puttsVal > 10)) continue;

      // Upsert, preserving existing par if null provided
      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (round_id, hole_number)
        DO UPDATE SET
          par = COALESCE(EXCLUDED.par, round_holes.par),
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts;
        `,
        [roundId, holeNum, parVal, strokesVal, puttsVal]
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
      [roundId]
    );

    return res.json({ ok: true, holes: holesRows.rows || [] });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("rounds PUT /:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Update a single hole (strokes + putts) (kept for backwards compat)
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

    const { strokes, putts } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === ""
        ? null
        : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === ""
        ? null
        : Number(putts);

    if (strokesVal !== null && (!Number.isFinite(strokesVal) || strokesVal < 0 || strokesVal > 25)) {
      return res.status(400).json({ ok: false, error: "invalid strokes" });
    }
    if (puttsVal !== null && (!Number.isFinite(puttsVal) || puttsVal < 0 || puttsVal > 10)) {
      return res.status(400).json({ ok: false, error: "invalid putts" });
    }

    // Ensure hole row exists, then update
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
      SET strokes = $3,
          putts = $4
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, strokes, putts;
      `,
      [roundId, holeNum, strokesVal, puttsVal]
    );

    return res.json({ ok: true, hole: result.rows[0] || null });
  } catch (err) {
    console.error("rounds update hole error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Delete a round (must own it) (matches frontend: DELETE /api/rounds/:id)
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
    console.error("rounds delete error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;