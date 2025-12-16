// backend/roundsRoutes.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import db from "./db.js";
import { requireAuth } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const roundsRouter = express.Router();

// -----------------------------------------
// Load scorecards (WA for now)
// -----------------------------------------
const SCORECARDS_PATH = path.join(__dirname, "data", "scorecards_wa.json");

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

let SCORECARDS = [];
try {
  if (fs.existsSync(SCORECARDS_PATH)) {
    SCORECARDS = JSON.parse(fs.readFileSync(SCORECARDS_PATH, "utf8")) || [];
  }
} catch (e) {
  console.error("❌ Failed to load scorecards_wa.json:", e?.message || e);
  SCORECARDS = [];
}

function findScorecard({ course, state, layout, holes }) {
  const c = norm(course);
  const s = norm(state);
  const l = norm(layout);
  const h = Number(holes);

  // Try exact match on course+state+layout+holes
  let hit = SCORECARDS.find((x) => {
    const xc = norm(x.course);
    const xs = norm(x.state);
    const xl = norm(x.layout);
    const xh = Number(x.holes);

    if (!xc || !xs || !xh) return false;

    const layoutOk =
      (l && xl && xl === l) ||
      (!l && !xl); // both empty ok

    return xc === c && xs === s && xh === h && layoutOk;
  });

  // Fallback: course+state+holes (ignore layout)
  if (!hit) {
    hit = SCORECARDS.find((x) => {
      const xc = norm(x.course);
      const xs = norm(x.state);
      const xh = Number(x.holes);
      return xc === c && xs === s && xh === h;
    });
  }

  if (!hit) return null;

  const pars = Array.isArray(hit.pars) ? hit.pars.map((n) => (n == null ? null : Number(n))) : null;
  if (!pars || pars.length !== h) return null;

  return { ...hit, pars };
}

// -----------------------------------------
// Helpers
// -----------------------------------------
async function fetchRoundOwned(roundId, userId) {
  const { rows } = await db.query(
    `
    SELECT *
    FROM rounds
    WHERE id = $1 AND user_id = $2
    LIMIT 1
    `,
    [Number(roundId), Number(userId)]
  );
  return rows[0] || null;
}

async function fetchRoundHoles(roundId) {
  const { rows } = await db.query(
    `
    SELECT hole_number, par, strokes, putts
    FROM round_holes
    WHERE round_id = $1
    ORDER BY hole_number ASC
    `,
    [Number(roundId)]
  );
  return rows;
}

// -----------------------------------------
// GET /api/rounds  (my rounds list)
// -----------------------------------------
roundsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await db.query(
      `
      SELECT id, course, layout, state, holes, par_mode, created_at
      FROM rounds
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [userId]
    );

    // Include holesData for each round (simple, ok at this scale)
    const rounds = [];
    for (const r of rows) {
      const holesData = await fetchRoundHoles(r.id);
      rounds.push({ ...r, holesData });
    }

    return res.json({ ok: true, rounds });
  } catch (err) {
    console.error("GET /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -----------------------------------------
// POST /api/rounds  (create round)
// Body: { course, layout?, state?, holes, par_mode? }
// par_mode optional: "published" or "blank" (if omitted, auto-detect)
// -----------------------------------------
roundsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      course,
      layout = null,
      state = null,
      holes,
      par_mode: requestedParMode = "",
    } = req.body || {};

    const holesNum = Number(holes);

    if (!course || !Number.isFinite(holesNum) || (holesNum !== 9 && holesNum !== 18)) {
      return res.status(400).json({ ok: false, error: "course and holes (9 or 18) are required" });
    }

    const scorecard = findScorecard({ course, state, layout, holes: holesNum });

    // Decide par mode:
    // - if client explicitly requests "blank" -> blank
    // - else if scorecard exists -> published
    // - else -> blank
    const forced = String(requestedParMode || "").toLowerCase();
    const parMode =
      forced === "blank" ? "blank" : scorecard ? "published" : "blank";

    // Create round
    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, course, layout, state, holes, par_mode, created_at
      `,
      [userId, course, layout, state, holesNum, parMode]
    );

    const round = roundInsert.rows[0];

    // Create hole rows
    const pars = (parMode === "published" && scorecard) ? scorecard.pars : null;

    for (let i = 1; i <= holesNum; i++) {
      const parVal = pars ? pars[i - 1] : null;

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
        VALUES ($1,$2,$3,NULL,NULL)
        ON CONFLICT (round_id, hole_number)
        DO NOTHING
        `,
        [round.id, i, parVal]
      );
    }

    const holesData = await fetchRoundHoles(round.id);

    return res.json({ ok: true, round: { ...round, holesData } });
  } catch (err) {
    console.error("POST /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -----------------------------------------
// GET /api/rounds/:id  (single round + holes)
// -----------------------------------------
roundsRouter.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const roundId = Number(req.params.id);

    const round = await fetchRoundOwned(roundId, userId);
    if (!round) return res.status(404).json({ ok: false, error: "round not found" });

    const holesData = await fetchRoundHoles(roundId);

    return res.json({ ok: true, round: { ...round, holesData } });
  } catch (err) {
    console.error("GET /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -----------------------------------------
// PUT /api/rounds/:id  (update strokes/putts and optionally par if blank mode)
// Body: { holes: [{ hole_number, strokes, putts, par? }, ...] }
// -----------------------------------------
roundsRouter.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const roundId = Number(req.params.id);

    const round = await fetchRoundOwned(roundId, userId);
    if (!round) return res.status(404).json({ ok: false, error: "round not found" });

    const holes = Array.isArray(req.body?.holes) ? req.body.holes : [];
    if (!holes.length) return res.json({ ok: true, updated: 0 });

    let updated = 0;

    for (const h of holes) {
      const holeNum = Number(h.hole_number);
      if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

      const strokes =
        h.strokes === null || typeof h.strokes === "undefined" ? null : Number(h.strokes);
      const putts =
        h.putts === null || typeof h.putts === "undefined" ? null : Number(h.putts);

      // Only allow editing par if round is blank mode
      const parAllowed = (round.par_mode === "blank");
      const par =
        parAllowed && !(h.par === null || typeof h.par === "undefined")
          ? Number(h.par)
          : undefined;

      if (!Number.isFinite(strokes) && strokes !== null) continue;
      if (!Number.isFinite(putts) && putts !== null) continue;
      if (typeof par !== "undefined" && !Number.isFinite(par)) continue;

      if (typeof par === "undefined") {
        const r = await db.query(
          `
          UPDATE round_holes
          SET strokes = $3,
              putts = $4
          WHERE round_id = $1 AND hole_number = $2
          `,
          [roundId, holeNum, strokes, putts]
        );
        updated += r.rowCount || 0;
      } else {
        const r = await db.query(
          `
          UPDATE round_holes
          SET par = $3,
              strokes = $4,
              putts = $5
          WHERE round_id = $1 AND hole_number = $2
          `,
          [roundId, holeNum, par, strokes, putts]
        );
        updated += r.rowCount || 0;
      }
    }

    const holesData = await fetchRoundHoles(roundId);

    return res.json({ ok: true, updated, round: { ...round, holesData } });
  } catch (err) {
    console.error("PUT /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default roundsRouter;