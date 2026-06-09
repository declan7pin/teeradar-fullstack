// backend/sharedRoundsRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = express.Router();
router.use(requireAuth);

router.post("/upcoming", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const {
      course,
      state,
      play_date,
      tee_time,
      holes = 18,
      notes = "",
    } = req.body || {};

    if (!userId) return res.status(401).json({ ok:false, error:"unauthorised" });
    if (!course || !play_date) {
      return res.status(400).json({ ok:false, error:"course_and_date_required" });
    }

    const result = await db.query(
      `
      INSERT INTO upcoming_rounds (
        user_id, course, state, play_date, tee_time, holes, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *;
      `,
      [
        userId,
        String(course).trim(),
        String(state || "").trim().toUpperCase() || null,
        play_date,
        tee_time || null,
        Number(holes) || 18,
        String(notes || "").trim() || null,
      ]
    );

    res.json({ ok:true, round: result.rows[0] });
  } catch (err) {
    console.error("POST /api/shared-rounds/upcoming error:", err);
    res.status(500).json({ ok:false, error:"internal_error" });
  }
});

router.get("/upcoming", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT *
      FROM upcoming_rounds
      WHERE user_id = $1
      ORDER BY play_date ASC, tee_time ASC NULLS LAST
      LIMIT 100;
      `,
      [userId]
    );

    res.json({ ok:true, rounds: rows });
  } catch (err) {
    console.error("GET /api/shared-rounds/upcoming error:", err);
    res.status(500).json({ ok:false, error:"internal_error" });
  }
});

router.post("/share", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const { upcoming_round_id, friend_user_ids = [] } = req.body || {};

    if (!upcoming_round_id) {
      return res.status(400).json({ ok:false, error:"missing_upcoming_round_id" });
    }

    const ownerCheck = await db.query(
      `
      SELECT id
      FROM upcoming_rounds
      WHERE id = $1 AND user_id = $2
      LIMIT 1;
      `,
      [Number(upcoming_round_id), userId]
    );

    if (!ownerCheck.rows.length) {
      return res.status(404).json({ ok:false, error:"round_not_found" });
    }

    const ids = Array.isArray(friend_user_ids)
      ? friend_user_ids.map(Number).filter(Number.isFinite)
      : [];

    let shared = 0;

    for (const friendId of ids) {
      const friendship = await db.query(
        `
        SELECT id
        FROM user_friends
        WHERE status = 'accepted'
          AND (
            (requester_user_id = $1 AND addressee_user_id = $2)
            OR
            (requester_user_id = $2 AND addressee_user_id = $1)
          )
        LIMIT 1;
        `,
        [userId, friendId]
      );

      if (!friendship.rows.length) continue;

      await db.query(
        `
        INSERT INTO upcoming_round_shares (
          upcoming_round_id, owner_user_id, shared_with_user_id
        )
        VALUES ($1,$2,$3)
        ON CONFLICT (upcoming_round_id, shared_with_user_id) DO NOTHING;
        `,
        [Number(upcoming_round_id), userId, friendId]
      );

      shared++;
    }

    res.json({ ok:true, shared });
  } catch (err) {
    console.error("POST /api/shared-rounds/share error:", err);
    res.status(500).json({ ok:false, error:"internal_error" });
  }
});

router.get("/shared-with-me", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT
        ur.*,
        s.shared_at,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS owner_name
      FROM upcoming_round_shares s
      JOIN upcoming_rounds ur ON ur.id = s.upcoming_round_id
      JOIN users u ON u.id = s.owner_user_id
      WHERE s.shared_with_user_id = $1
      ORDER BY ur.play_date ASC, ur.tee_time ASC NULLS LAST
      LIMIT 100;
      `,
      [userId]
    );

    res.json({ ok:true, rounds: rows });
  } catch (err) {
    console.error("GET /api/shared-rounds/shared-with-me error:", err);
    res.status(500).json({ ok:false, error:"internal_error" });
  }
});

export default router;