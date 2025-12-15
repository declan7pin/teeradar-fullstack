// backend/roundsRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const roundsRouter = express.Router();

// ✅ helper: ensure notes + updated_at columns exist (safe on older DBs)
async function ensureRoundsColumns() {
  try {
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS notes TEXT;
    `);
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    `);
  } catch (err) {
    console.error("❌ ensureRoundsColumns error:", err?.message || err);
  }
}
ensureRoundsColumns();

// -------------------------------------------------
// GET /api/rounds  (logged-in user's rounds)
// returns: { ok:true, rounds:[{... , holesData:[...] }] }
// -------------------------------------------------
roundsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    const { rows } = await db.query(
      `
      SELECT
        r.id,
        r.user_id,
        r.course,
        r.layout,
        r.state,
        r.holes,
        r.par_mode,
        r.notes,
        r.created_at,
        r.updated_at
      FROM rounds r
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 200
      `,
      [userId]
    );

    const ids = rows.map((r) => r.id);

    let holesByRound = new Map();
    if (ids.length) {
      const holesRes = await db.query(
        `
        SELECT round_id, hole_number, par, strokes, putts
        FROM round_holes
        WHERE round_id = ANY($1::int[])
        ORDER BY round_id, hole_number
        `,
        [ids]
      );

      holesByRound = new Map();
      for (const h of holesRes.rows) {
        if (!holesByRound.has(h.round_id)) holesByRound.set(h.round_id, []);
        holesByRound.get(h.round_id).push({
          hole_number: h.hole_number,
          par: h.par,
          strokes: h.strokes,
          putts: h.putts,
        });
      }
    }

    const rounds = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      course: r.course,
      layout: r.layout,
      state: r.state,
      holes: r.holes,
      par_mode: r.par_mode,
      notes: r.notes || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      holesData: holesByRound.get(r.id) || [],
    }));

    return res.json({ ok: true, rounds });
  } catch (err) {
    console.error("GET /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -------------------------------------------------
// GET /api/rounds/:id  (single round + holes)
// -------------------------------------------------
roundsRouter.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const roundRes = await db.query(
      `
      SELECT id, user_id, course, layout, state, holes, par_mode, notes, created_at, updated_at
      FROM rounds
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [roundId, userId]
    );

    if (!roundRes.rows.length) {
      return res.status(404).json({ ok: false, error: "round not found" });
    }

    const r = roundRes.rows[0];

    const holesRes = await db.query(
      `
      SELECT hole_number, par, strokes, putts
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number
      `,
      [roundId]
    );

    return res.json({
      ok: true,
      round: {
        id: r.id,
        user_id: r.user_id,
        course: r.course,
        layout: r.layout,
        state: r.state,
        holes: r.holes,
        par_mode: r.par_mode,
        notes: r.notes || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        holesData: holesRes.rows.map((h) => ({
          hole_number: h.hole_number,
          par: h.par,
          strokes: h.strokes,
          putts: h.putts,
        })),
      },
    });
  } catch (err) {
    console.error("GET /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -------------------------------------------------
// POST /api/rounds  (create round)
// body: { course, state, holes, layout?, par_mode, notes? }
// -------------------------------------------------
roundsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    const {
      course,
      state,
      holes,
      layout = null,
      par_mode = "published",
      notes = null,
    } = req.body || {};

    const courseName = String(course || "").trim();
    const stateCode = String(state || "").trim().toUpperCase();
    const holesNum = Number(holes);

    if (!courseName) return res.status(400).json({ ok: false, error: "course is required" });
    if (!Number.isFinite(holesNum) || ![9, 18].includes(holesNum)) {
      return res.status(400).json({ ok: false, error: "holes must be 9 or 18" });
    }
    if (!["published", "blank"].includes(String(par_mode))) {
      return res.status(400).json({ ok: false, error: "par_mode must be published or blank" });
    }

    const roundRes = await db.query(
      `
      INSERT INTO rounds (user_id, course, layout, state, holes, par_mode, notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
      RETURNING id
      `,
      [
        userId,
        courseName,
        layout ? String(layout).trim() : null,
        stateCode || null,
        holesNum,
        String(par_mode),
        notes ? String(notes).trim() : null,
      ]
    );

    const roundId = roundRes.rows[0]?.id;

    // Pre-create hole rows so UI always has a row for each hole
    const insertRows = [];
    for (let i = 1; i <= holesNum; i++) {
      insertRows.push([roundId, i, null, null, null]);
    }

    // bulk insert with UNNEST
    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
      SELECT * FROM UNNEST (
        $1::int[],
        $2::int[],
        $3::int[],
        $4::int[],
        $5::int[]
      )
      `,
      [
        insertRows.map((r) => r[0]),
        insertRows.map((r) => r[1]),
        insertRows.map((r) => r[2]),
        insertRows.map((r) => r[3]),
        insertRows.map((r) => r[4]),
      ]
    );

    return res.json({ ok: true, roundId });
  } catch (err) {
    console.error("POST /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -------------------------------------------------
// PUT /api/rounds/:id  (update holes + optional notes)
// body: { holes:[{hole_number, par, strokes, putts}], notes? }
// -------------------------------------------------
roundsRouter.put("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    // ownership check
    const own = await db.query(
      `SELECT id, holes FROM rounds WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [roundId, userId]
    );
    if (!own.rows.length) {
      return res.status(404).json({ ok: false, error: "round not found" });
    }

    const holesCount = Number(own.rows[0].holes) || 18;

    const { holes = [], notes } = req.body || {};
    const arr = Array.isArray(holes) ? holes : [];

    // Upsert each hole (safe/simple)
    for (const h of arr) {
      const holeNum = Number(h.hole_number);
      if (!Number.isInteger(holeNum) || holeNum < 1 || holeNum > holesCount) continue;

      const par = h.par === null || h.par === "" ? null : Number(h.par);
      const strokes = h.strokes === null || h.strokes === "" ? null : Number(h.strokes);
      const putts = h.putts === null || h.putts === "" ? null : Number(h.putts);

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, strokes, putts)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (round_id, hole_number) DO UPDATE SET
          par = EXCLUDED.par,
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts
        `,
        [
          roundId,
          holeNum,
          Number.isFinite(par) ? par : null,
          Number.isFinite(strokes) ? strokes : null,
          Number.isFinite(putts) ? putts : null,
        ]
      );
    }

    // optional notes update
    if (typeof notes !== "undefined") {
      await db.query(
        `
        UPDATE rounds
        SET notes = $2,
            updated_at = now()
        WHERE id = $1 AND user_id = $3
        `,
        [roundId, notes ? String(notes).trim() : null, userId]
      );
    } else {
      await db.query(
        `
        UPDATE rounds
        SET updated_at = now()
        WHERE id = $1 AND user_id = $2
        `,
        [roundId, userId]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// -------------------------------------------------
// DELETE /api/rounds/:id
// -------------------------------------------------
roundsRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.id);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const result = await db.query(
      `DELETE FROM rounds WHERE id = $1 AND user_id = $2`,
      [roundId, userId]
    );

    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: "round not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default roundsRouter;
