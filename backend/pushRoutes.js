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
    return { sent: 0 };
  }

  const { rows } = await db.query(
    `
    SELECT token
    FROM mobile_push_tokens
    WHERE LOWER(email) = LOWER($1)
    `,
    [targetEmail]
  );

  let sent = 0;

  for (const row of rows || []) {
    try {
      await admin.messaging().send({
        token: row.token,

        notification: {
          title: payload.title || "TeeRadar",
          body: payload.body || "You have a new notification.",
        },

        data: {
          url: payload.url || "/index.html",
          type: payload.type || "GENERAL"
        }
      });

      sent++;
    } catch (err) {
      console.warn("firebase push failed:", err?.message || err);
    }
  }

  return { sent };
}

export default router;
