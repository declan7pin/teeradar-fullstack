// backend/socialRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/settings", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT id, email, display_name, profile_visibility
      FROM users
      WHERE id = $1
      LIMIT 1;
      `,
      [userId]
    );

    const user = rows[0] || null;

    res.json({
      ok: true,
      settings: {
        display_name: user?.display_name || "",
        profile_visibility: user?.profile_visibility || "friends",
      },
    });
  } catch (err) {
    console.error("GET /api/social/settings error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/settings", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const displayName = String(req.body?.display_name || "").trim().slice(0, 40);
    const visibility = String(req.body?.profile_visibility || "friends").trim();

    const allowed = new Set(["friends", "public", "private"]);
    const finalVisibility = allowed.has(visibility) ? visibility : "friends";

    const { rows } = await db.query(
      `
      UPDATE users
      SET
        display_name = $2,
        profile_visibility = $3
      WHERE id = $1
      RETURNING id, email, display_name, profile_visibility;
      `,
      [userId, displayName || null, finalVisibility]
    );

    res.json({
      ok: true,
      settings: rows[0] || null,
    });
  } catch (err) {
    console.error("POST /api/social/settings error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.get("/friend-activity", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT
        r.id AS round_id,
        r.user_id,
        r.course,
        r.layout,
        r.state,
        r.holes,
        r.created_at,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS display_name,
        COALESCE(SUM(rh.strokes), 0)::int AS total_score,
        COALESCE(SUM(rh.par), 0)::int AS total_par,
        COUNT(rh.id)::int AS holes_entered
      FROM rounds r
      JOIN users u ON u.id = r.user_id
      JOIN user_friends uf
        ON uf.status = 'accepted'
        AND (
          (uf.requester_user_id = $1 AND uf.addressee_user_id = r.user_id)
          OR
          (uf.addressee_user_id = $1 AND uf.requester_user_id = r.user_id)
        )
      LEFT JOIN round_holes rh ON rh.round_id = r.id
      WHERE COALESCE(u.profile_visibility, 'friends') IN ('friends', 'public')
      GROUP BY r.id, u.id
      ORDER BY r.created_at DESC
      LIMIT 50;
      `,
      [userId]
    );

    const activities = rows.map((r) => {
      const totalScore = Number(r.total_score || 0);
      const totalPar = Number(r.total_par || 0);
      const holesEntered = Number(r.holes_entered || 0);
      const holes = Number(r.holes || 0);
      const complete = holesEntered >= holes && totalScore > 0;
      const vsPar = complete && totalPar > 0 ? totalScore - totalPar : null;

      return {
        round_id: r.round_id,
        user_id: r.user_id,
        display_name: r.display_name,
        course: r.course,
        layout: r.layout,
        state: r.state,
        holes,
        created_at: r.created_at,
        activity_date: r.created_at,
        total_score: totalScore,
        score_vs_par: vsPar,
        complete,
        let activityText = "";

if (!complete) {
  activityText = `${r.display_name} started a round at ${r.course}`;
} else {
  activityText = `${r.display_name} shot ${totalScore} at ${r.course}`;

  // ✅ best score achievements
  if (holes === 18) {
    if (totalScore <= 79) {
      activityText += ` • New personal best 18-hole score`;
    }
  }

  if (holes === 9) {
    if (totalScore <= 39) {
      activityText += ` • New personal best 9-hole score`;
    }
  }

  // ✅ putting achievements
  const totalPutts =
    Number(r.total_putts || 0);

  if (holes === 18 && totalPutts > 0 && totalPutts <= 30) {
    activityText += ` • Best putting round`;
  }

  if (holes === 9 && totalPutts > 0 && totalPutts <= 15) {
    activityText += ` • Best putting round`;
  }
}
      };
    });

    res.json({ ok: true, activities });
  } catch (err) {
    console.error("GET /api/social/friend-activity error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;