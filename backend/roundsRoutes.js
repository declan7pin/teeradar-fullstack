// backend/roundsRoutes.js
import express from "express";
import db from "./db.js";
import { requireAuth } from "./auth.js";

// ✅ ADDED: record round_played into Postgres analytics
import { recordEvent } from "./analytics.js";

// ✅ Push notification when a friend starts a round
import { sendMobilePushToEmail } from "./pushRoutes.js";

// ✅ OPTIONAL: email admin when a new course is submitted
import { Resend } from "resend";

const router = express.Router();
router.use(express.json());

// -------------------------------------------------
// ✅ OPTIONAL: Admin email alerts (Resend)
// -------------------------------------------------
const resendKey = (process.env.RESEND_API_KEY || "").trim();
const resend = resendKey ? new Resend(resendKey) : null;
const ADMIN_ALERT_EMAIL = (process.env.ADMIN_ALERT_EMAIL || "").trim(); // set to your TeeRadar inbox

async function sendAdminAlert(subject, html) {
  if (!resend || !ADMIN_ALERT_EMAIL) return;
  try {
    await resend.emails.send({
      from: "TeeRadar <no-reply@teeradar.com.au>", // must be a verified sender in Resend
      to: [ADMIN_ALERT_EMAIL],
      subject,
      html,
    });
  } catch (e) {
    console.warn("Admin alert email failed:", e?.message || e);
  }
}

// -------------------------------------------------
// ✅ Admin guard (uses req.isSuperAdmin set in server.js)
// -------------------------------------------------
function requireSuperAdmin(req, res, next) {
  try {
    const email = String(req.user?.email || "").trim().toLowerCase();
    const fn = req.isSuperAdmin;
    const ok = typeof fn === "function" ? !!fn(email) : false;
    if (!ok) return res.status(403).json({ ok: false, error: "forbidden" });
    return next();
  } catch {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
}

// -------------------------------------------------
// ✅ Normalisers (kept because DB template + pending submissions use them)
// -------------------------------------------------
function normalise(s) {
  return (s || "").toString().trim().toLowerCase();
}

// ✅ NEW: normalise course names so they match DB templates
// Removes trailing "(18 holes)" / "(9 holes)" etc.
function normaliseCourseName(s) {
  let x = (s || "").toString().trim().toLowerCase();

  x = x.replace(/\s*\(\s*\d+\s*holes?\s*\)\s*$/i, "");
  x = x.replace(/\s*\(\s*\d+\s*hole\s*\)\s*$/i, "");

  // ✅ make "front / back" match "front/back"
  x = x.replace(/\s*\/\s*/g, "/");

  // ✅ collapse whitespace
  x = x.replace(/\s+/g, " ").trim();

  return x;
}

async function getTemplateFromDbAnyState(course, holes, layout = null) {
  const baseName = normaliseCourseName(course);
  const layoutName = normaliseCourseName(layout);
  const h = Number(holes);

  if (!baseName || !h) return null;

  const possibleNames = new Set();
  possibleNames.add(baseName);

  if (layoutName) {
    possibleNames.add(normaliseCourseName(`${baseName} - ${layoutName}`));
    possibleNames.add(normaliseCourseName(`${baseName}-${layoutName}`));
  }

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json, course_rating, slope_rating, tee_colour
    FROM scorecard_courses
    WHERE holes = $1
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [h]
  );

  const matches = (rows || []).filter((r) => {
    const n = normaliseCourseName(r.name);
    return possibleNames.has(n);
  });

  if (matches.length !== 1) {
    console.log("⚠️ getTemplateFromDbAnyState no single match:", {
      course,
      layout,
      holes: h,
      possibleNames: Array.from(possibleNames),
      matches: matches.map((m) => ({
        id: m.id,
        name: m.name,
        state: m.state,
        holes: m.holes,
      })),
    });
    return null;
  }

  const match = matches[0];

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
        course_rating: match.course_rating,
    slope_rating: match.slope_rating,
    tee_colour: match.tee_colour,
  };
}

// -------------------------------------------------
// ✅ NEW: Multi-player helpers (only adds support; doesn't break existing)
// -------------------------------------------------
function clampPlayers(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 1;
  return Math.max(1, Math.min(4, Math.floor(x)));
}

function cleanPlayerMap(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (let i = 1; i <= 4; i++) {
    const v = obj[String(i)];
    if (v === null || typeof v === "undefined" || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[String(i)] = n;
  }
  return out;
}

// -------------------------------------------------
// ✅ ensure rounds.player_names exists (Postgres)
// -------------------------------------------------
async function ensurePlayerNamesColumn() {
  try {
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS player_names jsonb DEFAULT '[]'::jsonb;
    `);
  } catch (e) {
    console.warn("ensurePlayerNamesColumn failed:", e?.message || e);
  }
}

async function ensureScorecardRatingColumns() {
  try {
    await db.query(`
      ALTER TABLE scorecard_courses
      ADD COLUMN IF NOT EXISTS course_rating numeric(4,1),
      ADD COLUMN IF NOT EXISTS slope_rating integer,
      ADD COLUMN IF NOT EXISTS tee_colour text;

      ALTER TABLE courses_pending
      ADD COLUMN IF NOT EXISTS course_rating numeric(4,1),
      ADD COLUMN IF NOT EXISTS slope_rating integer,
      ADD COLUMN IF NOT EXISTS tee_colour text;
    `);
  } catch (e) {
    console.warn("ensureScorecardRatingColumns failed:", e?.message || e);
  }
}

async function ensureTeeRadarHandicapColumns() {
  try {
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS teeradar_handicap numeric(5,1),
      ADD COLUMN IF NOT EXISTS teeradar_handicap_status text DEFAULT 'provisional',
      ADD COLUMN IF NOT EXISTS teeradar_handicap_rounds integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS teeradar_handicap_trend numeric(5,1),
      ADD COLUMN IF NOT EXISTS teeradar_handicap_updated_at timestamptz;
    `);
  } catch (e) {
    console.warn("ensureTeeRadarHandicapColumns failed:", e?.message || e);
  }
}

async function ensureSharedRoundColumns() {
  try {
    await db.query(`
      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS player_user_ids jsonb DEFAULT '[]'::jsonb;

      ALTER TABLE rounds
      ADD COLUMN IF NOT EXISTS shared_upcoming_round_id integer;
    `);
  } catch (e) {
    console.warn("ensureSharedRoundColumns failed:", e?.message || e);
  }
}

// -------------------------------------------------
// ✅ "complete" heuristic to count a round as played
// -------------------------------------------------
function isCompleteFromPayload(holesArr, holesCount) {
  if (!Array.isArray(holesArr)) return false;
  if (!Number.isFinite(Number(holesCount))) return false;

  if (holesArr.length < Number(holesCount)) return false;

  const strokesByHole = new Map();

  for (const h of holesArr) {
    const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
    if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

    const strokesMap = cleanPlayerMap(h?.strokes_by_player || h?.strokesByPlayer || {});
    let strokesVal =
      typeof strokesMap["1"] !== "undefined"
        ? strokesMap["1"]
        : h?.strokes === null || typeof h?.strokes === "undefined" || h?.strokes === ""
          ? null
          : Number(h.strokes);

    strokesByHole.set(holeNum, Number.isFinite(Number(strokesVal)) ? Number(strokesVal) : null);
  }

  for (let i = 1; i <= Number(holesCount); i++) {
    const v = strokesByHole.get(i);
    if (!Number.isFinite(v)) return false;
  }

  return true;
}

// -------------------------------------------------
// ✅ Scorecard templates in DB (APPROVED only)
// -------------------------------------------------
async function getTemplateFromDb(course, state, holes) {
  const nameNorm = normaliseCourseName(course);
  const st = String(state || "").trim().toUpperCase();
  const h = Number(holes);

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json, course_rating, slope_rating, tee_colour
    FROM scorecard_courses
    WHERE LOWER(name) = $1 AND state = $2 AND holes = $3
    LIMIT 1;
    `,
    [nameNorm, st, h]
  );

  if (!rows.length) return null;

  const r = rows[0];
  const pars = Array.isArray(r.pars_json) ? r.pars_json : null;
  const dists = Array.isArray(r.dists_json) ? r.dists_json : null;

  return {
  id: r.id,
  name: r.name,
  state: r.state,
  holes: r.holes,
  pars,
  dists,
  course_rating: r.course_rating,
  slope_rating: r.slope_rating,
  tee_colour: r.tee_colour,
};
}

function isCompleteTemplateArrays(pars, dists, holes) {
  if (!Array.isArray(pars) || pars.length !== holes) return false;
  if (!Array.isArray(dists) || dists.length !== holes) return false;

  for (let i = 0; i < holes; i++) {
    const p = Number(pars[i]);
    const d = Number(dists[i]);
    if (!Number.isFinite(p) || p < 3 || p > 6) return false;
    if (!Number.isFinite(d) || d < 40 || d > 800) return false;
  }
  return true;
}

async function getTemplateFromDbLoose(course, state, holes) {
  const wanted = normaliseCourseName(course);
  const st = String(state || "").trim().toUpperCase();
  const h = Number(holes);

  if (!wanted || !st || !h) return null;

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json, course_rating, slope_rating, tee_colour
    FROM scorecard_courses
    WHERE state = $1 AND holes = $2
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [st, h]
  );

  const match = (rows || []).find((r) => normaliseCourseName(r.name) === wanted);
  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
        course_rating: match.course_rating,
    slope_rating: match.slope_rating,
    tee_colour: match.tee_colour,
  };
}

function splitLayoutParts(layout) {
  return String(layout || "")
    .split("/")
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

async function getNineHoleTemplateForLayout(course, state, layoutPart) {
  const wantedCourse = normaliseCourseName(course);
  const wantedPart = String(layoutPart || "").trim().toLowerCase();
  const st = String(state || "").trim().toUpperCase();

  if (!wantedCourse || !wantedPart || !st) return null;

  const { rows } = await db.query(
    `
    SELECT id, name, state, holes, pars_json, dists_json, course_rating, slope_rating, tee_colour
    FROM scorecard_courses
    WHERE state = $1 AND holes = 9
    ORDER BY updated_at DESC NULLS LAST, id DESC;
    `,
    [st]
  );

  const match = (rows || []).find((r) => {
    const n = normaliseCourseName(r.name);
    return n.includes(wantedCourse) && n.includes(wantedPart);
  });

  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    holes: match.holes,
    pars: Array.isArray(match.pars_json) ? match.pars_json : null,
    dists: Array.isArray(match.dists_json) ? match.dists_json : null,
        course_rating: match.course_rating,
    slope_rating: match.slope_rating,
    tee_colour: match.tee_colour,
  };
}
// -------------------------------------------------
// Helpers
// -------------------------------------------------
async function getRoundOwner(roundId) {
  const { rows } = await db.query(
    `
    SELECT
      id, user_id, course, layout, state, holes, par_mode,
      players_count, player_names, player_user_ids, shared_upcoming_round_id
    FROM rounds
    WHERE id = $1
    LIMIT 1;
    `,
    [Number(roundId)]
  );
  return rows[0] || null;
}

async function getRoundWithHoles(roundId) {
  const roundRow = await db.query(
    `
    SELECT id, user_id, course, layout, state, holes, par_mode, created_at,
       players_count, player_names, player_user_ids, shared_upcoming_round_id
    FROM rounds
    WHERE id = $1
    LIMIT 1;
    `,
    [Number(roundId)]
  );

  if (!roundRow.rows.length) return null;

  const holesRows = await db.query(
    `
    SELECT hole_number, par, distance_m, strokes, putts,
           strokes_by_player, putts_by_player
    FROM round_holes
    WHERE round_id = $1
    ORDER BY hole_number ASC;
    `,
    [Number(roundId)]
  );

  return { round: roundRow.rows[0], holes: holesRows.rows || [] };
}

// -------------------------------------------------
// ✅ Notify accepted friends when a golfer starts a round
// -------------------------------------------------
async function notifyFriendsRoundStarted({
  userId,
  roundId,
  course,
  layout,
}) {
  try {
    const golferRes = await db.query(
      `
      SELECT
        id,
        email,
        COALESCE(
          NULLIF(display_name, ''),
          split_part(email, '@', 1)
        ) AS name
      FROM users
      WHERE id = $1
      LIMIT 1;
      `,
      [Number(userId)]
    );

    const golfer = golferRes.rows[0];

    if (!golfer) {
      console.warn("FRIEND_STARTED_ROUND: golfer not found", {
        userId,
        roundId,
      });
      return;
    }

    const golferName =
      String(golfer.name || "").trim() || "Your friend";

    const friendsRes = await db.query(
      `
      SELECT DISTINCT
        u.id,
        u.email
      FROM user_friends uf
      JOIN users u
        ON u.id = CASE
          WHEN uf.requester_user_id = $1
            THEN uf.addressee_user_id
          ELSE uf.requester_user_id
        END
      WHERE uf.status = 'accepted'
        AND (
          uf.requester_user_id = $1
          OR uf.addressee_user_id = $1
        );
      `,
      [Number(userId)]
    );

    const friends = friendsRes.rows || [];

    if (!friends.length) {
      console.log("FRIEND_STARTED_ROUND: no accepted friends", {
        userId,
        roundId,
      });
      return;
    }

    const courseName =
      String(course || "").trim() || "their course";

    const layoutName =
      String(layout || "").trim();

    const locationText = layoutName
      ? `${courseName} (${layoutName})`
      : courseName;

    for (const friend of friends) {
      const friendEmail =
        String(friend.email || "").trim().toLowerCase();

      if (!friendEmail) continue;

      try {
        await sendMobilePushToEmail(friendEmail, {
  title: `${golferName} has started a round`,
  body: `${golferName} has started playing at ${locationText}. Tap to follow their live scorecard.`,
  url: `/friend-live-round.html?roundId=${encodeURIComponent(roundId)}&friendUserId=${encodeURIComponent(userId)}`,
  type: "FRIEND_STARTED_ROUND",
  meta: {
    roundId: String(roundId),
    friendUserId: String(userId),
  },
});

        console.log("✅ FRIEND_STARTED_ROUND push sent", {
          to: friendEmail,
          golferUserId: userId,
          roundId,
        });
      } catch (pushErr) {
        console.warn(
          "FRIEND_STARTED_ROUND push failed:",
          pushErr?.message || pushErr
        );
      }
    }
  } catch (err) {
    console.warn(
      "notifyFriendsRoundStarted failed:",
      err?.message || err
    );
  }
}
async function syncSharedPlayerRounds(masterRoundId, savedHoles) {
  console.log("🟦 syncSharedPlayerRounds START", {
    masterRoundId,
    savedHolesCount: Array.isArray(savedHoles) ? savedHoles.length : "not_array",
  });

  const masterData = await getRoundWithHoles(masterRoundId);
  if (!masterData?.round) {
    console.log("🟥 sync stopped: master round not found", { masterRoundId });
    return;
  }

  const master = masterData.round;

  console.log("🟦 sync master round", {
    masterRoundId,
    user_id: master.user_id,
    shared_upcoming_round_id: master.shared_upcoming_round_id,
    course: master.course,
    layout: master.layout,
    state: master.state,
    holes: master.holes,
    players_count: master.players_count,
    player_names: master.player_names,
    player_user_ids: master.player_user_ids,
  });

  const upcomingId = Number(master.shared_upcoming_round_id || 0);

  if (!upcomingId) {
    console.log("🟥 sync stopped: no shared_upcoming_round_id on master round", {
      masterRoundId,
    });
    return;
  }

  const participantsRes = await db.query(
    `
    SELECT
      u.id,
      u.email,
      COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
      CASE WHEN u.id = ur.user_id THEN 0 ELSE 1 END AS sort_order
    FROM upcoming_rounds ur
    JOIN users u ON u.id = ur.user_id
    WHERE ur.id = $1

    UNION ALL

    SELECT
      u.id,
      u.email,
      COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
      1 AS sort_order
    FROM upcoming_round_shares s
    JOIN users u ON u.id = s.shared_with_user_id
    WHERE s.upcoming_round_id = $1

    ORDER BY sort_order ASC, name ASC
    LIMIT 4;
    `,
    [upcomingId]
  );

  const participants = participantsRes.rows || [];

  console.log("🟦 sync participants", {
    upcomingId,
    count: participants.length,
    participants,
  });

  if (participants.length <= 1) {
    console.log("🟥 sync stopped: only one participant found", {
      upcomingId,
      participantsCount: participants.length,
    });
    return;
  }

  for (let i = 0; i < participants.length; i++) {
    const player = participants[i];
    const playerUserId = Number(player.id);
    const playerNum = String(i + 1);
    const playerName = String(player.name || player.email || `Player ${i + 1}`).trim();

    console.log("🟨 syncing player", {
      index: i,
      playerNum,
      playerUserId,
      playerName,
    });

    if (!Number.isFinite(playerUserId) || playerUserId <= 0) {
      console.log("🟥 skipped player: invalid user id", { player });
      continue;
    }

    let roundId = null;

    const existing = await db.query(
      `
      SELECT id
      FROM rounds
      WHERE user_id = $1
        AND shared_upcoming_round_id = $2
      ORDER BY created_at ASC
      LIMIT 1;
      `,
      [playerUserId, upcomingId]
    );

    if (existing.rows.length) {
      roundId = Number(existing.rows[0].id);

      console.log("🟩 using existing player round", {
        playerUserId,
        roundId,
        upcomingId,
      });
    } else {
      const created = await createRoundWithSeededHoles({
        userId: playerUserId,
        course: master.course,
        layout: master.layout,
        state: master.state,
        holes: master.holes,
        par_mode: master.par_mode || "published",
        players_count: 1,
        player_names: [playerName],
        player_user_ids: [playerUserId],
        shared_upcoming_round_id: upcomingId,
      });

      console.log("🟦 create player round result", {
        playerUserId,
        upcomingId,
        createdOk: created?.ok,
        createdRoundId: created?.round?.id,
        error: created?.error,
        detail: created?.detail,
      });

      if (!created?.ok || !created?.round?.id) {
        console.log("🟥 skipped player: could not create player round", {
          playerUserId,
          upcomingId,
        });
        continue;
      }

      roundId = Number(created.round.id);

      console.log("🟩 created player round", {
        playerUserId,
        roundId,
        upcomingId,
      });
    }

    let holesSavedForPlayer = 0;

    for (const h of savedHoles || []) {
      const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
      if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

      const strokesMap = cleanPlayerMap(h?.strokes_by_player || h?.strokesByPlayer || {});
      const puttsMap = cleanPlayerMap(h?.putts_by_player || h?.puttsByPlayer || {});

      const strokesVal = Number.isFinite(Number(strokesMap[playerNum]))
        ? Number(strokesMap[playerNum])
        : null;

      const puttsVal = Number.isFinite(Number(puttsMap[playerNum]))
        ? Number(puttsMap[playerNum])
        : null;

      const parVal =
        h?.par === null || typeof h?.par === "undefined" || h?.par === ""
          ? null
          : Number(h.par);

      const distVal =
        h?.distance_m === null || typeof h?.distance_m === "undefined" || h?.distance_m === ""
          ? null
          : Number(h.distance_m);

      await db.query(
        `
        INSERT INTO round_holes (
          round_id, hole_number, par, distance_m,
          strokes, putts, strokes_by_player, putts_by_player
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
        ON CONFLICT (round_id, hole_number) DO UPDATE SET
          par = EXCLUDED.par,
          distance_m = EXCLUDED.distance_m,
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts,
          strokes_by_player = EXCLUDED.strokes_by_player,
          putts_by_player = EXCLUDED.putts_by_player;
        `,
        [
          roundId,
          holeNum,
          Number.isFinite(parVal) ? parVal : null,
          Number.isFinite(distVal) ? distVal : null,
          strokesVal,
          puttsVal,
          JSON.stringify(strokesVal === null ? {} : { "1": strokesVal }),
          JSON.stringify(puttsVal === null ? {} : { "1": puttsVal }),
        ]
      );

      holesSavedForPlayer++;
    }

    console.log("✅ finished syncing player", {
      playerUserId,
      roundId,
      playerNum,
      holesSavedForPlayer,
    });
  }

  console.log("✅ syncSharedPlayerRounds COMPLETE", {
    masterRoundId,
    upcomingId,
  });
}
function isValidEmail(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function normaliseStateCode(v) {
  const s = String(v || "").trim().toUpperCase();
  const allowed = new Set(["WA", "NT", "QLD", "NSW", "VIC", "SA", "TAS", "ACT"]);
  return allowed.has(s) ? s : "";
}
function handicapDiffFromRound(row) {
  const holes = Number(row.holes || 0);
  const score = Number(row.total_score || 0);
  const par = Number(row.total_par || 0);
  const holesEntered = Number(row.holes_entered || 0);

  if (![9, 18].includes(holes)) return null;
  if (holesEntered < holes) return null;
  if (!Number.isFinite(score) || score <= 0) return null;
  if (!Number.isFinite(par) || par <= 0) return null;

  const courseRating = Number(row.course_rating);
  const slopeRating = Number(row.slope_rating);

  // ✅ More accurate WHS-style formula when rating/slope exists
  if (
    Number.isFinite(courseRating) &&
    courseRating > 20 &&
    Number.isFinite(slopeRating) &&
    slopeRating >= 55 &&
    slopeRating <= 155
  ) {
    const adjustedRating = holes === 9 ? courseRating * 2 : courseRating;
    const adjustedScore = holes === 9 ? score * 2 : score;

    return (adjustedScore - adjustedRating) * 113 / slopeRating;
  }

  // ✅ Fallback when rating/slope is missing
  const diff = score - par;
  return holes === 9 ? diff * 2 : diff;
}

async function recalculateTeeRadarHandicap(userId) {
  await ensureTeeRadarHandicapColumns();

  const { rows } = await db.query(
    `
    SELECT
  r.id,
  r.holes,
  r.course,
  r.state,
  r.created_at,
  COALESCE(SUM(rh.strokes), 0)::int AS total_score,
  COALESCE(SUM(rh.par), 0)::int AS total_par,
  COUNT(CASE WHEN rh.strokes IS NOT NULL THEN 1 END)::int AS holes_entered,
  sc.course_rating,
  sc.slope_rating
FROM rounds r
JOIN round_holes rh ON rh.round_id = r.id
LEFT JOIN scorecard_courses sc
  ON LOWER(sc.name) = LOWER(r.course)
  AND sc.state = r.state
  AND sc.holes = r.holes
WHERE r.user_id = $1
GROUP BY r.id, sc.course_rating, sc.slope_rating
ORDER BY r.created_at DESC
LIMIT 50;
    `,
    [Number(userId)]
  );

  const played = (rows || [])
    .map((r) => ({
      id: r.id,
      date: new Date(r.created_at || 0).getTime(),
      diff: handicapDiffFromRound(r),
    }))
    .filter((r) => Number.isFinite(Number(r.diff)))
    .sort((a, b) => b.date - a.date);

  if (!played.length) {
    await db.query(
      `
      UPDATE users
      SET
        teeradar_handicap = NULL,
        teeradar_handicap_status = 'provisional',
        teeradar_handicap_rounds = 0,
        teeradar_handicap_trend = NULL,
        teeradar_handicap_updated_at = now()
      WHERE id = $1;
      `,
      [Number(userId)]
    );

    return {
      handicap: null,
      status: "provisional",
      rounds: 0,
      trend: null,
    };
  }

  const recent20 = played.slice(0, 20);

  const bestCount =
  recent20.length >= 20 ? 8 :
  recent20.length >= 10 ? 4 :
  recent20.length >= 6 ? 2 :
  recent20.length;

  const best = recent20
    .slice()
    .sort((a, b) => Number(a.diff) - Number(b.diff))
    .slice(0, bestCount);

  const avg = best.reduce((sum, r) => sum + Number(r.diff), 0) / best.length;
  // TeeRadar Handicap V1:
// Uses best recent score differentials.
// 9-hole rounds are already doubled to an 18-hole equivalent.
// 0.93 keeps it close to real handicap behaviour without course rating/slope yet.
const handicap = Math.max(0, Number((avg * 0.93).toFixed(1)));

  const last3 = played.slice(0, 3);
  const prev3 = played.slice(3, 6);

  let trend = null;

if (last3.length >= 3) {
  const lastAvg = last3.reduce((sum, r) => sum + Number(r.diff), 0) / last3.length;

  // Store last 3 average as handicap-style number
  trend = Math.max(0, Number((lastAvg * 0.93).toFixed(1)));
}

  const status = played.length >= 3 ? "confirmed" : "provisional";

  await db.query(
    `
    UPDATE users
    SET
      teeradar_handicap = $2,
      teeradar_handicap_status = $3,
      teeradar_handicap_rounds = $4,
      teeradar_handicap_trend = $5,
      teeradar_handicap_updated_at = now()
    WHERE id = $1;
    `,
    [
      Number(userId),
      handicap,
      status,
      played.length,
      Number.isFinite(Number(trend)) ? trend : null,
    ]
  );

  return {
    handicap,
    status,
    rounds: played.length,
    trend,
  };
}
// -------------------------------------------------
// ✅ Template endpoints
// Mounted at /api/rounds, so:
// - GET  /api/rounds/templates
// - POST /api/rounds/templates/submit/:roundId
// - Admin: GET  /api/rounds/admin/pending-courses
// - Admin: POST /api/rounds/admin/pending-courses/:id/approve
// -------------------------------------------------
router.get("/templates", async (req, res) => {
  try {
  await ensureScorecardRatingColumns();

  const { rows } = await db.query(
      `
      SELECT id, name, state, holes, pars_json, dists_json, course_rating, slope_rating, tee_colour, updated_at
      FROM scorecard_courses
      ORDER BY state ASC, name ASC, holes ASC;
      `
    );

    return res.json({
      ok: true,
      courses: rows.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        holes: r.holes,
        pars: Array.isArray(r.pars_json) ? r.pars_json : [],
        dists: Array.isArray(r.dists_json) ? r.dists_json : [],
        updatedAt: r.updated_at,
        course_rating: r.course_rating,
slope_rating: r.slope_rating,
tee_colour: r.tee_colour,
      })),
    });
  } catch (err) {
    console.error("GET /api/rounds/templates error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// User submits a course template based on their saved round
router.post("/templates/submit/:roundId", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const roundId = Number(req.params.roundId);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(roundId) || roundId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid round id" });
    }

    const owner = await getRoundOwner(roundId);
    if (!owner) return res.status(404).json({ ok: false, error: "round not found" });
    if (owner.user_id !== userId) return res.status(403).json({ ok: false, error: "forbidden" });

    const holesCount = Number(owner.holes);
    const courseName = String(owner.course || "").trim();
    const stateCode = String(owner.state || "").trim().toUpperCase();

    const { rows } = await db.query(
      `
      SELECT hole_number, par, distance_m
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [roundId]
    );

    const pars = new Array(holesCount).fill(null);
    const dists = new Array(holesCount).fill(null);

    for (const r of rows) {
      const i = Number(r.hole_number) - 1;
      if (i < 0 || i >= holesCount) continue;
      pars[i] = r.par === null || typeof r.par === "undefined" ? null : Number(r.par);
      dists[i] =
        r.distance_m === null || typeof r.distance_m === "undefined" ? null : Number(r.distance_m);
    }

    if (!isCompleteTemplateArrays(pars, dists, holesCount)) {
      return res.status(400).json({
        ok: false,
        error: "template_incomplete",
        message: "Please enter par + distance for every hole before submitting this course.",
      });
    }

    // If already approved template exists, short-circuit
    const existing = await getTemplateFromDb(courseName, stateCode, holesCount);
    if (existing?.id) {
      return res.json({ ok: true, alreadyApproved: true, courseId: existing.id });
    }

    // ✅ NO DUPES + capture *submitted* email (user must type it)
const nameNorm = normaliseCourseName(courseName);

const submittedEmailRaw = String(req.body?.email || "").trim().toLowerCase();
const submittedEmail = submittedEmailRaw ? submittedEmailRaw : null;

if (!submittedEmail || !isValidEmail(submittedEmail)) {
  return res.status(400).json({
    ok: false,
    error: "email_required",
    message: "Please enter a valid email address before submitting.",
  });
}

    // ✅ IMPORTANT:
    // courses_pending has a PARTIAL unique index for OPEN rows:
    // (name, state, holes) WHERE approved_at IS NULL AND rejected_at IS NULL
    // So ON CONFLICT must include the same WHERE clause.
    const ins = await db.query(
      `
      INSERT INTO courses_pending (
        name, state, holes, pars_json, dists_json,
        submitted_by_user_id, submitted_by_email
      )
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
      ON CONFLICT (name, state, holes)
      WHERE approved_at IS NULL AND rejected_at IS NULL
      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,
        dists_json = EXCLUDED.dists_json,
        submitted_by_user_id = COALESCE(courses_pending.submitted_by_user_id, EXCLUDED.submitted_by_user_id),
        submitted_by_email   = COALESCE(courses_pending.submitted_by_email,   EXCLUDED.submitted_by_email)
      RETURNING id;
      `,
      [
        nameNorm,
        stateCode,
        holesCount,
        JSON.stringify(pars),
        JSON.stringify(dists),
        Number(userId),
        submittedEmail,
      ]
    );

    const pendingId = ins.rows[0]?.id;

    // ✅ contributor history (auto-linked)
    try {
      await db.query(
        `
        INSERT INTO scorecard_course_contributions
          (action, name, state, holes, pending_id, actor_user_id, actor_email)
        VALUES
          ('SUBMITTED', $1, $2, $3, $4, $5, $6);
        `,
        [nameNorm, stateCode, holesCount, Number(pendingId), Number(userId), submittedEmail]
      );
    } catch (e) {
      console.warn("contribution log (SUBMITTED) failed:", e?.message || e);
    }

    await sendAdminAlert(
      `New user course submitted: ${courseName} (${holesCount})`,
      `
        <p><b>New course submitted</b></p>
        <p>
          <b>Name:</b> ${courseName}<br/>
          <b>State:</b> ${stateCode}<br/>
          <b>Holes:</b> ${holesCount}<br/>
          <b>Pending ID:</b> ${pendingId}<br/>
          <b>Submitted by user_id:</b> ${userId}<br/>
<b>User email:</b> ${submittedEmail}
        </p>
        <p>Approve it in Analytics → Pending Courses.</p>
      `
    );

    return res.json({ ok: true, pendingId });
  } catch (err) {
    console.error("POST /api/rounds/templates/submit/:roundId error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Admin: list pending submissions
router.get("/admin/pending-courses", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, submitted_by_user_id, submitted_by_email, created_at
      FROM courses_pending
      WHERE approved_at IS NULL AND rejected_at IS NULL
      ORDER BY created_at DESC
      LIMIT 500;
      `
    );
    return res.json({ ok: true, pending: rows });
  } catch (err) {
    console.error("GET /api/rounds/admin/pending-courses error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// ✅ Admin: get ONE pending submission (detail for modal)
router.get("/admin/pending-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const { rows } = await db.query(
      `
      SELECT
        id, name, state, holes,
        pars_json, dists_json,
        submitted_by_user_id, submitted_by_email,
        created_at
      FROM courses_pending
      WHERE id = $1 AND approved_at IS NULL AND rejected_at IS NULL
      LIMIT 1;
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

    const p = rows[0];

    // ✅ shape matches your frontend normaliser: (data.ok && data.template)
    return res.json({
      ok: true,
      template: {
        id: p.id,
        name: p.name,
        state: p.state,
        holes: p.holes,
        pars: Array.isArray(p.pars_json) ? p.pars_json : [],
        distances_m: Array.isArray(p.dists_json) ? p.dists_json : [], // flat distances array
        submitted_by_user_id: p.submitted_by_user_id,
        submitted_by_email: p.submitted_by_email,
        created_at: p.created_at,
      },
    });
  } catch (err) {
    console.error("GET /api/rounds/admin/pending-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// -------------------------------------------------
// ✅ Admin: manage APPROVED scorecard courses (edit / delete)
// -------------------------------------------------

// List approved scorecard courses
router.get("/admin/scorecard-courses", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureScorecardRatingColumns();

    const { rows } = await db.query(
      `
      SELECT
  id,
  name,
  state,
  holes,
  course_rating,
  slope_rating,
  tee_colour,
  updated_at
FROM scorecard_courses
      ORDER BY state ASC, name ASC, holes ASC;
      `
    );
    return res.json({ ok: true, courses: rows });
  } catch (err) {
    console.error("GET /api/rounds/admin/scorecard-courses error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Manually add an approved scorecard course
router.post("/admin/scorecard-courses", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureScorecardRatingColumns();

    const nameRaw = String(req.body?.name || "").trim();
    const state = normaliseStateCode(req.body?.state);
    const holes = Number(req.body?.holes);

    const pars = Array.isArray(req.body?.pars) ? req.body.pars.map(Number) : [];
    const dists = Array.isArray(req.body?.distances_m)
      ? req.body.distances_m.map(Number)
      : Array.isArray(req.body?.dists)
        ? req.body.dists.map(Number)
        : [];

    const courseRatingRaw = req.body?.course_rating;
    const slopeRatingRaw = req.body?.slope_rating;
    const teeColour = String(req.body?.tee_colour || "").trim() || null;

    const name = normaliseCourseName(nameRaw);

    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    if (!state) return res.status(400).json({ ok: false, error: "state_required" });
    if (![9, 18].includes(holes)) return res.status(400).json({ ok: false, error: "invalid_holes" });

    if (!isCompleteTemplateArrays(pars, dists, holes)) {
      return res.status(400).json({
        ok: false,
        error: "template_incomplete",
        message: "Every hole needs a valid par and distance.",
      });
    }

    const courseRating =
      courseRatingRaw === null || typeof courseRatingRaw === "undefined" || courseRatingRaw === ""
        ? null
        : Number(courseRatingRaw);

    const slopeRating =
      slopeRatingRaw === null || typeof slopeRatingRaw === "undefined" || slopeRatingRaw === ""
        ? null
        : Number(slopeRatingRaw);

    if (courseRating !== null && !Number.isFinite(courseRating)) {
      return res.status(400).json({ ok: false, error: "invalid_course_rating" });
    }

    if (
      slopeRating !== null &&
      (!Number.isFinite(slopeRating) || slopeRating < 55 || slopeRating > 155)
    ) {
      return res.status(400).json({ ok: false, error: "invalid_slope_rating" });
    }

    const up = await db.query(
      `
      INSERT INTO scorecard_courses (
        name, state, holes, pars_json, dists_json,
        course_rating, slope_rating, tee_colour, updated_at
      )
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,now())
      ON CONFLICT (name, state, holes)
      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,
        dists_json = EXCLUDED.dists_json,
        course_rating = EXCLUDED.course_rating,
        slope_rating = EXCLUDED.slope_rating,
        tee_colour = EXCLUDED.tee_colour,
        updated_at = now()
      RETURNING
        id, name, state, holes, course_rating, slope_rating, tee_colour, updated_at;
      `,
      [
        name,
        state,
        holes,
        JSON.stringify(pars),
        JSON.stringify(dists),
        Number.isFinite(courseRating) ? courseRating : null,
        Number.isFinite(slopeRating) ? slopeRating : null,
        teeColour,
      ]
    );

    return res.json({ ok: true, course: up.rows[0] });
  } catch (err) {
    console.error("POST /api/rounds/admin/scorecard-courses error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal error",
      detail: err?.message,
    });
  }
});

// Edit an approved scorecard course (name + state)
router.patch("/admin/scorecard-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await ensureScorecardRatingColumns();

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const cur = await db.query(
      `
      SELECT id, name, state, holes, course_rating, slope_rating, tee_colour
      FROM scorecard_courses
      WHERE id = $1
      LIMIT 1;
      `,
      [id]
    );

    if (!cur.rows.length) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const existing = cur.rows[0];

    const nameRaw = String(req.body?.name || "").trim();
    const stateRaw = String(req.body?.state || "").trim().toUpperCase();

    const courseRatingRaw = req.body?.course_rating;
    const slopeRatingRaw = req.body?.slope_rating;
    const teeColourRaw = String(req.body?.tee_colour || "").trim();

    const newName = nameRaw
      ? normaliseCourseName(nameRaw)
      : String(existing.name || "").trim();

    const newState = stateRaw
      ? normaliseStateCode(stateRaw)
      : String(existing.state || "").trim().toUpperCase();

    const newCourseRating =
      courseRatingRaw === null ||
      typeof courseRatingRaw === "undefined" ||
      courseRatingRaw === ""
        ? null
        : Number(courseRatingRaw);

    const newSlopeRating =
      slopeRatingRaw === null ||
      typeof slopeRatingRaw === "undefined" ||
      slopeRatingRaw === ""
        ? null
        : Number(slopeRatingRaw);

    const newTeeColour = teeColourRaw || null;

    if (!newName) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    if (!newState) {
      return res.status(400).json({ ok: false, error: "state_required" });
    }

    if (newCourseRating !== null && !Number.isFinite(newCourseRating)) {
      return res.status(400).json({ ok: false, error: "invalid_course_rating" });
    }

    if (
      newSlopeRating !== null &&
      (!Number.isFinite(newSlopeRating) || newSlopeRating < 55 || newSlopeRating > 155)
    ) {
      return res.status(400).json({ ok: false, error: "invalid_slope_rating" });
    }

    try {
      const up = await db.query(
        `
        UPDATE scorecard_courses
        SET
          name = $2,
          state = $3,
          course_rating = $4,
          slope_rating = $5,
          tee_colour = $6,
          updated_at = now()
        WHERE id = $1
        RETURNING
          id,
          name,
          state,
          holes,
          course_rating,
          slope_rating,
          tee_colour,
          updated_at;
        `,
        [
          id,
          newName,
          newState,
          newCourseRating,
          newSlopeRating,
          newTeeColour,
        ]
      );

      return res.json({ ok: true, course: up.rows[0] });
    } catch (e) {
      const msg = String(e?.message || "").toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return res.status(409).json({ ok: false, error: "name_conflict" });
      }
      throw e;
    }
  } catch (err) {
    console.error("PATCH /api/rounds/admin/scorecard-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Delete an approved scorecard course
router.delete("/admin/scorecard-courses/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const del = await db.query(`DELETE FROM scorecard_courses WHERE id = $1;`, [id]);
    return res.json({ ok: true, deleted: del.rowCount || 0 });
  } catch (err) {
    console.error("DELETE /api/rounds/admin/scorecard-courses/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});
// Admin: approve pending -> upsert into scorecard_courses + log contribution
router.post("/admin/pending-courses/:id/approve", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_id" });
    }

    const { rows } = await db.query(
      `
      SELECT id, name, state, holes, pars_json, dists_json, submitted_by_user_id, submitted_by_email
      FROM courses_pending
      WHERE id = $1 AND approved_at IS NULL AND rejected_at IS NULL
      LIMIT 1;
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

    const p = rows[0];

    // ✅ allow admin overrides before approval
    const overrideNameRaw = String(req.body?.name || "").trim();
    const overrideStateRaw = String(req.body?.state || "").trim().toUpperCase();

    const approvedName = overrideNameRaw ? normaliseCourseName(overrideNameRaw) : String(p.name || "").trim();
    const approvedState = overrideStateRaw || String(p.state || "").trim().toUpperCase();
    const approvedHoles = Number(p.holes);

    if (!approvedName) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    if (!approvedState) {
      return res.status(400).json({ ok: false, error: "state_required" });
    }

    await db.query("BEGIN");
    await ensureScorecardRatingColumns();

const courseRating =
  req.body?.course_rating === null || typeof req.body?.course_rating === "undefined" || req.body?.course_rating === ""
    ? null
    : Number(req.body.course_rating);

const slopeRating =
  req.body?.slope_rating === null || typeof req.body?.slope_rating === "undefined" || req.body?.slope_rating === ""
    ? null
    : Number(req.body.slope_rating);

const teeColour = String(req.body?.tee_colour || "").trim() || null;

    const up = await db.query(
      `
      INSERT INTO scorecard_courses (
  name, state, holes, pars_json, dists_json,
  course_rating, slope_rating, tee_colour
)
VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
ON CONFLICT (name, state, holes)
DO UPDATE SET
  pars_json = EXCLUDED.pars_json,
  dists_json = EXCLUDED.dists_json,
  course_rating = EXCLUDED.course_rating,
  slope_rating = EXCLUDED.slope_rating,
  tee_colour = EXCLUDED.tee_colour,
  updated_at = now()
RETURNING id;
      `,
      [
  approvedName,
  approvedState,
  approvedHoles,
  JSON.stringify(p.pars_json),
  JSON.stringify(p.dists_json),
  Number.isFinite(courseRating) ? courseRating : null,
  Number.isFinite(slopeRating) ? slopeRating : null,
  teeColour
]
    );

    const approvedCourseId = up.rows[0]?.id || null;

    const approverId = Number(req.user?.id || 0) || null;
    const approverEmail = String(req.user?.email || "").trim().toLowerCase() || null;

    await db.query(
      `
      UPDATE courses_pending
      SET
        name = $2,
        state = $3,
        approved_at = now(),
        approved_by_user_id = $4,
        approved_by_email = $5
      WHERE id = $1;
      `,
      [id, approvedName, approvedState, approverId, approverEmail]
    );

    try {
      await db.query(
        `
        INSERT INTO scorecard_course_contributions
          (action, name, state, holes, pending_id, approved_course_id, actor_user_id, actor_email)
        VALUES
          ('APPROVED', $1, $2, $3, $4, $5, $6, $7);
        `,
        [
          approvedName,
          approvedState,
          approvedHoles,
          Number(id),
          approvedCourseId,
          approverId,
          approverEmail
        ]
      );
    } catch (e) {
      console.warn("contribution log (APPROVED) failed:", e?.message || e);
    }

    await db.query("COMMIT");

    return res.json({
      ok: true,
      approvedCourseId,
      name: approvedName,
      state: approvedState,
      holes: approvedHoles
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("POST /api/rounds/admin/pending-courses/:id/approve error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// -------------------------------------------------
// ✅ Reusable round creator
// Used by POST /api/rounds and later by bookingRoutes.js
// -------------------------------------------------
export async function createRoundWithSeededHoles({
  userId,
  course,
  layout = null,
  state = null,
  holes = 18,
  par_mode = "published", // "published" | "blank"
  publishedPars = null,   // optional legacy support
  players_count = 1,
    player_names = null,
  player_user_ids = null,
  shared_upcoming_round_id = null,
}) {
  const holesNum = Number(holes);

  if (!userId) {
    return { ok: false, status: 401, error: "unauthorised" };
  }
  if (!course || !String(course).trim()) {
    return { ok: false, status: 400, error: "course is required" };
  }
  if (![9, 18].includes(holesNum)) {
    return { ok: false, status: 400, error: "holes must be 9 or 18" };
  }

  let stateCode = (state || "").toString().trim().toUpperCase() || null;
  const layoutName = (layout || "").toString().trim() || null;
  const mode = (par_mode || "").toString().trim().toLowerCase() || "published";

  const playersCount = clampPlayers(players_count);

  let playerNames = [];
  if (Array.isArray(player_names)) {
    playerNames = player_names.map((x) => String(x || "").trim());
  }
  playerNames.length = playersCount;
  if (typeof playerNames[0] !== "string") playerNames[0] = "";

  let pars = null;
  let dists = null;

    // ✅ Try approved templates first
  if (mode === "published") {
    let t = null;

    if (stateCode) {
      // 1) exact course/state/holes match
      t = await getTemplateFromDb(String(course), stateCode, holesNum);

      // 2) looser name match if exact failed
      if (!t) {
        t = await getTemplateFromDbLoose(String(course), stateCode, holesNum);
      }
    }

    // ✅ 3) If booking-created round has no state, auto-find the approved template
    if (!t && !stateCode) {
      t = await getTemplateFromDbAnyState(String(course), holesNum, layoutName);
      if (t?.state) stateCode = String(t.state || "").trim().toUpperCase() || null;
    }

    if (t && Array.isArray(t.pars) && t.pars.length === holesNum) {
      pars = t.pars.slice(0, holesNum);
    }

    if (t && Array.isArray(t.dists) && t.dists.length === holesNum) {
      dists = t.dists.slice(0, holesNum);
    }

    // 4) 18-hole routed fallback from two approved 9-hole templates
    if ((!pars || !dists) && holesNum === 18 && layoutName && stateCode) {
      const parts = splitLayoutParts(layoutName);
      if (parts.length === 2) {
        const frontT = await getNineHoleTemplateForLayout(course, stateCode, parts[0]);
        const backT = await getNineHoleTemplateForLayout(course, stateCode, parts[1]);

        if (
          frontT && backT &&
          Array.isArray(frontT.pars) && frontT.pars.length === 9 &&
          Array.isArray(backT.pars) && backT.pars.length === 9
        ) {
          pars = frontT.pars.slice(0, 9).concat(backT.pars.slice(0, 9));
        }

        if (
          frontT && backT &&
          Array.isArray(frontT.dists) && frontT.dists.length === 9 &&
          Array.isArray(backT.dists) && backT.dists.length === 9
        ) {
          dists = frontT.dists.slice(0, 9).concat(backT.dists.slice(0, 9));
        }
      }
    }

    // 5) 9-hole routed fallback
    if ((!pars || !dists) && holesNum === 9 && layoutName && stateCode) {
      const t9 = await getNineHoleTemplateForLayout(course, stateCode, layoutName);

      if (t9 && Array.isArray(t9.pars) && t9.pars.length === 9) {
        pars = t9.pars.slice(0, 9);
      }

      if (t9 && Array.isArray(t9.dists) && t9.dists.length === 9) {
        dists = t9.dists.slice(0, 9);
      }
    }

    console.log("🧩 createRoundWithSeededHoles template lookup:", {
      course: String(course).trim(),
      layout: layoutName,
      state: stateCode,
      holes: holesNum,
      foundPars: !!pars,
      foundDists: !!dists,
      parsCount: Array.isArray(pars) ? pars.length : 0,
      distsCount: Array.isArray(dists) ? dists.length : 0,
    });
  }

  // ✅ legacy optional fallback
  if (mode === "published" && !pars && Array.isArray(publishedPars) && publishedPars.length === holesNum) {
    const tmp = publishedPars.map((p) => (p === null || p === undefined || p === "" ? null : Number(p)));
    if (tmp.every((p) => p === null || Number.isFinite(p))) pars = tmp;
  }

  const finalParMode = (Array.isArray(pars) && pars.length === holesNum) ? "published" : "blank";

    await ensurePlayerNamesColumn();
  await ensureSharedRoundColumns();

  let playerUserIds = [];
  if (Array.isArray(player_user_ids)) {
    playerUserIds = player_user_ids.map(Number).filter(Number.isFinite);
  }
  playerUserIds.length = playersCount;

  let insertedRoundId = null;

  try {
    await db.query("BEGIN");

        const roundInsert = await db.query(
      `
      INSERT INTO rounds (
        user_id, course, layout, state, holes, par_mode,
        players_count, player_names, player_user_ids, shared_upcoming_round_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      RETURNING id, user_id, course, layout, state, holes, par_mode, created_at,
                players_count, player_names, player_user_ids, shared_upcoming_round_id;
      `,
      [
        Number(userId),
        String(course).trim(),
        layoutName,
        stateCode,
        holesNum,
        finalParMode,
        playersCount,
        JSON.stringify(playerNames),
        JSON.stringify(playerUserIds),
        shared_upcoming_round_id ? Number(shared_upcoming_round_id) : null,
      ]
    );

    const round = roundInsert.rows?.[0] || null;
    if (!round || !round.id) {
      await db.query("ROLLBACK");
      return { ok: false, status: 500, error: "round_insert_failed" };
    }

    insertedRoundId = Number(round.id);

    for (let i = 1; i <= holesNum; i++) {
      const parVal = pars ? (Number.isFinite(Number(pars[i - 1])) ? Number(pars[i - 1]) : null) : null;
      const distVal = dists ? (Number.isFinite(Number(dists[i - 1])) ? Number(dists[i - 1]) : null) : null;

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
        VALUES ($1, $2, $3, $4, NULL, NULL, '{}'::jsonb, '{}'::jsonb)
        ON CONFLICT (round_id, hole_number) DO NOTHING;
        `,
        [insertedRoundId, i, parVal, distVal]
      );
    }

    await db.query("COMMIT");

    const verifyRound = await db.query(
      `
      SELECT id, user_id, course, layout, state, holes, par_mode, created_at, players_count, player_names, player_user_ids, shared_upcoming_round_id
      FROM rounds
      WHERE id = $1
      LIMIT 1;
      `,
      [insertedRoundId]
    );

    if (!verifyRound.rows.length) {
      console.error("createRoundWithSeededHoles: round missing after commit", {
        insertedRoundId,
        userId,
        course,
        layoutName,
        stateCode,
        holesNum,
      });

      return { ok: false, status: 500, error: "round_not_found_after_commit" };
    }

    const holesRows = await db.query(
      `
      SELECT hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player
      FROM round_holes
      WHERE round_id = $1
      ORDER BY hole_number ASC;
      `,
      [insertedRoundId]
    );

    console.log("✅ createRoundWithSeededHoles created round:", {
      roundId: insertedRoundId,
      userId,
      course: String(course).trim(),
      layout: layoutName,
      state: stateCode,
      holes: holesNum,
      par_mode: finalParMode,
      templateUsed: !!(pars && dists),
    });

    return {
      ok: true,
      status: 200,
      round: verifyRound.rows[0],
      holes: holesRows.rows || [],
      scorecardUsed: !!pars,
      templateUsed: !!(pars && dists),
    };
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("createRoundWithSeededHoles failed:", err?.message || err, {
      insertedRoundId,
      userId,
      course,
      layoutName,
      stateCode,
      holesNum,
    });
    return {
      ok: false,
      status: 500,
      error: "create_round_with_seeded_holes_failed",
      detail: err?.message || String(err || ""),
    };
  }
}
// -------------------------------------------------
// Routes (mounted at /api/rounds)
// -------------------------------------------------

// Create a new round + seed holes (pars + dists if approved template exists; otherwise blank)
router.post("/", requireAuth, async (req, res) => {
  const userId = req.user?.id;

  try {
    const {
  course,
  layout = null,
  state = null,
  holes = 18,
  par_mode = "published",
  publishedPars = null,
  players_count = 1,
  player_names = null,
  player_user_ids = null,
  shared_upcoming_round_id = null,
} = req.body || {};

    const result = await createRoundWithSeededHoles({
      userId,
      course,
      layout,
      state,
      holes,
      par_mode,
      publishedPars,
      players_count,
      player_names,
      player_user_ids,
      shared_upcoming_round_id,
    });

    if (!result?.ok) {
      return res.status(result?.status || 400).json({
        ok: false,
        error: result?.error || "invalid_request",
      });
    }

    return res.json(result);
  } catch (err) {
    console.error("POST /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Alias for older frontend
router.post("/create", requireAuth, async (req, res) => {
  req.url = "/";
  return router.handle(req, res);
});

// List my rounds
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });

    await ensureTeeRadarHandicapColumns();

const handicapRes = await db.query(
  `
  SELECT
    teeradar_handicap,
    teeradar_handicap_status,
    teeradar_handicap_rounds,
    teeradar_handicap_trend,
    teeradar_handicap_updated_at
  FROM users
  WHERE id = $1
  LIMIT 1;
  `,
  [userId]
);

const handicapRow = handicapRes.rows[0] || {};
    const { rows } = await db.query(
      `
      SELECT id, course, layout, state, holes, par_mode, created_at,
             players_count, player_names
      FROM rounds
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200;
      `,
      [userId]
    );

    return res.json({
  ok: true,
  rounds: rows,
  handicap: {
    value: handicapRow.teeradar_handicap,
    status: handicapRow.teeradar_handicap_status || "provisional",
    rounds: Number(handicapRow.teeradar_handicap_rounds || 0),
    trend: handicapRow.teeradar_handicap_trend,
    updated_at: handicapRow.teeradar_handicap_updated_at,
  },
});
  } catch (err) {
    console.error("GET /api/rounds error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  req.url = "/";
  return router.handle(req, res);
});

// -------------------------------------------------
// Friend profile: rounds + stats
// GET /api/rounds/friend/:friendUserId/profile
// -------------------------------------------------
router.get("/friend/:friendUserId/profile", requireAuth, async (req, res) => {
  try {
    const myUserId = Number(req.user?.id);
    const friendUserId = Number(req.params.friendUserId);

    if (!myUserId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(friendUserId) || friendUserId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid friend user id" });
    }

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
      [myUserId, friendUserId]
    );

    if (!friendship.rows.length) {
      return res.status(403).json({ ok: false, error: "not_friends" });
    }

    const friendRes = await db.query(
      `
      SELECT
  id,
  email,
  COALESCE(NULLIF(display_name, ''), email) AS name
FROM users
      WHERE id = $1
      LIMIT 1;
      `,
      [friendUserId]
    );

    const friend = friendRes.rows[0] || null;

    const roundsRes = await db.query(
      `
      SELECT
        r.id,
        r.course,
        r.layout,
        r.state,
        r.holes,
        r.created_at,
        r.players_count,
        r.player_names,
        COALESCE(SUM(rh.strokes), 0)::int AS total_score,
        COALESCE(SUM(rh.par), 0)::int AS total_par,
        COALESCE(SUM(rh.putts), 0)::int AS total_putts,
        COUNT(rh.id)::int AS holes_entered,

        COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par - 2 THEN 1 ELSE 0 END), 0)::int AS eagles,
        COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par - 1 THEN 1 ELSE 0 END), 0)::int AS birdies,
        COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par THEN 1 ELSE 0 END), 0)::int AS pars
      FROM rounds r
      LEFT JOIN round_holes rh ON rh.round_id = r.id
      WHERE r.user_id = $1
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 50;
      `,
      [friendUserId]
    );

    const rounds = (roundsRes.rows || []).map((r) => {
      const totalScore = Number(r.total_score || 0);
      const totalPar = Number(r.total_par || 0);
      const totalPutts = Number(r.total_putts || 0);
      const holesEntered = Number(r.holes_entered || 0);
      const holes = Number(r.holes || 0);
      const complete = holesEntered >= holes && totalScore > 0;

      return {
        ...r,
        total_score: totalScore,
        total_par: totalPar,
        total_putts: totalPutts,
        holes_entered: holesEntered,
        complete,
        score_vs_par: complete && totalPar > 0 ? totalScore - totalPar : null,
        eagles: Number(r.eagles || 0),
        birdies: Number(r.birdies || 0),
        pars: Number(r.pars || 0),
      };
    });

    const completed = rounds.filter((r) => r.complete);
    const completed9 = completed.filter((r) => Number(r.holes) === 9);
    const completed18 = completed.filter((r) => Number(r.holes) === 18);

    function avgScore(list) {
      if (!list.length) return null;
      return Math.round(list.reduce((sum, r) => sum + Number(r.total_score || 0), 0) / list.length);
    }

    function avgPutts(list) {
      if (!list.length) return null;
      return Math.round(list.reduce((sum, r) => sum + Number(r.total_putts || 0), 0) / list.length);
    }

    function bestScore(list) {
      if (!list.length) return null;
      return Math.min(...list.map((r) => Number(r.total_score || 0)).filter(Boolean));
    }

    const displayName =
  friend?.name && !String(friend.name).includes("@")
    ? String(friend.name)
    : friend?.email
      ? String(friend.email).split("@")[0]
      : "Friend";

    const myStatsRes = await db.query(
  `
  SELECT
    r.id,
    r.holes,
    COALESCE(SUM(rh.strokes), 0)::int AS total_score,
    COALESCE(SUM(rh.par), 0)::int AS total_par,
    COALESCE(SUM(rh.putts), 0)::int AS total_putts,
    COUNT(rh.id)::int AS holes_entered,
    COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par - 2 THEN 1 ELSE 0 END), 0)::int AS eagles,
    COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par - 1 THEN 1 ELSE 0 END), 0)::int AS birdies,
    COALESCE(SUM(CASE WHEN rh.strokes IS NOT NULL AND rh.par IS NOT NULL AND rh.strokes = rh.par THEN 1 ELSE 0 END), 0)::int AS pars
  FROM rounds r
  LEFT JOIN round_holes rh ON rh.round_id = r.id
  WHERE r.user_id = $1
  GROUP BY r.id
  `,
  [myUserId]
);

function buildStats(rows) {
  const all = (rows || []).map((r) => {
    const holes = Number(r.holes || 0);
    const score = Number(r.total_score || 0);
    const putts = Number(r.total_putts || 0);
    const holesEntered = Number(r.holes_entered || 0);
    const complete = holesEntered >= holes && score > 0;

    return {
      ...r,
      holes,
      total_score: score,
      total_putts: putts,
      complete,
      eagles: Number(r.eagles || 0),
      birdies: Number(r.birdies || 0),
      pars: Number(r.pars || 0),
    };
  }).filter((r) => r.complete);

  const r9 = all.filter((r) => r.holes === 9);
  const r18 = all.filter((r) => r.holes === 18);

  const avg = (list, key) =>
    list.length ? Math.round(list.reduce((s, r) => s + Number(r[key] || 0), 0) / list.length) : null;

  const best = (list) =>
    list.length ? Math.min(...list.map((r) => Number(r.total_score || 0)).filter(Boolean)) : null;

  return {
    rounds_played: all.length,
    best_score_9: best(r9),
    best_score_18: best(r18),
    average_score_9: avg(r9, "total_score"),
    average_score_18: avg(r18, "total_score"),
    average_putts_9: avg(r9, "total_putts"),
    average_putts_18: avg(r18, "total_putts"),
    total_eagles: all.reduce((s, r) => s + Number(r.eagles || 0), 0),
    total_birdies: all.reduce((s, r) => s + Number(r.birdies || 0), 0),
    total_pars: all.reduce((s, r) => s + Number(r.pars || 0), 0),
  };
}

const myStats = buildStats(myStatsRes.rows || []);
const friendStats = {
  rounds_played: completed.length,
  total_rounds: rounds.length,
  best_score_9: bestScore(completed9),
  best_score_18: bestScore(completed18),
  average_score_9: avgScore(completed9),
  average_score_18: avgScore(completed18),
  average_putts_9: avgPutts(completed9),
  average_putts_18: avgPutts(completed18),
  total_eagles: completed.reduce((sum, r) => sum + Number(r.eagles || 0), 0),
  total_birdies: completed.reduce((sum, r) => sum + Number(r.birdies || 0), 0),
  total_pars: completed.reduce((sum, r) => sum + Number(r.pars || 0), 0),
};

    return res.json({
  ok: true,
  friend: {
    ...(friend || {}),
    name: friend?.name || displayName,
  },
  stats: friendStats,
  myStats,
  compareStats: {
    me: myStats,
    friend: friendStats,
  },
  rounds,
});
  } catch (err) {
    console.error("GET /api/rounds/friend/:friendUserId/profile error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal error",
      detail: err?.message,
    });
  }
});

// Friend can view a shared round scorecard
router.get("/friend/:friendUserId/round/:roundId", requireAuth, async (req, res) => {
  try {
    const myUserId = Number(req.user?.id);
    const friendUserId = Number(req.params.friendUserId);
    const roundId = Number(req.params.roundId);

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
      [myUserId, friendUserId]
    );

    if (!friendship.rows.length) {
      return res.status(403).json({ ok: false, error: "not_friends" });
    }

    const data = await getRoundWithHoles(roundId);

    if (!data || Number(data.round.user_id) !== friendUserId) {
      return res.status(404).json({ ok: false, error: "round_not_found" });
    }

    return res.json({
      ok: true,
      round: data.round,
      holes: data.holes,
    });
  } catch (err) {
    console.error("GET friend round error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

router.post("/from-upcoming/:upcomingId", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const upcomingId = Number(req.params.upcomingId);

    if (!userId) return res.status(401).json({ ok: false, error: "unauthorised" });
    if (!Number.isFinite(upcomingId) || upcomingId <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_upcoming_id" });
    }

    await ensureSharedRoundColumns();

    const { rows } = await db.query(
      `
      SELECT *
      FROM upcoming_rounds ur
      WHERE ur.id = $1
        AND (
          ur.user_id = $2
          OR EXISTS (
            SELECT 1
            FROM upcoming_round_shares s
            WHERE s.upcoming_round_id = ur.id
              AND s.shared_with_user_id = $2
          )
        )
      LIMIT 1;
      `,
      [upcomingId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "upcoming_round_not_found" });
    }

    const upcoming = rows[0];

    const participantsRes = await db.query(
      `
      SELECT
        u.id,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
        CASE WHEN u.id = ur.user_id THEN 0 ELSE 1 END AS sort_order
      FROM upcoming_rounds ur
      JOIN users u ON u.id = ur.user_id
      WHERE ur.id = $1

      UNION ALL

      SELECT
        u.id,
        u.email,
        COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS name,
        1 AS sort_order
      FROM upcoming_round_shares s
      JOIN users u ON u.id = s.shared_with_user_id
      WHERE s.upcoming_round_id = $1

      ORDER BY sort_order ASC, name ASC
      LIMIT 4;
      `,
      [upcomingId]
    );

    const participants = participantsRes.rows || [];
    const playerNames = participants.map((p) => p.name || p.email || "Player");
    const playerUserIds = participants.map((p) => Number(p.id)).filter(Number.isFinite);
    const playersCount = Math.max(1, Math.min(4, participants.length || 1));

    let currentUserRound = null;
    let currentUserHoles = [];

    for (const p of participants) {
      const participantUserId = Number(p.id);
      if (!Number.isFinite(participantUserId)) continue;

      const existing = await db.query(
        `
        SELECT id
        FROM rounds
        WHERE user_id = $1
          AND shared_upcoming_round_id = $2
        ORDER BY created_at ASC
        LIMIT 1;
        `,
        [participantUserId, upcomingId]
      );

      let result = null;

      if (existing.rows.length) {
        result = await getRoundWithHoles(Number(existing.rows[0].id));
      } else {
        result = await createRoundWithSeededHoles({
          userId: participantUserId,
          course: upcoming.course,
          state: upcoming.state,
          holes: upcoming.holes || 18,
          layout: null,
          par_mode: "published",

          // current user's live scorecard shows all players
          players_count: participantUserId === userId ? playersCount : 1,
          player_names: participantUserId === userId ? playerNames : [p.name || p.email || "Player"],
          player_user_ids: participantUserId === userId ? playerUserIds : [participantUserId],

          shared_upcoming_round_id: upcomingId,
        });
      }

      if (participantUserId === userId) {
        currentUserRound = result?.round || null;
        currentUserHoles = result?.holes || [];
      }
    }

    if (!currentUserRound?.id) {
      return res.status(500).json({ ok: false, error: "current_user_round_not_created" });
    }

    return res.json({
      ok: true,
      roundId: currentUserRound.id,
      round: currentUserRound,
      holes: currentUserHoles,
      participants,
    });
  } catch (err) {
    console.error("POST /api/rounds/from-upcoming/:upcomingId error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal error",
      detail: err?.message,
    });
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

    const data = await getRoundWithHoles(roundId);
    if (!data) return res.status(404).json({ ok: false, error: "round not found" });

    if (data.round.user_id !== userId) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    return res.json({ ok: true, round: data.round, holes: data.holes });
  } catch (err) {
    console.error("GET /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Bulk save all holes
router.put("/:id", requireAuth, async (req, res) => {
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

    // ✅ Check whether this round had any scores BEFORE this save.
// If it had none, and this save adds the first score,
// friends should receive the "started a round" notification.
const beforeStartCheck = await db.query(
  `
  SELECT COUNT(*)::int AS scored_holes
  FROM round_holes
  WHERE round_id = $1
    AND (
      strokes IS NOT NULL
      OR (
        strokes_by_player IS NOT NULL
        AND strokes_by_player <> '{}'::jsonb
      )
    );
  `,
  [roundId]
);

const hadStartedBefore =
  Number(beforeStartCheck.rows[0]?.scored_holes || 0) > 0;

    const holes = req.body?.holes;
    if (!Array.isArray(holes)) {
      return res.status(400).json({ ok: false, error: "holes array is required" });
    }

    const newPlayersCount = clampPlayers(
      req.body?.players_count ?? req.body?.playersCount ?? owner.players_count ?? 1
    );

    let newPlayerNames = [];
    if (Array.isArray(req.body?.player_names)) {
      newPlayerNames = req.body.player_names.map((x) => String(x || "").trim());
    }
    newPlayerNames.length = newPlayersCount;

    await ensurePlayerNamesColumn();

    await db.query("BEGIN");

    // ✅ FIX: update round metadata INSIDE the transaction
    await db.query(
      `
      UPDATE rounds
      SET players_count = $2,
          player_names = $3::jsonb
      WHERE id = $1;
      `,
      [roundId, newPlayersCount, JSON.stringify(newPlayerNames)]
    );

    for (const h of holes) {
      const holeNum = Number(h?.hole_number ?? h?.hole ?? h?.number);
      if (!Number.isFinite(holeNum) || holeNum <= 0) continue;

      const parVal =
        h?.par === null || typeof h?.par === "undefined" || h?.par === ""
          ? null
          : Number(h.par);

      const distVal =
        h?.distance_m === null || typeof h?.distance_m === "undefined" || h?.distance_m === ""
          ? h?.distance === null || typeof h?.distance === "undefined" || h?.distance === ""
            ? null
            : Number(h.distance)
          : Number(h.distance_m);

      const strokesMap = cleanPlayerMap(h?.strokes_by_player || h?.strokesByPlayer || {});
      const puttsMap = cleanPlayerMap(h?.putts_by_player || h?.puttsByPlayer || {});

      // keep old compatibility: strokes/putts represent Player 1
      const strokesVal =
        typeof strokesMap["1"] !== "undefined"
          ? strokesMap["1"]
          : h?.strokes === null || typeof h?.strokes === "undefined" || h?.strokes === ""
            ? null
            : Number(h.strokes);

      const puttsVal =
        typeof puttsMap["1"] !== "undefined"
          ? puttsMap["1"]
          : h?.putts === null || typeof h?.putts === "undefined" || h?.putts === ""
            ? null
            : Number(h.putts);

      await db.query(
        `
        INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        ON CONFLICT (round_id, hole_number) DO UPDATE SET
          par = EXCLUDED.par,
          distance_m = EXCLUDED.distance_m,
          strokes = EXCLUDED.strokes,
          putts = EXCLUDED.putts,
          strokes_by_player = EXCLUDED.strokes_by_player,
          putts_by_player = EXCLUDED.putts_by_player;
        `,
        [
          roundId,
          holeNum,
          Number.isFinite(parVal) ? parVal : null,
          Number.isFinite(distVal) ? distVal : null,
          Number.isFinite(strokesVal) ? strokesVal : null,
          Number.isFinite(puttsVal) ? puttsVal : null,
          JSON.stringify(strokesMap),
          JSON.stringify(puttsMap),
        ]
      );
    }

    await db.query("COMMIT");

    await db.query("COMMIT");

const data = await getRoundWithHoles(roundId);

// ✅ If this save entered the first score of the round,
// notify all accepted friends once.
if (!hadStartedBefore) {
  const hasScoreNow = (holes || []).some((h) => {
    const strokesMap = cleanPlayerMap(
      h?.strokes_by_player || h?.strokesByPlayer || {}
    );

    if (Object.keys(strokesMap).length > 0) {
      return true;
    }

    const strokes =
      h?.strokes === null ||
      typeof h?.strokes === "undefined" ||
      h?.strokes === ""
        ? null
        : Number(h.strokes);

    return Number.isFinite(strokes);
  });

  if (hasScoreNow) {
    try {
      await notifyFriendsRoundStarted({
        userId,
        roundId,
        course: data?.round?.course,
        layout: data?.round?.layout,
      });
    } catch (notifyErr) {
      console.warn(
        "FRIEND_STARTED_ROUND notification failed:",
        notifyErr?.message || notifyErr
      );
    }
  }
}

try {
  await syncSharedPlayerRounds(roundId, holes);
} catch (syncErr) {
  console.warn("syncSharedPlayerRounds failed:", syncErr?.message || syncErr);
}

    // ✅ ADDED: if the payload looks "complete", record round_played once (deduped by round_id)
    try {
      const holesCount = Number(data?.round?.holes);
      const complete = isCompleteFromPayload(holes, holesCount);

      if (complete) {
        await recordEvent({
          type: "round_played",
          userId: String(userId),
          courseName: data?.round?.course || null,
          roundId: Number(roundId),
        });
      }
    } catch (e) {
      console.warn("round_played analytics failed:", e?.message || e);
    }

    let handicap = null;

try {
  handicap = await recalculateTeeRadarHandicap(userId);
} catch (hErr) {
  console.warn("TeeRadar handicap recalculation failed:", hErr?.message || hErr);
}

return res.json({ ok: true, round: data.round, holes: data.holes, handicap });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("PUT /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error", detail: err?.message });
  }
});

// Single-hole update (older route)
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

    const { strokes, putts, par, distance_m, distance } = req.body || {};

    const strokesVal =
      strokes === null || typeof strokes === "undefined" || strokes === "" ? null : Number(strokes);

    const puttsVal =
      putts === null || typeof putts === "undefined" || putts === "" ? null : Number(putts);

    const parVal = par === null || typeof par === "undefined" || par === "" ? null : Number(par);

    const distValRaw = typeof distance_m !== "undefined" ? distance_m : distance;
    const distVal =
      distValRaw === null || typeof distValRaw === "undefined" || distValRaw === ""
        ? null
        : Number(distValRaw);

    await db.query(
      `
      INSERT INTO round_holes (round_id, hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player)
      VALUES ($1, $2, NULL, NULL, NULL, NULL, '{}'::jsonb, '{}'::jsonb)
      ON CONFLICT (round_id, hole_number) DO NOTHING;
      `,
      [roundId, holeNum]
    );

    const result = await db.query(
      `
      UPDATE round_holes
      SET
        strokes = $3,
        putts = $4,
        par = COALESCE($5, par),
        distance_m = COALESCE($6, distance_m)
      WHERE round_id = $1 AND hole_number = $2
      RETURNING hole_number, par, distance_m, strokes, putts, strokes_by_player, putts_by_player;
      `,
      [
        roundId,
        holeNum,
        Number.isFinite(strokesVal) ? strokesVal : null,
        Number.isFinite(puttsVal) ? puttsVal : null,
        Number.isFinite(parVal) ? parVal : null,
        Number.isFinite(distVal) ? distVal : null,
      ]
    );

    return res.json({ ok: true, hole: result.rows[0] || null });
  } catch (err) {
    console.error("PUT /api/rounds/:id/hole/:n error:", err);
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

let handicap = null;

try {
  handicap = await recalculateTeeRadarHandicap(userId);
} catch (hErr) {
  console.warn("TeeRadar handicap recalculation after delete failed:", hErr?.message || hErr);
}

return res.json({ ok: true, deleted: result.rowCount || 0, handicap });
  } catch (err) {
    console.error("DELETE /api/rounds/:id error:", err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

export default router;
