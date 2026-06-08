// backend/friendsRoutes.js
import express from "express";
import db from "./db.js";

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
        u.email AS name
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

    await db.query(
      `
      INSERT INTO user_friends (
        requester_user_id,
        addressee_user_id,
        status
      )
      VALUES ($1, $2, 'pending')
      `,
      [requesterId, addresseeUserId]
    );

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
      return res.status(404).json({ ok: false, error: "request_not_found" });
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
        u.email AS name
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
        u.email AS name
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

export default router;