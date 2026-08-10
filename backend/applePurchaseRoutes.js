// backend/applePurchaseRoutes.js

import express from "express";
import jwt from "jsonwebtoken";

import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

import db from "./db.js";

import {
  getApplePlanDetails,
  isAllowedAppleProduct,
} from "./appleSubscriptionPlans.js";

const router = express.Router();

const APPLE_BUNDLE_ID = String(
  process.env.APPLE_BUNDLE_ID || "au.com.teeradar.app"
).trim();

const APPLE_APP_ID = Number(
  String(process.env.APPLE_APP_ID || "").trim()
);

const APPLE_ENABLE_ONLINE_CHECKS =
  String(process.env.APPLE_ENABLE_ONLINE_CHECKS || "true")
    .trim()
    .toLowerCase() !== "false";

/*
  Add the Apple root certificates to Render as Base64 strings.

  Supported formats:

  APPLE_ROOT_CA_BASE64=<one certificate>

  or:

  APPLE_ROOT_CA_BASE64=<certificate1>,<certificate2>,<certificate3>
*/
function loadAppleRootCertificates() {
  const raw = String(
    process.env.APPLE_ROOT_CA_BASE64 || ""
  ).trim();

  if (!raw) {
    throw new Error(
      "APPLE_ROOT_CA_BASE64 is not configured"
    );
  }

  const entries = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const certificates = entries.map((value) => {
    const clean = value
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, "");

    return Buffer.from(clean, "base64");
  });

  if (!certificates.length) {
    throw new Error(
      "No valid Apple root certificates were configured"
    );
  }

  return certificates;
}

let verifierCache = null;

function getAppleVerifiers() {
  if (verifierCache) return verifierCache;

  if (!APPLE_BUNDLE_ID) {
    throw new Error("APPLE_BUNDLE_ID is not configured");
  }

  const rootCertificates = loadAppleRootCertificates();

  const sandboxVerifier = new SignedDataVerifier(
    rootCertificates,
    APPLE_ENABLE_ONLINE_CHECKS,
    Environment.SANDBOX,
    APPLE_BUNDLE_ID,
    undefined
  );

  /*
    Apple requires the numerical App Apple ID for production
    SignedDataVerifier checks.
  */
  const productionVerifier = Number.isFinite(APPLE_APP_ID)
    ? new SignedDataVerifier(
        rootCertificates,
        APPLE_ENABLE_ONLINE_CHECKS,
        Environment.PRODUCTION,
        APPLE_BUNDLE_ID,
        APPLE_APP_ID
      )
    : null;

  verifierCache = {
    sandboxVerifier,
    productionVerifier,
  };

  return verifierCache;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getJwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.AUTH_JWT_SECRET ||
    process.env.AUTH_SECRET ||
    ""
  );
}

function getEmailFromRequest(req) {
  const suppliedEmail = normalizeEmail(
    req.body?.email || req.query?.email
  );

  const authHeader = String(
    req.headers.authorization || ""
  );

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : "";

  if (!token) {
    return suppliedEmail;
  }

  const secret = getJwtSecret();

  try {
    const payload = secret
      ? jwt.verify(token, secret)
      : jwt.decode(token);

    const tokenEmail = normalizeEmail(
      payload?.email ||
      payload?.userEmail ||
      payload?.sub
    );

    /*
      When a token contains an email, use it rather than trusting
      an arbitrary email supplied in the body.
    */
    return tokenEmail || suppliedEmail;
  } catch {
    return suppliedEmail;
  }
}

function appleDateToIso(value) {
  if (
    value === null ||
    typeof value === "undefined" ||
    value === ""
  ) {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  /*
    Apple dates in decoded transaction payloads are milliseconds
    since the Unix epoch.
  */
  const date = new Date(numeric);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function normalizeEnvironment(value) {
  const environment = String(value || "")
    .trim()
    .toLowerCase();

  if (environment.includes("sandbox")) {
    return "Sandbox";
  }

  if (environment.includes("production")) {
    return "Production";
  }

  return value ? String(value) : null;
}

function transactionIsEntitled(transaction) {
  if (!transaction) return false;

  const expiresMs = Number(transaction.expiresDate);
  const revokedMs = Number(transaction.revocationDate);

  if (Number.isFinite(revokedMs) && revokedMs > 0) {
    return false;
  }

  if (!Number.isFinite(expiresMs)) {
    return false;
  }

  return expiresMs > Date.now();
}

async function verifySignedTransaction(signedTransactionInfo) {
  const signedValue = String(
    signedTransactionInfo || ""
  ).trim();

  if (!signedValue) {
    throw new Error("signedTransactionInfo is required");
  }

  const {
    productionVerifier,
    sandboxVerifier,
  } = getAppleVerifiers();

  let productionError = null;

  if (productionVerifier) {
    try {
      const transaction =
        await productionVerifier.verifyAndDecodeTransaction(
          signedValue
        );

      return {
        transaction,
        verifiedEnvironment: "Production",
      };
    } catch (error) {
      productionError = error;
    }
  }

  try {
    const transaction =
      await sandboxVerifier.verifyAndDecodeTransaction(
        signedValue
      );

    return {
      transaction,
      verifiedEnvironment: "Sandbox",
    };
  } catch (sandboxError) {
    console.error("Apple transaction verification failed", {
      productionError:
        productionError?.message || null,
      sandboxError:
        sandboxError?.message || String(sandboxError),
    });

    throw new Error(
      "Apple transaction signature could not be verified"
    );
  }
}

async function verifySignedNotification(signedPayload) {
  const payload = String(signedPayload || "").trim();

  if (!payload) {
    throw new Error("signedPayload is required");
  }

  const {
    productionVerifier,
    sandboxVerifier,
  } = getAppleVerifiers();

  let productionError = null;

  if (productionVerifier) {
    try {
      const notification =
        await productionVerifier.verifyAndDecodeNotification(
          payload
        );

      return {
        notification,
        verifier: productionVerifier,
        verifiedEnvironment: "Production",
      };
    } catch (error) {
      productionError = error;
    }
  }

  try {
    const notification =
      await sandboxVerifier.verifyAndDecodeNotification(
        payload
      );

    return {
      notification,
      verifier: sandboxVerifier,
      verifiedEnvironment: "Sandbox",
    };
  } catch (sandboxError) {
    console.error("Apple notification verification failed", {
      productionError:
        productionError?.message || null,
      sandboxError:
        sandboxError?.message || String(sandboxError),
    });

    throw new Error(
      "Apple notification signature could not be verified"
    );
  }
}

async function upsertAppleSubscriber({
  email,
  transaction,
  verifiedEnvironment,
  cancelAtPeriodEnd = false,
}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("email is required");
  }

  const productId = String(
    transaction?.productId || ""
  ).trim();

  const planDetails = getApplePlanDetails(productId);

  if (!planDetails) {
    throw new Error(
      `Unknown Apple product ID: ${productId || "missing"}`
    );
  }

  const transactionId = String(
    transaction?.transactionId || ""
  ).trim();

  const originalTransactionId = String(
    transaction?.originalTransactionId ||
    transactionId ||
    ""
  ).trim();

  if (!transactionId || !originalTransactionId) {
    throw new Error(
      "Apple transaction identifiers are missing"
    );
  }

  if (
    transaction?.bundleId &&
    String(transaction.bundleId) !== APPLE_BUNDLE_ID
  ) {
    throw new Error("Apple transaction bundle ID mismatch");
  }

  const currentPeriodEnd = appleDateToIso(
    transaction?.expiresDate
  );

  const canceledAt = appleDateToIso(
    transaction?.revocationDate
  );

  const entitlementActive =
    transactionIsEntitled(transaction);

  const effectivePlan = entitlementActive
    ? planDetails.plan
    : "FREE";

  const status = entitlementActive
    ? "active"
    : canceledAt
      ? "revoked"
      : "expired";

  const environment = normalizeEnvironment(
    transaction?.environment ||
    verifiedEnvironment
  );

  await db.query(
    `
    INSERT INTO subscriber_status (
      email,
      status,
      plan,
      cancel_at_period_end,
      canceled_at,
      current_period_end,
      entitlement_active,
      payment_provider,
      apple_original_transaction_id,
      apple_transaction_id,
      apple_product_id,
      apple_environment,
      updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      'apple',$8,$9,$10,$11,now()
    )
    ON CONFLICT (email)
    DO UPDATE SET
      status = EXCLUDED.status,
      plan = EXCLUDED.plan,
      cancel_at_period_end =
        EXCLUDED.cancel_at_period_end,
      canceled_at = EXCLUDED.canceled_at,
      current_period_end =
        EXCLUDED.current_period_end,
      entitlement_active =
        EXCLUDED.entitlement_active,
      payment_provider = 'apple',
      apple_original_transaction_id =
        EXCLUDED.apple_original_transaction_id,
      apple_transaction_id =
        EXCLUDED.apple_transaction_id,
      apple_product_id =
        EXCLUDED.apple_product_id,
      apple_environment =
        EXCLUDED.apple_environment,
      updated_at = now()
    `,
    [
      normalizedEmail,
      status,
      effectivePlan,
      !!cancelAtPeriodEnd,
      canceledAt,
      currentPeriodEnd,
      entitlementActive,
      originalTransactionId,
      transactionId,
      productId,
      environment,
    ]
  );

  /*
    Keep the old users.plan field aligned because older TeeRadar
    routes still read it.
  */
  await db.query(
    `
    UPDATE users
    SET plan = $2
    WHERE LOWER(email) = LOWER($1)
    `,
    [normalizedEmail, effectivePlan]
  );

  return {
    email: normalizedEmail,
    plan: effectivePlan,
    productId,
    status,
    entitlementActive,
    currentPeriodEnd,
    originalTransactionId,
    transactionId,
    environment,
    cancelAtPeriodEnd: !!cancelAtPeriodEnd,
  };
}

async function findSubscriberByOriginalTransactionId(
  originalTransactionId
) {
  const result = await db.query(
    `
    SELECT *
    FROM subscriber_status
    WHERE apple_original_transaction_id = $1
    LIMIT 1
    `,
    [originalTransactionId]
  );

  return result.rows?.[0] || null;
}

function inferCancelAtPeriodEnd(
  notificationType,
  subtype,
  renewalInfo
) {
  const type = String(notificationType || "")
    .trim()
    .toUpperCase();

  const notificationSubtype = String(subtype || "")
    .trim()
    .toUpperCase();

  /*
    autoRenewStatus:
      1 = renewal is enabled
      0 = renewal is disabled
  */
  if (
    renewalInfo &&
    Number(renewalInfo.autoRenewStatus) === 0
  ) {
    return true;
  }

  if (
    type === "DID_CHANGE_RENEWAL_STATUS" &&
    notificationSubtype === "AUTO_RENEW_DISABLED"
  ) {
    return true;
  }

  return false;
}

/*
  Initial purchase or restored purchase verification.

  Request body:
  {
    "email": "user@example.com",
    "signedTransactionInfo": "eyJ..."
  }
*/
router.post("/verify", async (req, res) => {
  try {
    const email = getEmailFromRequest(req);

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email_required",
      });
    }

    const signedTransactionInfo = String(
      req.body?.signedTransactionInfo || ""
    ).trim();

    if (!signedTransactionInfo) {
      return res.status(400).json({
        ok: false,
        error: "signed_transaction_required",
      });
    }

    const {
      transaction,
      verifiedEnvironment,
    } = await verifySignedTransaction(
      signedTransactionInfo
    );

    const productId = String(
      transaction?.productId || ""
    ).trim();

    if (!isAllowedAppleProduct(productId)) {
      return res.status(400).json({
        ok: false,
        error: "unknown_apple_product",
        productId,
      });
    }

    const subscriber = await upsertAppleSubscriber({
      email,
      transaction,
      verifiedEnvironment,
      cancelAtPeriodEnd: false,
    });

    console.log("🍎 Apple purchase verified", {
      email: subscriber.email,
      productId: subscriber.productId,
      plan: subscriber.plan,
      environment: subscriber.environment,
      originalTransactionId:
        subscriber.originalTransactionId,
    });

    return res.json({
      ok: true,
      subscriber,
    });
  } catch (error) {
    console.error(
      "Apple purchase verification error:",
      error
    );

    return res.status(400).json({
      ok: false,
      error: "apple_verification_failed",
      detail: error?.message || String(error),
    });
  }
});

/*
  App Store Server Notifications V2 endpoint.

  Configure this URL in App Store Connect:

  https://teeradar.com.au/api/apple-purchases/notifications
*/
router.post("/notifications", async (req, res) => {
  try {
    const signedPayload = String(
      req.body?.signedPayload || ""
    ).trim();

    if (!signedPayload) {
      return res.status(400).json({
        ok: false,
        error: "signed_payload_required",
      });
    }

    const {
      notification,
      verifier,
      verifiedEnvironment,
    } = await verifySignedNotification(signedPayload);

    const notificationType = String(
      notification?.notificationType || ""
    ).trim();

    const subtype = String(
      notification?.subtype || ""
    ).trim();

    const data = notification?.data || {};

    let transaction = null;
    let renewalInfo = null;

    if (data.signedTransactionInfo) {
      transaction =
        await verifier.verifyAndDecodeTransaction(
          data.signedTransactionInfo
        );
    }

    if (data.signedRenewalInfo) {
      renewalInfo =
        await verifier.verifyAndDecodeRenewalInfo(
          data.signedRenewalInfo
        );
    }

    /*
      TEST notifications can legitimately have no transaction.
    */
    if (!transaction) {
      console.log("🍎 Apple notification received", {
        notificationType,
        subtype,
        environment: verifiedEnvironment,
        hasTransaction: false,
      });

      return res.sendStatus(200);
    }

    const productId = String(
      transaction.productId || ""
    ).trim();

    if (!isAllowedAppleProduct(productId)) {
      console.warn(
        "Ignoring unknown Apple product notification:",
        productId
      );

      return res.sendStatus(200);
    }

    const originalTransactionId = String(
      transaction.originalTransactionId ||
      transaction.transactionId ||
      ""
    ).trim();

    if (!originalTransactionId) {
      console.warn(
        "Apple notification missing originalTransactionId"
      );

      return res.sendStatus(200);
    }

    const existing =
      await findSubscriberByOriginalTransactionId(
        originalTransactionId
      );

    /*
      Apple notifications do not contain the TeeRadar email.
      The initial /verify call creates the mapping between the
      original transaction ID and the TeeRadar account.
    */
    if (!existing?.email) {
      console.warn(
        "Apple notification has no matching TeeRadar account",
        {
          originalTransactionId,
          productId,
          notificationType,
        }
      );

      return res.sendStatus(200);
    }

    const cancelAtPeriodEnd = inferCancelAtPeriodEnd(
      notificationType,
      subtype,
      renewalInfo
    );

    const subscriber = await upsertAppleSubscriber({
      email: existing.email,
      transaction,
      verifiedEnvironment,
      cancelAtPeriodEnd,
    });

    console.log("🍎 Apple subscription notification applied", {
      notificationType,
      subtype,
      email: subscriber.email,
      plan: subscriber.plan,
      productId: subscriber.productId,
      entitlementActive:
        subscriber.entitlementActive,
      environment: subscriber.environment,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "Apple notification processing error:",
      error
    );

    /*
      Return a non-2xx response when signature verification or
      processing fails, allowing Apple to retry delivery.
    */
    return res.status(500).json({
      ok: false,
      error: "apple_notification_failed",
      detail: error?.message || String(error),
    });
  }
});

router.get("/health", (req, res) => {
  let configured = true;
  let configurationError = null;

  try {
    getAppleVerifiers();
  } catch (error) {
    configured = false;
    configurationError =
      error?.message || String(error);
  }

  return res.json({
    ok: true,
    configured,
    bundleId: APPLE_BUNDLE_ID,
    hasAppAppleId: Number.isFinite(APPLE_APP_ID),
    onlineChecksEnabled:
      APPLE_ENABLE_ONLINE_CHECKS,
    configurationError,
  });
});

export default router;
