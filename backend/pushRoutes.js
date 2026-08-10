// backend/pushRoutes.js
import express from "express";
import webpush from "web-push";
import admin from "firebase-admin";
import db from "./db.js";

const router = express.Router();

// =========================
// FIREBASE ADMIN
// =========================
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: String(
          process.env.FIREBASE_PRIVATE_KEY || ""
        ).replace(/\\n/g, "\n"),
      }),
    });

    console.log("✅ Firebase Admin initialised");
  } catch (err) {
    console.error("❌ Firebase Admin init failed:", err);
  }
}

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(
  process.env.VAPID_SUBJECT || "mailto:teeradar.help@gmail.com"
).trim();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️ Push notifications not configured: missing VAPID keys");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
async function ensureNotificationInboxTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'GENERAL',
      url TEXT NOT NULL DEFAULT '/index.html',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_email_created_idx
    ON user_notifications (LOWER(email), created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
    ON user_notifications (LOWER(email), read_at);
  `);
}

ensureNotificationInboxTable()
  .then(() => console.log("✅ user_notifications table ready"))
  .catch((err) => console.warn("⚠️ user_notifications table failed:", err?.message || err));

async function saveNotificationForEmail(email, payload = {}) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const title = String(payload.title || "TeeRadar");
  const body = String(payload.body || "You have a new notification.");
  const type = String(payload.type || "GENERAL");
  const url = String(payload.url || "/index.html");
  const meta = payload.meta || {};

  const existing = await db.query(
  `
  SELECT id
  FROM user_notifications
  WHERE LOWER(email) = LOWER($1)
    AND title = $2
    AND body = $3
    AND type = $4
    AND created_at > now() - interval '2 minutes'
  ORDER BY created_at DESC
  LIMIT 1
  `,
  [targetEmail, title, body, type]
);

if (existing.rows.length) {
  return existing.rows[0].id;
}
  
  const { rows } = await db.query(
    `
    INSERT INTO user_notifications (
      email,
      title,
      body,
      type,
      url,
      meta
    )
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    RETURNING id
    `,
    [
      targetEmail,
      title,
      body,
      type,
      url,
      JSON.stringify(meta)
    ]
  );

  return rows?.[0]?.id || null;
}

export async function sendPushToEmail(email, payload = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, removed: 0 };

  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return { sent: 0, removed: 0 };

  const { rows } = await db.query(
    `
    SELECT endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE LOWER(email) = LOWER($1)
    ORDER BY updated_at DESC
    `,
    [targetEmail]
  );

  let sent = 0;
  let removed = 0;

  for (const row of rows || []) {
    const subscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth,
      },
    };

    try {
      await webpush.sendNotification(
  subscription,
  JSON.stringify({
    title: payload.title || "TeeRadar",
    body: payload.body || "You have a new notification.",
    url: payload.url || "/index.html",
    type: payload.type || "GENERAL",
    meta: payload.meta || {},
  })
);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [row.endpoint]);
        removed++;
      } else {
        console.warn("push send failed:", err?.message || err);
      }
    }
  }

  return { sent, removed };
}

router.get("/public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      ok: false,
      error: "vapid_public_key_missing",
    });
  }

  res.json({
    ok: true,
    publicKey: VAPID_PUBLIC_KEY,
  });
});

router.post("/subscribe", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const subscription = req.body?.subscription;

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ ok: false, error: "invalid_subscription" });
    }

    await db.query(
      `
      INSERT INTO push_subscriptions (
        email,
        endpoint,
        p256dh,
        auth,
        user_agent,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,now())
      ON CONFLICT (endpoint)
      DO UPDATE SET
        email = EXCLUDED.email,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        updated_at = now()
      `,
      [
        email,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        String(req.headers["user-agent"] || ""),
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("push subscribe error:", err);
    res.status(500).json({ ok: false, error: "push_subscribe_failed" });
  }
});

router.post("/unsubscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || "").trim();

    if (!endpoint) {
      return res.status(400).json({ ok: false, error: "endpoint_required" });
    }

    await db.query(
      `
      DELETE FROM push_subscriptions
      WHERE endpoint = $1
      `,
      [endpoint]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("push unsubscribe error:", err);
    res.status(500).json({ ok: false, error: "push_unsubscribe_failed" });
  }
});

// =========================
// MOBILE PUSH TOKEN REGISTER
// =========================
router.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const token = String(req.body?.token || "").trim();
    const platform = String(req.body?.platform || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required",
      });
    }

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "token_required",
      });
    }

     await db.query(
      `
      INSERT INTO mobile_push_tokens (
        email,
        token,
        platform,
        updated_at
      )
      VALUES ($1,$2,$3,now())
      ON CONFLICT (token)
      DO UPDATE SET
        email = EXCLUDED.email,
        platform = EXCLUDED.platform,
        updated_at = now()
      `,
      [
        email,
        token,
        platform
      ]
    );

    console.log("✅ mobile push token registered", {
      email,
      platform,
      tokenPreview: token.slice(0, 12) + "..."
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("mobile push register error:", err);

    res.status(500).json({
      ok: false,
      error: "mobile_push_register_failed",
    });
  }
});

router.post("/test", async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(500).json({ ok: false, error: "push_not_configured" });
    }

    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    const { rows } = await db.query(
      `
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE LOWER(email) = LOWER($1)
      ORDER BY updated_at DESC
      `,
      [email]
    );

    let sent = 0;
    let removed = 0;

    for (const row of rows || []) {
      const subscription = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      };

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: "TeeRadar",
            body: "Push notifications are working.",
            url: "/index.html",
          })
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query(
            `DELETE FROM push_subscriptions WHERE endpoint = $1`,
            [row.endpoint]
          );
          removed++;
        } else {
          console.warn("push test send failed:", err?.message || err);
        }
      }
    }

    res.json({ ok: true, sent, removed });
  } catch (err) {
    console.error("push test error:", err);
    res.status(500).json({ ok: false, error: "push_test_failed" });
  }
});
// =========================
// FIREBASE MOBILE PUSH
// =========================
export async function sendMobilePushToEmail(email, payload = {}) {
  const targetEmail = normalizeEmail(email);

  if (!targetEmail) {
    return { sent: 0, removed: 0 };
  }
    const notificationId = await saveNotificationForEmail(targetEmail, payload);

  const { rows } = await db.query(
    `
    SELECT token
    FROM mobile_push_tokens
    WHERE LOWER(email) = LOWER($1)
    ORDER BY updated_at DESC
    `,
    [targetEmail]
  );

  let sent = 0;
  let removed = 0;

  for (const row of rows || []) {
    try {
      await admin.messaging().send({
        token: row.token,

        notification: {
          title: String(payload.title || "TeeRadar"),
          body: String(payload.body || "You have a new notification."),
        },

                data: {
  url: String(
    payload.type === "TEE_TIME_ALERT" && notificationId
      ? `/alert-results.html?notificationId=${notificationId}`
      : payload.url || "/index.html"
  ),

  type: String(payload.type || "GENERAL"),

  notificationId: String(notificationId || ""),

  roundId: String(
    payload.roundId ||
    payload.round_id ||
    payload.meta?.roundId ||
    payload.meta?.round_id ||
    ""
  ),

  friendUserId: String(
    payload.friendUserId ||
    payload.friend_user_id ||
    payload.meta?.friendUserId ||
    payload.meta?.friend_user_id ||
    ""
  ),

  upcomingId: String(
    payload.upcomingId ||
    payload.upcoming_id ||
    payload.meta?.upcomingId ||
    payload.meta?.upcoming_id ||
    ""
  ),
},
      });

      sent++;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn("firebase push failed:", msg);

      if (
        msg.includes("not a valid FCM registration token") ||
        msg.includes("registration-token-not-registered") ||
        msg.includes("Requested entity was not found")
      ) {
        await db.query(
          `DELETE FROM mobile_push_tokens WHERE token = $1`,
          [row.token]
        );
        removed++;
      }
    }
  }

  return { sent, removed };
}

// =========================
// TEST MOBILE PUSH
// =========================
router.post("/mobile-test", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required"
      });
    }

    const { rows } = await db.query(
      `
      SELECT token
      FROM mobile_push_tokens
      WHERE LOWER(email) = LOWER($1)
      ORDER BY updated_at DESC
      `,
      [email]
    );

    let sent = 0;
    const errors = [];

    for (const row of rows || []) {
      try {
        await admin.messaging().send({
          token: row.token,
          notification: {
            title: "TeeRadar",
            body: "iPhone push notifications are now working 🎉"
          },
          data: {
            url: "/index.html",
            type: "TEST"
          }
        });

        sent++;
            } catch (err) {
        const msg = err?.message || String(err);
        errors.push(msg);
        console.warn("mobile test push send failed:", msg);

        if (
          msg.includes("not a valid FCM registration token") ||
          msg.includes("registration-token-not-registered")
        ) {
          await db.query(
            `DELETE FROM mobile_push_tokens WHERE token = $1`,
            [row.token]
          );
        }
      }
    }

    res.json({
      ok: true,
      found: rows.length,
      sent,
      errors
    });
  } catch (err) {
    console.error("mobile test push error:", err);

    res.status(500).json({
      ok: false,
      error: "mobile_test_push_failed",
      detail: err.message
    });
  }
});
// =========================
// DEBUG MOBILE PUSH TOKENS
// =========================
router.get("/mobile-debug", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);

    const { rows } = await db.query(
      `
      SELECT email, platform, updated_at, LEFT(token, 16) AS token_preview
      FROM mobile_push_tokens
      WHERE ($1 = '' OR LOWER(email) = LOWER($1))
      ORDER BY updated_at DESC
      LIMIT 20
      `,
      [email]
    );

    res.json({
      ok: true,
      count: rows.length,
      rows
    });
  } catch (err) {
    console.error("mobile push debug error:", err);
    res.status(500).json({ ok: false, error: "mobile_push_debug_failed" });
  }
});
// =========================
// NOTIFICATION INBOX
// =========================
router.get("/notifications", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required"
      });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        title,
        body,
        type,
        url,
        meta,
        read_at,
        created_at
      FROM user_notifications
      WHERE LOWER(email) = LOWER($1)
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [email]
    );

    const unreadResult = await db.query(
      `
      SELECT COUNT(*)::int AS unread
      FROM user_notifications
      WHERE LOWER(email) = LOWER($1)
        AND read_at IS NULL
      `,
      [email]
    );

    res.json({
      ok: true,
      unread: Number(unreadResult.rows?.[0]?.unread || 0),
      notifications: rows || []
    });
  } catch (err) {
    console.error("notifications list error:", err);
    res.status(500).json({ ok: false, error: "notifications_failed" });
  }
});

router.get("/notifications/:id", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);
    const id = Number(req.params.id || 0);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "id_required" });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        title,
        body,
        type,
        url,
        meta,
        read_at,
        created_at
      FROM user_notifications
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      LIMIT 1
      `,
      [id, email]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "notification_not_found" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      `,
      [id, email]
    );

    res.json({
      ok: true,
      notification: rows[0]
    });
  } catch (err) {
    console.error("notification detail error:", err);
    res.status(500).json({ ok: false, error: "notification_detail_failed" });
  }
});

router.post("/notifications/read", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const id = Number(req.body?.id || 0);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "id_required" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      `,
      [id, email]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("notification read error:", err);
    res.status(500).json({ ok: false, error: "notification_read_failed" });
  }
});

router.post("/notifications/read-all", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE LOWER(email) = LOWER($1)
        AND read_at IS NULL
      `,
      [email]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("notifications read-all error:", err);
    res.status(500).json({ ok: false, error: "notifications_read_all_failed" });
  }
});
export default router;// backend/pushRoutes.js
import express from "express";
import webpush from "web-push";
import admin from "firebase-admin";
import db from "./db.js";

const router = express.Router();

// =========================
// FIREBASE ADMIN
// =========================
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: String(
          process.env.FIREBASE_PRIVATE_KEY || ""
        ).replace(/\\n/g, "\n"),
      }),
    });

    console.log("✅ Firebase Admin initialised");
  } catch (err) {
    console.error("❌ Firebase Admin init failed:", err);
  }
}

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(
  process.env.VAPID_SUBJECT || "mailto:teeradar.help@gmail.com"
).trim();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn("⚠️ Push notifications not configured: missing VAPID keys");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
async function ensureNotificationInboxTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'GENERAL',
      url TEXT NOT NULL DEFAULT '/index.html',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_email_created_idx
    ON user_notifications (LOWER(email), created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
    ON user_notifications (LOWER(email), read_at);
  `);
}

ensureNotificationInboxTable()
  .then(() => console.log("✅ user_notifications table ready"))
  .catch((err) => console.warn("⚠️ user_notifications table failed:", err?.message || err));

async function saveNotificationForEmail(email, payload = {}) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const title = String(payload.title || "TeeRadar");
  const body = String(payload.body || "You have a new notification.");
  const type = String(payload.type || "GENERAL");
  const url = String(payload.url || "/index.html");
  const meta = payload.meta || {};

  const existing = await db.query(
  `
  SELECT id
  FROM user_notifications
  WHERE LOWER(email) = LOWER($1)
    AND title = $2
    AND body = $3
    AND type = $4
    AND created_at > now() - interval '2 minutes'
  ORDER BY created_at DESC
  LIMIT 1
  `,
  [targetEmail, title, body, type]
);

if (existing.rows.length) {
  return existing.rows[0].id;
}
  
  const { rows } = await db.query(
    `
    INSERT INTO user_notifications (
      email,
      title,
      body,
      type,
      url,
      meta
    )
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    RETURNING id
    `,
    [
      targetEmail,
      title,
      body,
      type,
      url,
      JSON.stringify(meta)
    ]
  );

  return rows?.[0]?.id || null;
}

export async function sendPushToEmail(email, payload = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, removed: 0 };

  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return { sent: 0, removed: 0 };

  const { rows } = await db.query(
    `
    SELECT endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE LOWER(email) = LOWER($1)
    ORDER BY updated_at DESC
    `,
    [targetEmail]
  );

  let sent = 0;
  let removed = 0;

  for (const row of rows || []) {
    const subscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth,
      },
    };

    try {
      await webpush.sendNotification(
  subscription,
  JSON.stringify({
    title: payload.title || "TeeRadar",
    body: payload.body || "You have a new notification.",
    url: payload.url || "/index.html",
    type: payload.type || "GENERAL",
    meta: payload.meta || {},
  })
);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [row.endpoint]);
        removed++;
      } else {
        console.warn("push send failed:", err?.message || err);
      }
    }
  }

  return { sent, removed };
}

router.get("/public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      ok: false,
      error: "vapid_public_key_missing",
    });
  }

  res.json({
    ok: true,
    publicKey: VAPID_PUBLIC_KEY,
  });
});

router.post("/subscribe", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const subscription = req.body?.subscription;

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ ok: false, error: "invalid_subscription" });
    }

    await db.query(
      `
      INSERT INTO push_subscriptions (
        email,
        endpoint,
        p256dh,
        auth,
        user_agent,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,now())
      ON CONFLICT (endpoint)
      DO UPDATE SET
        email = EXCLUDED.email,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        updated_at = now()
      `,
      [
        email,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        String(req.headers["user-agent"] || ""),
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("push subscribe error:", err);
    res.status(500).json({ ok: false, error: "push_subscribe_failed" });
  }
});

router.post("/unsubscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || "").trim();

    if (!endpoint) {
      return res.status(400).json({ ok: false, error: "endpoint_required" });
    }

    await db.query(
      `
      DELETE FROM push_subscriptions
      WHERE endpoint = $1
      `,
      [endpoint]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("push unsubscribe error:", err);
    res.status(500).json({ ok: false, error: "push_unsubscribe_failed" });
  }
});

// =========================
// MOBILE PUSH TOKEN REGISTER
// =========================
router.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const token = String(req.body?.token || "").trim();
    const platform = String(req.body?.platform || "").trim();

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required",
      });
    }

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "token_required",
      });
    }

     await db.query(
      `
      INSERT INTO mobile_push_tokens (
        email,
        token,
        platform,
        updated_at
      )
      VALUES ($1,$2,$3,now())
      ON CONFLICT (token)
      DO UPDATE SET
        email = EXCLUDED.email,
        platform = EXCLUDED.platform,
        updated_at = now()
      `,
      [
        email,
        token,
        platform
      ]
    );

    console.log("✅ mobile push token registered", {
      email,
      platform,
      tokenPreview: token.slice(0, 12) + "..."
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("mobile push register error:", err);

    res.status(500).json({
      ok: false,
      error: "mobile_push_register_failed",
    });
  }
});

router.post("/test", async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(500).json({ ok: false, error: "push_not_configured" });
    }

    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    const { rows } = await db.query(
      `
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE LOWER(email) = LOWER($1)
      ORDER BY updated_at DESC
      `,
      [email]
    );

    let sent = 0;
    let removed = 0;

    for (const row of rows || []) {
      const subscription = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      };

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: "TeeRadar",
            body: "Push notifications are working.",
            url: "/index.html",
          })
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query(
            `DELETE FROM push_subscriptions WHERE endpoint = $1`,
            [row.endpoint]
          );
          removed++;
        } else {
          console.warn("push test send failed:", err?.message || err);
        }
      }
    }

    res.json({ ok: true, sent, removed });
  } catch (err) {
    console.error("push test error:", err);
    res.status(500).json({ ok: false, error: "push_test_failed" });
  }
});
// =========================
// FIREBASE MOBILE PUSH
// =========================
export async function sendMobilePushToEmail(email, payload = {}) {
  const targetEmail = normalizeEmail(email);

  if (!targetEmail) {
    return { sent: 0, removed: 0 };
  }
    const notificationId = await saveNotificationForEmail(targetEmail, payload);

  const { rows } = await db.query(
    `
    SELECT token
    FROM mobile_push_tokens
    WHERE LOWER(email) = LOWER($1)
    ORDER BY updated_at DESC
    `,
    [targetEmail]
  );

  let sent = 0;
  let removed = 0;

  for (const row of rows || []) {
    try {
      await admin.messaging().send({
        token: row.token,

        notification: {
          title: String(payload.title || "TeeRadar"),
          body: String(payload.body || "You have a new notification."),
        },

                data: {
  url: String(
    payload.type === "TEE_TIME_ALERT" && notificationId
      ? `/alert-results.html?notificationId=${notificationId}`
      : payload.url || "/index.html"
  ),
  type: String(payload.type || "GENERAL"),
  notificationId: String(notificationId || ""),
},
      });

      sent++;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn("firebase push failed:", msg);

      if (
        msg.includes("not a valid FCM registration token") ||
        msg.includes("registration-token-not-registered") ||
        msg.includes("Requested entity was not found")
      ) {
        await db.query(
          `DELETE FROM mobile_push_tokens WHERE token = $1`,
          [row.token]
        );
        removed++;
      }
    }
  }

  return { sent, removed };
}

// =========================
// TEST MOBILE PUSH
// =========================
router.post("/mobile-test", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required"
      });
    }

    const { rows } = await db.query(
      `
      SELECT token
      FROM mobile_push_tokens
      WHERE LOWER(email) = LOWER($1)
      ORDER BY updated_at DESC
      `,
      [email]
    );

    let sent = 0;
    const errors = [];

    for (const row of rows || []) {
      try {
        await admin.messaging().send({
          token: row.token,
          notification: {
            title: "TeeRadar",
            body: "iPhone push notifications are now working 🎉"
          },
          data: {
            url: "/index.html",
            type: "TEST"
          }
        });

        sent++;
            } catch (err) {
        const msg = err?.message || String(err);
        errors.push(msg);
        console.warn("mobile test push send failed:", msg);

        if (
          msg.includes("not a valid FCM registration token") ||
          msg.includes("registration-token-not-registered")
        ) {
          await db.query(
            `DELETE FROM mobile_push_tokens WHERE token = $1`,
            [row.token]
          );
        }
      }
    }

    res.json({
      ok: true,
      found: rows.length,
      sent,
      errors
    });
  } catch (err) {
    console.error("mobile test push error:", err);

    res.status(500).json({
      ok: false,
      error: "mobile_test_push_failed",
      detail: err.message
    });
  }
});
// =========================
// DEBUG MOBILE PUSH TOKENS
// =========================
router.get("/mobile-debug", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);

    const { rows } = await db.query(
      `
      SELECT email, platform, updated_at, LEFT(token, 16) AS token_preview
      FROM mobile_push_tokens
      WHERE ($1 = '' OR LOWER(email) = LOWER($1))
      ORDER BY updated_at DESC
      LIMIT 20
      `,
      [email]
    );

    res.json({
      ok: true,
      count: rows.length,
      rows
    });
  } catch (err) {
    console.error("mobile push debug error:", err);
    res.status(500).json({ ok: false, error: "mobile_push_debug_failed" });
  }
});
// =========================
// NOTIFICATION INBOX
// =========================
router.get("/notifications", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required"
      });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        title,
        body,
        type,
        url,
        meta,
        read_at,
        created_at
      FROM user_notifications
      WHERE LOWER(email) = LOWER($1)
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [email]
    );

    const unreadResult = await db.query(
      `
      SELECT COUNT(*)::int AS unread
      FROM user_notifications
      WHERE LOWER(email) = LOWER($1)
        AND read_at IS NULL
      `,
      [email]
    );

    res.json({
      ok: true,
      unread: Number(unreadResult.rows?.[0]?.unread || 0),
      notifications: rows || []
    });
  } catch (err) {
    console.error("notifications list error:", err);
    res.status(500).json({ ok: false, error: "notifications_failed" });
  }
});

router.get("/notifications/:id", async (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);
    const id = Number(req.params.id || 0);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "id_required" });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        title,
        body,
        type,
        url,
        meta,
        read_at,
        created_at
      FROM user_notifications
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      LIMIT 1
      `,
      [id, email]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "notification_not_found" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      `,
      [id, email]
    );

    res.json({
      ok: true,
      notification: rows[0]
    });
  } catch (err) {
    console.error("notification detail error:", err);
    res.status(500).json({ ok: false, error: "notification_detail_failed" });
  }
});

router.post("/notifications/read", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const id = Number(req.body?.id || 0);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "id_required" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE id = $1
        AND LOWER(email) = LOWER($2)
      `,
      [id, email]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("notification read error:", err);
    res.status(500).json({ ok: false, error: "notification_read_failed" });
  }
});

router.post("/notifications/read-all", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    await db.query(
      `
      UPDATE user_notifications
      SET read_at = COALESCE(read_at, now())
      WHERE LOWER(email) = LOWER($1)
        AND read_at IS NULL
      `,
      [email]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("notifications read-all error:", err);
    res.status(500).json({ ok: false, error: "notifications_read_all_failed" });
  }
});
export default router;
