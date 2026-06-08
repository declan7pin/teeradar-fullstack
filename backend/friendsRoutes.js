// backend/friendsRoutes.js
import express from "express";
import db from "./db.js";

const router = express.Router();

/*
  IMPORTANT:
  This assumes req.user.id exists from your auth middleware.
  If your auth uses another field name, we’ll adjust later.
*/

/*
========================================
SEND FRIEND REQUEST
POST /api/friends/request
========================================
*/
router.post("/request", (req, res) => {
  try {
    const requesterId = req.user?.id;
    const { addresseeUserId } = req.body;

    if (!requesterId) {
      return res.status(401).json({
        ok: false,
        error: "not_authenticated",
      });
    }

    if (!addresseeUserId) {
      return res.status(400).json({
        ok: false,
        error: "missing_addressee",
      });
    }

    if (Number(requesterId) === Number(addresseeUserId)) {
      return res.status(400).json({
        ok: false,
        error: "cannot_add_self",
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM user_friends
      WHERE requester_user_id = ?
      AND addressee_user_id = ?
    `).get(requesterId, addresseeUserId);

    if (existing) {
      return res.json({
        ok: true,
        alreadyExists: true,
      });
    }

    db.prepare(`
      INSERT INTO user_friends (
        requester_user_id,
        addressee_user_id,
        status
      )
      VALUES (?, ?, 'pending')
    `).run(requesterId, addresseeUserId);

    res.json({ ok: true });
  } catch (e) {
    console.error("friends/request", e);

    res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

/*
========================================
ACCEPT FRIEND REQUEST
POST /api/friends/accept
========================================
*/
router.post("/accept", (req, res) => {
  try {
    const userId = req.user?.id;
    const { requestId } = req.body;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: "not_authenticated",
      });
    }

    const request = db.prepare(`
      SELECT *
      FROM user_friends
      WHERE id = ?
      AND addressee_user_id = ?
      AND status = 'pending'
    `).get(requestId, userId);

    if (!request) {
      return res.status(404).json({
        ok: false,
        error: "request_not_found",
      });
    }

    db.prepare(`
      UPDATE user_friends
      SET
        status = 'accepted',
        accepted_at = datetime('now')
      WHERE id = ?
    `).run(requestId);

    res.json({ ok: true });
  } catch (e) {
    console.error("friends/accept", e);

    res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

/*
========================================
LIST MY FRIENDS
GET /api/friends/list
========================================
*/
router.get("/list", (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: "not_authenticated",
      });
    }

    const friends = db.prepare(`
      SELECT *
      FROM user_friends
      WHERE status = 'accepted'
      AND (
        requester_user_id = ?
        OR addressee_user_id = ?
      )
      ORDER BY accepted_at DESC
    `).all(userId, userId);

    res.json({
      ok: true,
      friends,
    });
  } catch (e) {
    console.error("friends/list", e);

    res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

export default router;