// backend/sharedRoundsRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";
import { sendPushToEmail } from "./pushRoutes.js";

const router = express.Router();
router.use(requireAuth);

function cleanText(v) {
  return String(v || "").trim();
}

function cleanState(v) {
  return String(v || "").trim().toUpperCase() || null;
}
function upcomingTimeFilterSql(alias = "ur") {
  return `
    AND (
      ${alias}.tee_time IS NULL
      OR (
        (
          ${alias}.play_date::date
          + ${alias}.tee_time::time
          + INTERVAL '20 minutes'
        ) >= now()
      )
    )
  `;
}

async function getRoundParticipants(upcomingRoundId) {
  const { rows } = await db.query(
    `
    SELECT
      u.id,
      u.email,
      COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
      CASE WHEN ur.user_id = u.id THEN true ELSE false END AS is_owner
    FROM upcoming_rounds ur
    JOIN users u ON u.id = ur.user_id
    WHERE ur.id = $1

    UNION ALL

    SELECT
      u.id,
      u.email,
      COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
      false AS is_owner
    FROM upcoming_round_shares s
    JOIN users u ON u.id = s.shared_with_user_id
    WHERE s.upcoming_round_id = $1

    ORDER BY is_owner DESC, name ASC;
    `,
    [Number(upcomingRoundId)]
  );

  return rows || [];
}

async function attachParticipants(rounds) {
  const out = [];

  for (const r of rounds || []) {
    const participants = await getRoundParticipants(r.id);
    out.push({
      ...r,
      participants,
      players_count: participants.length || 1,
      player_names: participants.map((p) => p.name || p.email || "Player"),
      player_user_ids: participants.map((p) => Number(p.id)).filter(Number.isFinite),
    });
  }

  return out;
}

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

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    if (!cleanText(course) || !cleanText(play_date)) {
      return res.status(400).json({ ok: false, error: "course_and_date_required" });
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
        cleanText(course),
        cleanState(state),
        cleanText(play_date),
        cleanText(tee_time) || null,
        Number(holes) || 18,
        cleanText(notes) || null,
      ]
    );

    const round = result.rows[0];
    const participants = await getRoundParticipants(round.id);

    res.json({
      ok: true,
      round: {
        ...round,
        is_shared: false,
        owner_name: null,
        participants,
        players_count: participants.length || 1,
        player_names: participants.map((p) => p.name || p.email || "Player"),
        player_user_ids: participants.map((p) => Number(p.id)).filter(Number.isFinite),
      },
    });
  } catch (err) {
    console.error("POST /api/shared-rounds/upcoming error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.get("/upcoming", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const includeShared = String(req.query.includeShared || "") === "1";

    if (!includeShared) {
      const { rows } = await db.query(
        `
        SELECT
          ur.*,
          false AS is_shared,
          NULL::text AS owner_name,
          NULL::timestamp AS shared_at
        FROM upcoming_rounds ur
        WHERE ur.user_id = $1
        ${upcomingTimeFilterSql("ur")}
        ORDER BY ur.play_date ASC, ur.tee_time ASC NULLS LAST
        LIMIT 100;
        `,
        [userId]
      );

      return res.json({ ok: true, rounds: await attachParticipants(rows) });
    }

    const { rows } = await db.query(
      `
      SELECT *
      FROM (
        SELECT
          ur.*,
          false AS is_shared,
          NULL::text AS owner_name,
          NULL::timestamp AS shared_at
        FROM upcoming_rounds ur
        WHERE ur.user_id = $1
        ${upcomingTimeFilterSql("ur")}

        UNION ALL

        SELECT
          ur.*,
          true AS is_shared,
          COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS owner_name,
          s.shared_at
        FROM upcoming_round_shares s
        JOIN upcoming_rounds ur ON ur.id = s.upcoming_round_id
        JOIN users u ON u.id = s.owner_user_id
        WHERE s.shared_with_user_id = $1
       ${upcomingTimeFilterSql("ur")}
      ) x
      ORDER BY play_date ASC, tee_time ASC NULLS LAST
      LIMIT 100;
      `,
      [userId]
    );

    res.json({ ok: true, rounds: await attachParticipants(rows) });
  } catch (err) {
    console.error("GET /api/shared-rounds/upcoming error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/share", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const { upcoming_round_id, friend_user_ids = [] } = req.body || {};

    if (!upcoming_round_id) {
      return res.status(400).json({ ok: false, error: "missing_upcoming_round_id" });
    }

    const ownerCheck = await db.query(
      `
      SELECT id, course
      FROM upcoming_rounds
      WHERE id = $1 AND user_id = $2
      LIMIT 1;
      `,
      [Number(upcoming_round_id), userId]
    );

    if (!ownerCheck.rows.length) {
      return res.status(404).json({ ok: false, error: "round_not_found" });
    }

    const ids = Array.isArray(friend_user_ids)
      ? friend_user_ids.map(Number).filter(Number.isFinite)
      : [];

    let shared = 0;
    let notificationsSent = 0;

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

      const insertShare = await db.query(
        `
        INSERT INTO upcoming_round_shares (
          upcoming_round_id, owner_user_id, shared_with_user_id
        )
        VALUES ($1,$2,$3)
        ON CONFLICT (upcoming_round_id, shared_with_user_id) DO NOTHING
        RETURNING id;
        `,
        [Number(upcoming_round_id), userId, friendId]
      );

      if (!insertShare.rows.length) continue;

      shared++;

      try {
        const notifyRes = await db.query(
          `
          SELECT
            ur.course,
            friend.email AS friend_email,
            COALESCE(NULLIF(owner.display_name, ''), split_part(owner.email, '@', 1)) AS owner_name
          FROM upcoming_rounds ur
          JOIN users friend ON friend.id = $2
          JOIN users owner ON owner.id = ur.user_id
          WHERE ur.id = $1
          LIMIT 1;
          `,
          [Number(upcoming_round_id), friendId]
        );

        const n = notifyRes.rows[0];

        if (n?.friend_email && typeof sendPushToEmail === "function") {
          const pushResult = await sendPushToEmail(n.friend_email, {
            title: "Upcoming round shared",
            body: `${n.owner_name || "A friend"} shared ${n.course || "a round"} with you.`,
            url: "/my-rounds.html",
          });

          notificationsSent += Number(pushResult?.sent || 0);
        }
      } catch (pushErr) {
        console.warn("Upcoming round push notification failed:", pushErr?.message || pushErr);
      }
    }

    res.json({ ok: true, shared, notificationsSent });
  } catch (err) {
    console.error("POST /api/shared-rounds/share error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.get("/shared-with-me", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT
        ur.*,
        true AS is_shared,
        s.shared_at,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS owner_name
      FROM upcoming_round_shares s
      JOIN upcoming_rounds ur ON ur.id = s.upcoming_round_id
      JOIN users u ON u.id = s.owner_user_id
      WHERE s.shared_with_user_id = $1
      ${upcomingTimeFilterSql("ur")}
      ORDER BY ur.play_date ASC, ur.tee_time ASC NULLS LAST
      LIMIT 100;
      `,
      [userId]
    );

    res.json({ ok: true, rounds: await attachParticipants(rows) });
  } catch (err) {
    console.error("GET /api/shared-rounds/shared-with-me error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.delete("/upcoming/:id", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "invalid_round_id" });
    }

    await db.query(
      `
      DELETE FROM upcoming_round_shares
      WHERE upcoming_round_id = $1
        AND owner_user_id = $2;
      `,
      [id, userId]
    );

    const result = await db.query(
      `
      DELETE FROM upcoming_rounds
      WHERE id = $1
        AND user_id = $2
      RETURNING id;
      `,
      [id, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "round_not_found" });
    }

    res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error("DELETE /api/shared-rounds/upcoming/:id error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.delete("/shared-with-me/:id", async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ ok: false, error: "invalid_round_id" });
    }

    const result = await db.query(
      `
      DELETE FROM upcoming_round_shares
      WHERE upcoming_round_id = $1
        AND shared_with_user_id = $2
      RETURNING id;
      `,
      [id, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "shared_round_not_found" });
    }

    res.json({ ok: true, removedId: id });
  } catch (err) {
    console.error("DELETE /api/shared-rounds/shared-with-me/:id error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
