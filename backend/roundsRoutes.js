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

// -------------------------------------------------
// Routes (ALL require login)
// -------------------------------------------------

// Create a new round + seed holes (pars if available; otherwise blank)
router.post("/create", requireAuth, async (req, res) => {
  const userId = req.user?.id;

  try {
    const {
      course,
      layout = null,
      state = null,
      holes = 18,
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

    // Find a matching scorecard (if any)
    const card = findScorecard({
      course: String(course),
      layout: layoutName || "",
      state: stateCode || "",
      holes: holesNum,
    });

    const pars =
      card && Array.isArray(card.pars) && card.pars.length === holesNum
        ? card.pars.map((p) => (p === null || p === undefined ? null : Number(p)))
        : null;

    const parMode = pars ? "published" : "blank";

    await db.query("BEGIN");

    const roundInsert = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, course, layout, state, holes, par_mode, created_at;
      `,
      [userId, String(course).trim(), layoutName, stateCode, holesNum, parMode]
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
      scorecardUsed: !!pars,
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("rounds/create error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// List my rounds
router.get("/mine", requireAuth, async (req, res) => {
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
    console.error("rounds/mine error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
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

    const roundRow = await db.query(
      `
      SELECT id, user_id, course, layout, state, holes, par_mode, created_at
      FROM rounds
      WHERE id = $1
      LIMIT 1;
      `,
      [roundId]
    );

    if (!roundRow.rows.length) {
      return res.status(404).json({ ok: false, error: "round not found" });
    }

    const round = roundRow.rows[0];

    if (round.user_id !== userId) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const holesRows = await db.query(
      `
      SELECT hole_number, par, strokes, putts
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [roundId]
    );

    return res.json({ ok: true, round, holes: holesRows.rows });
  } catch (err) {
    console.error("rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Update a single hole (strokes + putts)
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
    console.error("rounds delete error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;