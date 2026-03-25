// backend/groupVotesRoutes.js
import express from "express";
import crypto from "crypto";
import db from "./db.js";
import { requireAuth as requireUser } from "./auth.js";
import * as pgAnalytics from "./analytics.js";

const router = express.Router();

function makePublicId() {
  return "gv_" + crypto.randomBytes(6).toString("base64url");
}

function normalizeText(v, max = 500) {
  return String(v || "").trim().slice(0, max);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function isValidTime(s) {
  return /^\d{2}:\d{2}$/.test(String(s || ""));
}

function isSafeBookingUrl(u) {
  if (!u) return true;
  const s = String(u).trim();
  return s.startsWith("/") || s.startsWith("http://") || s.startsWith("https://");
}

async function getVoteFull(publicId, viewerUserId = null) {
  const voteRes = await db.query(
    `
    SELECT
      gv.id,
      gv.public_id,
      gv.creator_user_id,
      gv.title,
      gv.note,
      gv.status,
      gv.expires_at,
      gv.selected_option_id,
      gv.created_at,
      COALESCE(u.email, 'TeeRadar User') AS creator_name
    FROM group_votes gv
    LEFT JOIN users u ON u.id = gv.creator_user_id
    WHERE gv.public_id = $1
    LIMIT 1
    `,
    [publicId]
  );

  const vote = voteRes.rows[0];
  if (!vote) return null;

  const optionsRes = await db.query(
    `
    SELECT
      o.id,
      o.vote_id,
      o.course_id,
      o.course_name,
      o.course_slug,
      o.display_name,
      o.option_label,
      o.play_date::text AS play_date,
      o.tee_time,
      o.holes,
      o.players,
      o.booking_url,
      o.option_order,
      COUNT(r.id)::int AS vote_count,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'user_id', r.user_id,
            'name', COALESCE(u.email, 'TeeRadar User')
          )
          ORDER BY r.created_at ASC
        ) FILTER (WHERE r.id IS NOT NULL),
        '[]'::json
      ) AS voters
    FROM group_vote_options o
    LEFT JOIN group_vote_responses r ON r.option_id = o.id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE o.vote_id = $1
    GROUP BY
      o.id,
      o.vote_id,
      o.course_id,
      o.course_name,
      o.course_slug,
      o.display_name,
      o.option_label,
      o.play_date,
      o.tee_time,
      o.holes,
      o.players,
      o.booking_url,
      o.option_order
    ORDER BY o.option_order ASC, o.id ASC
    `,
    [vote.id]
  );

  let myOptionIds = [];
  if (viewerUserId) {
    const myVoteRes = await db.query(
      `
      SELECT option_id
      FROM group_vote_responses
      WHERE vote_id = $1 AND user_id = $2
      ORDER BY created_at ASC, id ASC
      `,
      [vote.id, viewerUserId]
    );
    myOptionIds = myVoteRes.rows.map((r) => Number(r.option_id)).filter(Boolean);
  }

  const now = new Date();
  const expired = vote.expires_at ? new Date(vote.expires_at) < now : false;
  const canVote = vote.status === "active" && !expired;
  const canChooseWinner =
    !!viewerUserId && Number(viewerUserId) === Number(vote.creator_user_id);

  return {
    id: vote.id,
    publicId: vote.public_id,
    creatorUserId: vote.creator_user_id,
    title: vote.title,
    note: vote.note,
    status: vote.status,
    expiresAt: vote.expires_at,
    createdAt: vote.created_at,
    creatorName: vote.creator_name,
    selectedOptionId: vote.selected_option_id,
    myOptionIds,
    canVote,
    canChooseWinner,
    expired,
    options: optionsRes.rows,
  };
}

// create vote
router.post("/api/group-votes", async (req, res) => {
  try {
    const creatorUserId = req.user?.id || 0;
    const title = normalizeText(req.body?.title || "Weekend Round", 120);
    const note = normalizeText(req.body?.note || "", 500);
    const expiresAtRaw = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    const options = Array.isArray(req.body?.options) ? req.body.options : [];

    if (options.length < 2) {
      return res.status(400).json({ ok: false, error: "at_least_two_options_required" });
    }

    if (options.length > 10) {
      return res.status(400).json({ ok: false, error: "too_many_options" });
    }

    if (expiresAtRaw && Number.isNaN(expiresAtRaw.getTime())) {
      return res.status(400).json({ ok: false, error: "invalid_expires_at" });
    }

    for (const [i, opt] of options.entries()) {
      if (!normalizeText(opt.courseName, 120)) {
        return res.status(400).json({ ok: false, error: `missing_course_name_at_${i}` });
      }
      if (!isValidDate(opt.playDate)) {
        return res.status(400).json({ ok: false, error: `invalid_play_date_at_${i}` });
      }
      if (!isValidTime(opt.teeTime)) {
        return res.status(400).json({ ok: false, error: `invalid_tee_time_at_${i}` });
      }
      if (!isSafeBookingUrl(opt.bookingUrl)) {
        return res.status(400).json({ ok: false, error: `invalid_booking_url_at_${i}` });
      }
    }

    const publicId = makePublicId();

    await db.query("BEGIN");

    const voteInsert = await db.query(
      `
      INSERT INTO group_votes (
        public_id,
        creator_user_id,
        title,
        note,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, public_id
      `,
      [publicId, creatorUserId, title, note || null, expiresAtRaw]
    );

    const voteId = voteInsert.rows[0].id;

    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i];

      await db.query(
        `
        INSERT INTO group_vote_options (
          vote_id,
          course_id,
          course_name,
          course_slug,
          display_name,
          option_label,
          play_date,
          tee_time,
          holes,
          players,
          booking_url,
          option_order
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [
          voteId,
          opt.courseId || null,
          normalizeText(opt.courseName, 120),
          normalizeText(opt.courseSlug, 120) || null,
          normalizeText(opt.displayName || opt.display_name || opt.optionLabel || "", 200) || null,
          normalizeText(opt.optionLabel || opt.option_label || opt.displayName || "", 200) || null,
          opt.playDate,
          opt.teeTime,
          Number(opt.holes || 18),
          Number(opt.players || 4),
          normalizeText(opt.bookingUrl, 1000) || null,
          i,
        ]
      );
    }

        await db.query("COMMIT");

    // ✅ Track successful group vote creation
    try {
      const occurredAt = new Date().toISOString();
      const recordPgEvent = pgAnalytics.recordEvent || pgAnalytics.recordPgEvent || null;

      if (typeof recordPgEvent === "function") {
        await recordPgEvent({
          type: "group_vote_created",
          at: occurredAt,
          occurredAt,
          occurred_at: occurredAt,
          userId: creatorUserId || null,
          user_id: creatorUserId || null,
          courseName: null,
          course_name: null,
          roundId: null,
          round_id: null,
        });
      }
    } catch (e) {
      console.warn("group_vote_created analytics insert failed (non-fatal):", e?.message || e);
    }

    return res.json({
      ok: true,
      publicId,
      shareUrl: `/group-vote?id=${encodeURIComponent(publicId)}`,
    });
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("POST /api/group-votes error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// public fetch
router.get("/api/group-votes/:publicId", async (req, res) => {
  try {
    const publicId = normalizeText(req.params.publicId, 100);
    const viewerUserId = req.user?.id || null;

    const vote = await getVoteFull(publicId, viewerUserId);
    if (!vote) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    return res.json({ ok: true, vote });
  } catch (err) {
    console.error("GET /api/group-votes/:publicId error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// cast or toggle vote
router.post("/api/group-votes/:publicId/vote", requireUser, async (req, res) => {
  try {
    const publicId = normalizeText(req.params.publicId, 100);
    const optionId = Number(req.body?.optionId || 0);
    const userId = req.user.id;

    if (!optionId) {
      return res.status(400).json({ ok: false, error: "missing_option_id" });
    }

    const vote = await getVoteFull(publicId, userId);
    if (!vote) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    if (!vote.canVote) {
      return res.status(400).json({ ok: false, error: "vote_closed" });
    }

    const optionExists = vote.options.some((o) => Number(o.id) === optionId);
    if (!optionExists) {
      return res.status(400).json({ ok: false, error: "invalid_option_id" });
    }

    const existing = await db.query(
      `
      SELECT id
      FROM group_vote_responses
      WHERE vote_id = $1 AND option_id = $2 AND user_id = $3
      LIMIT 1
      `,
      [vote.id, optionId, userId]
    );

    if (existing.rows[0]?.id) {
      await db.query(
        `
        DELETE FROM group_vote_responses
        WHERE id = $1
        `,
        [existing.rows[0].id]
      );
    } else {
            await db.query(
        `
        INSERT INTO group_vote_responses (vote_id, option_id, user_id)
        VALUES ($1, $2, $3)
        `,
        [vote.id, optionId, userId]
      );
    }

    const refreshed = await getVoteFull(publicId, userId);
    return res.json({ ok: true, vote: refreshed });
    } catch (err) {
    console.error("POST /api/group-votes/:publicId/vote error", {
      message: err?.message || null,
      detail: err?.detail || null,
      code: err?.code || null,
      constraint: err?.constraint || null,
      table: err?.table || null,
      stack: err?.stack || null,
    });

    return res.status(500).json({
      ok: false,
      error: "server_error",
      debug: {
        message: err?.message || null,
        detail: err?.detail || null,
        code: err?.code || null,
        constraint: err?.constraint || null,
        table: err?.table || null,
      },
    });
  }
});

// close poll
router.post("/api/group-votes/:publicId/close", requireUser, async (req, res) => {
  try {
    const publicId = normalizeText(req.params.publicId, 100);
    const userId = req.user.id;

    const vote = await getVoteFull(publicId, userId);
    if (!vote) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    if (Number(vote.creatorUserId) !== Number(userId)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    await db.query(
      `UPDATE group_votes SET status = 'closed', updated_at = NOW() WHERE id = $1`,
      [vote.id]
    );

    const refreshed = await getVoteFull(publicId, userId);
    return res.json({ ok: true, vote: refreshed });
  } catch (err) {
    console.error("POST /api/group-votes/:publicId/close error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// select winner
router.post("/api/group-votes/:publicId/select", requireUser, async (req, res) => {
  try {
    const publicId = normalizeText(req.params.publicId, 100);
    const optionId = Number(req.body?.optionId || 0);
    const userId = req.user.id;

    const vote = await getVoteFull(publicId, userId);
    if (!vote) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    if (Number(vote.creatorUserId) !== Number(userId)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const optionExists = vote.options.some((o) => Number(o.id) === optionId);
    if (!optionExists) {
      return res.status(400).json({ ok: false, error: "invalid_option_id" });
    }

    await db.query(
      `
      UPDATE group_votes
      SET selected_option_id = $2,
          status = 'booked',
          updated_at = NOW()
      WHERE id = $1
      `,
      [vote.id, optionId]
    );

    const refreshed = await getVoteFull(publicId, userId);
    return res.json({ ok: true, vote: refreshed });
  } catch (err) {
    console.error("POST /api/group-votes/:publicId/select error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// list my polls
router.get("/api/group-votes-mine", requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const r = await db.query(
      `
      SELECT
        gv.public_id,
        gv.title,
        gv.status,
        gv.expires_at,
        gv.created_at,
        COUNT(o.id)::int AS option_count
      FROM group_votes gv
      LEFT JOIN group_vote_options o ON o.vote_id = gv.id
      WHERE gv.creator_user_id = $1
      GROUP BY gv.id
      ORDER BY gv.created_at DESC
      LIMIT 50
      `,
      [userId]
    );

    return res.json({ ok: true, polls: r.rows });
  } catch (err) {
    console.error("GET /api/group-votes-mine error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;