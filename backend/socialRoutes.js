// backend/socialRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

const router = express.Router();

router.use(requireAuth);

let profileColumnsReady = false;

async function ensureSocialProfileColumns() {
  if (profileColumnsReady) return;

  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS full_name TEXT,
      ADD COLUMN IF NOT EXISTS age INTEGER,
      ADD COLUMN IF NOT EXISTS state TEXT,
      ADD COLUMN IF NOT EXISTS gender TEXT,
      ADD COLUMN IF NOT EXISTS dob DATE,
      ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
  `);
  profileColumnsReady = true;
}

async function sendDeletionRequestEmail({ email, displayName, fullName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail =
    process.env.DELETE_REQUEST_EMAIL ||
    process.env.CONTACT_TO_EMAIL ||
    process.env.ADMIN_EMAIL ||
    "alerts@teeradar.com.au";

  if (!apiKey) {
    console.warn("RESEND_API_KEY missing, deletion request email not sent.");
    return false;
  }

  const subject = `TeeRadar account deletion request - ${email}`;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;">
      <h2>Account deletion request</h2>
      <p>A TeeRadar user has requested account deletion.</p>

      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Display name:</strong> ${displayName || "-"}</p>
      <p><strong>Full name:</strong> ${fullName || "-"}</p>
      <p><strong>Requested at:</strong> ${new Date().toISOString()}</p>

      <p>Please manually review and delete/disable this account.</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "TeeRadar <alerts@teeradar.com.au>",
      to: [toEmail],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("Deletion request email failed:", response.status, text);
    return false;
  }

  return true;
}

// ✅ account profile details
router.get("/profile", async (req, res) => {
  try {
    await ensureSocialProfileColumns();

    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT
        id,
        email,
        display_name,
        full_name,
        age,
        state,
        gender,
        dob,
        profile_visibility
      FROM users
      WHERE id = $1
      LIMIT 1;
      `,
      [userId]
    );

    const user = rows[0] || null;

    res.json({
      ok: true,
      profile: user
        ? {
            email: user.email,
            displayName: user.display_name || "",
            fullName: user.full_name || "",
age: user.age ?? null,
state: user.state || "",
gender: user.gender || "prefer_not_to_answer",
dob: user.dob ? String(user.dob).slice(0, 10) : "",
            profileVisibility: user.profile_visibility || "friends",
          }
        : null,
    });
  } catch (err) {
    console.error("GET /api/social/profile error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.post("/profile", async (req, res) => {
  try {
    await ensureSocialProfileColumns();

    const userId = Number(req.user?.id);

    const displayName = String(req.body?.displayName || "")
      .trim()
      .slice(0, 40);

    const fullName = String(req.body?.fullName || "")
      .trim()
      .slice(0, 80);

    const state = String(req.body?.state || "")
      .trim()
      .toUpperCase();

const allowedStates = new Set([
  "WA",
  "NSW",
  "VIC",
  "QLD",
  "SA",
  "TAS",
  "ACT",
  "NT",
]);

if (state && !allowedStates.has(state)) {
  return res.status(400).json({
    ok: false,
    error: "invalid_state",
  });
}

    const genderRaw = String(req.body?.gender || "prefer_not_to_answer")
      .trim()
      .toLowerCase();

    const allowedGenders = new Set([
      "prefer_not_to_answer",
      "male",
      "female",
      "other",
    ]);

    const gender = allowedGenders.has(genderRaw)
      ? genderRaw
      : "prefer_not_to_answer";

    const dobRaw = String(req.body?.dob || "").trim();
    const dob = dobRaw ? dobRaw : null;

    if (!displayName) {
      return res.status(400).json({ ok: false, error: "display_name_required" });
    }

    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return res.status(400).json({ ok: false, error: "invalid_dob" });
    }

    const { rows } = await db.query(
      `
      UPDATE users
SET
  display_name = $2,
  full_name = $3,
  state = $4,
  gender = $5,
  dob = $6
WHERE id = $1
      RETURNING
  id,
  email,
  display_name,
  full_name,
  age,
  state,
  gender,
  dob,
  profile_visibility;
      `,
      [
  userId,
  displayName || null,
  fullName || null,
  state || null,
  gender || "prefer_not_to_answer",
  dob,
]
    );

    const user = rows[0] || null;

    res.json({
      ok: true,
      profile: user
        ? {
            email: user.email,
            displayName: user.display_name || "",
            fullName: user.full_name || "",
age: user.age ?? null,
state: user.state || "",
gender: user.gender || "prefer_not_to_answer",
dob: user.dob ? String(user.dob).slice(0, 10) : "",
            profileVisibility: user.profile_visibility || "friends",
          }
        : null,
    });
  } catch (err) {
    console.error("POST /api/social/profile error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ✅ account deletion request
router.post("/delete-request", async (req, res) => {
  try {
    await ensureSocialProfileColumns();

    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      UPDATE users
      SET deletion_requested_at = NOW()
      WHERE id = $1
      RETURNING email, display_name, full_name;
      `,
      [userId]
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const emailSent = await sendDeletionRequestEmail({
      email: user.email,
      displayName: user.display_name,
      fullName: user.full_name,
    });

    res.json({
      ok: true,
      emailSent,
    });
  } catch (err) {
    console.error("POST /api/social/delete-request error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

router.get("/settings", async (req, res) => {
  try {
    await ensureSocialProfileColumns();

    const userId = Number(req.user?.id);

    const { rows } = await db.query(
      `
      SELECT
        id,
        email,
        display_name,
        full_name,
        gender,
        dob,
        profile_visibility
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
        full_name: user?.full_name || "",
        gender: user?.gender || "prefer_not_to_answer",
        dob: user?.dob ? String(user.dob).slice(0, 10) : "",
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
    await ensureSocialProfileColumns();

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
      SELECT *
      FROM (
        SELECT
          'round' AS activity_type,
          r.id AS round_id,
          NULL::int AS upcoming_round_id,
          r.user_id,
          r.course,
          r.layout,
          r.state,
          r.holes,
          r.created_at AS activity_date,
          u.email,
          COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS display_name,

          COALESCE(SUM(rh.strokes), 0)::int AS total_score,
          COALESCE(SUM(rh.par), 0)::int AS total_par,
          COALESCE(SUM(rh.putts), 0)::int AS total_putts,
          COUNT(rh.hole_number)::int AS holes_entered,

          NULL::text AS play_date,
          NULL::text AS tee_time,
          NULL::text AS owner_name
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

        UNION ALL

        SELECT
          'upcoming_shared' AS activity_type,
          NULL::int AS round_id,
          ur.id AS upcoming_round_id,
          ur.user_id,
          ur.course,
          NULL::text AS layout,
          ur.state,
          ur.holes,
          s.shared_at AS activity_date,
          u.email,
          COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS display_name,

          0::int AS total_score,
          0::int AS total_par,
          0::int AS total_putts,
          0::int AS holes_entered,

          ur.play_date::text AS play_date,
          ur.tee_time::text AS tee_time,
          COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS owner_name
        FROM upcoming_round_shares s
        JOIN upcoming_rounds ur ON ur.id = s.upcoming_round_id
        JOIN users u ON u.id = ur.user_id
        WHERE s.shared_with_user_id = $1
      ) x
      ORDER BY activity_date DESC
      LIMIT 15;
      `,
      [userId]
    );

    const activities = rows.map((r) => {
      const holes = Number(r.holes || 0);

      if (r.activity_type === "upcoming_shared") {
        return {
          type: "upcoming_shared",
          upcoming_round_id: r.upcoming_round_id,
          user_id: r.user_id,
          display_name: r.display_name,
          course: r.course,
          state: r.state,
          holes,
          play_date: r.play_date,
          tee_time: r.tee_time,
          activity_date: r.activity_date,
          complete: false,
          text: `${r.display_name} shared an upcoming round at ${r.course}`,
        };
      }

      const totalScore = Number(r.total_score || 0);
      const totalPar = Number(r.total_par || 0);
      const totalPutts = Number(r.total_putts || 0);
      const holesEntered = Number(r.holes_entered || 0);

      const complete = holesEntered >= holes && totalScore > 0;
      const vsPar = complete && totalPar > 0 ? totalScore - totalPar : null;

      let activityText = "";

      if (!complete) {
        activityText = `${r.display_name} started a round at ${r.course}`;
      } else {
        activityText = `${r.display_name} shot ${totalScore} at ${r.course}`;

        if (holes === 18 && totalScore <= 79) {
          activityText += " • New personal best 18-hole score";
        }

        if (holes === 9 && totalScore <= 39) {
          activityText += " • New personal best 9-hole score";
        }

        if (holes === 18 && totalPutts > 0 && totalPutts <= 30) {
          activityText += " • Best putting round";
        }

        if (holes === 9 && totalPutts > 0 && totalPutts <= 15) {
          activityText += " • Best putting round";
        }
      }

      return {
        type: "round",
        round_id: r.round_id,
        user_id: r.user_id,
        display_name: r.display_name,
        course: r.course,
        layout: r.layout,
        state: r.state,
        holes,
        created_at: r.activity_date,
        activity_date: r.activity_date,
        total_score: totalScore,
        total_putts: totalPutts,
        score_vs_par: vsPar,
        complete,
        text: activityText,
      };
    });

    res.json({ ok: true, activities });
  } catch (err) {
    console.error("GET /api/social/friend-activity error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
