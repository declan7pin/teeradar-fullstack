// backend/friendsRoutes.js
import express from "express";
import db from "./db.js";
import { sendMobilePushToEmail } from "./pushRoutes.js";

const router = express.Router();

/*
========================================
SEARCH USERS
GET /api/friends/search?q=email@example.com
========================================
*/
router.get("/search", async (req, res) => {
  try {
    const userId = req.user?.id;
    const q = String(req.query.q || "").trim().toLowerCase();

    if (!userId) {
      return res.status(401).json({ ok: false, error: "not_authenticated" });
    }

    if (!q || q.length < 3) {
      return res.json({ ok: true, users: [] });
    }

    const result = await db.query(
      `
      SELECT
        u.id,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), u.email) AS name
      FROM users u
      WHERE LOWER(u.email) LIKE LOWER($1)
        AND u.id <> $2
      ORDER BY u.email ASC
      LIMIT 10
      `,
      [`%${q}%`, userId]
    );

    res.json({ ok: true, users: result.rows || [] });
  } catch (e) {
    console.error("friends/search", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/*
========================================
SEND FRIEND REQUEST
POST /api/friends/request
========================================
*/
router.post("/request", async (req, res) => {
  try {
    const requesterId = req.user?.id;
    const { addresseeUserId } = req.body || {};

    if (!requesterId) {
      return res.status(401).json({ ok: false, error: "not_authenticated" });
    }

    if (!addresseeUserId) {
      return res.status(400).json({ ok: false, error: "missing_addressee" });
    }

    if (Number(requesterId) === Number(addresseeUserId)) {
      return res.status(400).json({ ok: false, error: "cannot_add_self" });
    }

    const existing = await db.query(
      `
      SELECT id, status
      FROM user_friends
      WHERE
        (requester_user_id = $1 AND addressee_user_id = $2)
        OR
        (requester_user_id = $2 AND addressee_user_id = $1)
      LIMIT 1
      `,
      [requesterId, addresseeUserId]
    );

    if (existing.rows?.length) {
      return res.json({
        ok: true,
        alreadyExists: true,
        status: existing.rows[0].status,
      });
    }

    const insertResult = await db.query(
      `
      INSERT INTO user_friends (
        requester_user_id,
        addressee_user_id,
        status
      )
      VALUES ($1, $2, 'pending')
      RETURNING id
      `,
      [requesterId, addresseeUserId]
    );

    const usersResult = await db.query(
      `
      SELECT
        requester.email AS requester_email,
        COALESCE(NULLIF(requester.display_name, ''), requester.email) AS requester_name,
        addressee.email AS addressee_email
      FROM users requester
      JOIN users addressee ON addressee.id = $2
      WHERE requester.id = $1
      LIMIT 1
      `,
      [requesterId, addresseeUserId]
    );

    const users = usersResult.rows?.[0];

    if (users?.addressee_email) {
      await sendMobilePushToEmail(users.addressee_email, {
        title: "New friend request",
        body: `${users.requester_name || "Someone"} sent you a friend request.`,
        url: "/friends.html",
        type: "FRIEND_REQUEST",
        meta: {
          requestId: insertResult.rows?.[0]?.id || null,
        },
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("friends/request", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/*
========================================
ACCEPT FRIEND REQUEST
POST /api/friends/accept
========================================
*/
router.post("/accept", async (req, res) => {
  try {
    const userId = req.user?.id;
    const { requestId } = req.body || {};

    if (!userId) {
      return res.status(401).json({ ok: false, error: "not_authenticated" });
    }

    if (!requestId) {
      return res.status(400).json({ ok: false, error: "missing_request_id" });
    }

    const result = await db.query(
      `
      UPDATE user_friends
      SET
        status = 'accepted',
        accepted_at = now()
      WHERE id = $1
        AND addressee_user_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [requestId, userId]
    );

    if (!result.rows?.length) {
      return res.status(404).json({
        ok: false,
        error: "request_not_found"
      });
    }

    const acceptedRequest = result.rows[0];

    const usersResult = await db.query(
      `
      SELECT
        requester.email AS requester_email,
        COALESCE(NULLIF(addressee.display_name, ''), addressee.email) AS addressee_name
      FROM user_friends uf
      JOIN users requester
        ON requester.id = uf.requester_user_id
      JOIN users addressee
        ON addressee.id = uf.addressee_user_id
      WHERE uf.id = $1
      LIMIT 1
      `,
      [acceptedRequest.id]
    );

    const users = usersResult.rows?.[0];

    if (users?.requester_email) {
      await sendMobilePushToEmail(users.requester_email, {
        title: "Friend request accepted",
        body: `${users.addressee_name || "Someone"} accepted your friend request.`,
        url: "/friends.html",
        type: "FRIEND_ACCEPTED",
        meta: {
          requestId: acceptedRequest.id
        }
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("friends/accept", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
/*
========================================
LIST PENDING REQUESTS SENT TO ME
GET /api/friends/requests
========================================
*/
router.get("/requests", async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ ok: false, error: "not_authenticated" });
    }

    const result = await db.query(
      `
      SELECT
        uf.id,
        uf.requester_user_id,
        uf.addressee_user_id,
        uf.status,
        uf.created_at,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), u.email) AS name
      FROM user_friends uf
      LEFT JOIN users u ON u.id = uf.requester_user_id
      WHERE uf.addressee_user_id = $1
        AND uf.status = 'pending'
      ORDER BY uf.created_at DESC
      `,
      [userId]
    );

    res.json({ ok: true, requests: result.rows || [] });
  } catch (e) {
    console.error("friends/requests", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/*
========================================
LIST ACCEPTED FRIENDS
GET /api/friends/list
========================================
*/
router.get("/list", async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ ok: false, error: "not_authenticated" });
    }

    const result = await db.query(
      `
      SELECT
        uf.id,
        uf.status,
        uf.accepted_at,
        CASE
          WHEN uf.requester_user_id = $1 THEN uf.addressee_user_id
          ELSE uf.requester_user_id
        END AS friend_user_id,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), u.email) AS name
      FROM user_friends uf
      JOIN users u
        ON u.id = CASE
          WHEN uf.requester_user_id = $1 THEN uf.addressee_user_id
          ELSE uf.requester_user_id
        END
      WHERE uf.status = 'accepted'
        AND ($1 IN (uf.requester_user_id, uf.addressee_user_id))
      ORDER BY uf.accepted_at DESC NULLS LAST, uf.created_at DESC
      `,
      [userId]
    );

    res.json({ ok: true, friends: result.rows || [] });
  } catch (e) {
    console.error("friends/list", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/*
========================================
LIVE FRIEND ROUNDS
GET /api/friends/live-rounds
========================================

A round is considered live when:
- it belongs to an accepted friend
- at least one hole has a score entered
- the full round has not been completed
- the round was created within the last 18 hours

Returns enough information for:
- Friends live-round list
- Home horizontal live-friends rail
========================================
*/
router.get("/live-rounds", async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "not_authenticated"
      });
    }

    const result = await db.query(
      `
      WITH accepted_friends AS (
        SELECT
          CASE
            WHEN uf.requester_user_id = $1
              THEN uf.addressee_user_id
            ELSE uf.requester_user_id
          END AS friend_user_id
        FROM user_friends uf
        WHERE uf.status = 'accepted'
          AND (
            uf.requester_user_id = $1
            OR uf.addressee_user_id = $1
          )
      ),

      round_progress AS (
        SELECT
          r.id AS round_id,
          r.user_id AS friend_user_id,
          r.course,
          r.layout,
          r.state,
          r.holes,
          r.created_at,

          COUNT(
            CASE
              WHEN rh.strokes IS NOT NULL
              THEN 1
            END
          )::int AS holes_played,

          COALESCE(
            SUM(
              CASE
                WHEN rh.strokes IS NOT NULL
                THEN rh.strokes
                ELSE 0
              END
            ),
            0
          )::int AS total_strokes,

          COALESCE(
            SUM(
              CASE
                WHEN rh.strokes IS NOT NULL
                  AND rh.par IS NOT NULL
                THEN rh.par
                ELSE 0
              END
            ),
            0
          )::int AS played_par,

          MAX(
            CASE
              WHEN rh.strokes IS NOT NULL
              THEN rh.hole_number
              ELSE NULL
            END
          )::int AS last_completed_hole,

          COALESCE(
            SUM(
              CASE
                WHEN rh.strokes IS NOT NULL
                  AND rh.putts IS NOT NULL
                THEN rh.putts
                ELSE 0
              END
            ),
            0
          )::int AS total_putts

        FROM rounds r

        JOIN accepted_friends af
          ON af.friend_user_id = r.user_id

        LEFT JOIN round_holes rh
          ON rh.round_id = r.id

        WHERE r.created_at >= NOW() - INTERVAL '10 hours'

        GROUP BY
          r.id,
          r.user_id,
          r.course,
          r.layout,
          r.state,
          r.holes,
          r.created_at
      )

      SELECT
        rp.round_id,
        rp.friend_user_id,

        COALESCE(
          NULLIF(u.display_name, ''),
          split_part(u.email, '@', 1)
        ) AS friend_name,

        rp.course,
        rp.layout,
        rp.state,
        rp.holes,
        rp.holes_played,
        rp.total_strokes,
        rp.played_par,
        rp.total_putts,
        rp.last_completed_hole,
        rp.created_at AS started_at

      FROM round_progress rp

      JOIN users u
        ON u.id = rp.friend_user_id

      WHERE rp.holes_played > 0

        /* Finished scorecards are no longer live */
        AND rp.holes_played < rp.holes

      ORDER BY rp.created_at DESC

      LIMIT 30;
      `,
      [userId]
    );

    const rounds = (result.rows || []).map((row) => {
      const holes = Number(row.holes || 18);
      const holesPlayed = Number(row.holes_played || 0);

      const lastCompletedHole =
        Number(row.last_completed_hole || 0);

      /*
       * If Hole 6 has just been entered, the golfer is now
       * considered to be playing Hole 7.
       */
      const currentHole = Math.min(
        Math.max(lastCompletedHole + 1, 1),
        holes
      );

      const totalStrokes =
        Number(row.total_strokes || 0);

      const playedPar =
        Number(row.played_par || 0);

      const scoreToPar =
        totalStrokes - playedPar;

      let scoreLabel = "E";

      if (scoreToPar > 0) {
        scoreLabel = `+${scoreToPar}`;
      } else if (scoreToPar < 0) {
        scoreLabel = String(scoreToPar);
      }

      return {
        round_id: Number(row.round_id),
        friend_user_id: Number(row.friend_user_id),

        friend_name:
          String(row.friend_name || "Friend"),

        course:
          String(row.course || "Golf Course"),

        layout:
          row.layout
            ? String(row.layout)
            : null,

        state:
          row.state
            ? String(row.state)
            : null,

        holes,
        holes_played: holesPlayed,

        last_completed_hole: lastCompletedHole,
        current_hole: currentHole,

        total_strokes: totalStrokes,
        total_putts: Number(row.total_putts || 0),

        score_to_par: scoreToPar,
        score_label: scoreLabel,

        started_at: row.started_at,

        is_live: true
      };
    });

    return res.json({
      ok: true,
      count: rounds.length,
      rounds
    });

  } catch (err) {
    console.error(
      "GET /api/friends/live-rounds error:",
      err
    );

    return res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: err?.message || String(err || "")
    });
  }
});

export default router;
