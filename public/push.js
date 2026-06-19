const PUSH_API_BASE = "https://teeradar.com.au";

function isNativeApp() {
  try {
    return (
      window.Capacitor &&
      typeof window.Capacitor.getPlatform === "function" &&
      ["ios", "android"].includes(window.Capacitor.getPlatform())
    );
  } catch {
    return false;
  }
}

function getPushPlugin() {
  return (
    window.Capacitor?.Plugins?.PushNotifications ||
    window.Capacitor?.PushNotifications ||
    null
  );
}

function getUserEmail(passedEmail) {
  return (
    passedEmail ||
    localStorage.getItem("teeradar_user_email") ||
    localStorage.getItem("teeradar_email") ||
    ""
  ).trim().toLowerCase();
}

function safeNotificationUrl(rawUrl) {
  const fallback = "/index.html";
  const value = String(rawUrl || "").trim();

  if (!value) return fallback;

  try {
    if (value.startsWith("/")) return value;

    const parsed = new URL(value);
    if (
      parsed.hostname === "teeradar.com.au" ||
      parsed.hostname === "www.teeradar.com.au" ||
      parsed.hostname.includes("teeradar-fullstack")
    ) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {}

  return fallback;
}

function openNotificationUrl(rawUrl) {
  const url = safeNotificationUrl(rawUrl);
  console.log("Opening push URL:", url);

  setTimeout(() => {
    window.location.href = url;
  }, 150);
}

/* =========================
   NATIVE iOS / ANDROID PUSH
========================= */
async function enableNativePush(email) {
  const PushNotifications = getPushPlugin();

  if (!PushNotifications) {
    throw new Error(
      "Native push plugin not available. Run npx cap sync ios and reinstall the app."
    );
  }

  let perm = await PushNotifications.checkPermissions();

  if (perm.receive !== "granted") {
    perm = await PushNotifications.requestPermissions();
  }

  if (perm.receive !== "granted") {
    throw new Error("Push permission was not granted.");
  }

  if (typeof PushNotifications.removeAllListeners === "function") {
    await PushNotifications.removeAllListeners();
  }

  await PushNotifications.addListener("registration", async (token) => {
    console.log("Native push token:", token.value);

    const userEmail = getUserEmail(email);
    const jwt = localStorage.getItem("teeradar_jwt") || "";

    const res = await fetch(`${PUSH_API_BASE}/api/push/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: "Bearer " + jwt } : {})
      },
      body: JSON.stringify({
        email: userEmail,
        platform: window.Capacitor.getPlatform(),
        token: token.value
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      console.warn("Native push token save failed:", data);
    }
  });

  await PushNotifications.addListener("registrationError", (err) => {
    console.error("Native push registration error:", err);
  });

  await PushNotifications.addListener("pushNotificationReceived", (notification) => {
    console.log("Push received:", notification);
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
    console.log("Push action event:", event);

    const data = event?.notification?.data || {};
    const url =
      data.url ||
      data.link ||
      data.click_action ||
      event?.notification?.url ||
      "/index.html";

    openNotificationUrl(url);
  });

  await PushNotifications.register();

  return true;
}

/* =========================
   WEB PUSH
========================= */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getPublicVapidKey() {
  const res = await fetch(`${PUSH_API_BASE}/api/push/public-key`);
  const data = await res.json();

  if (!res.ok || !data.publicKey) {
    throw new Error("Missing push public key");
  }

  return data.publicKey;
}

async function enableWebPush(email) {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Push notifications are not supported on this browser.");
  }

  if (!("PushManager" in window)) {
    throw new Error("Push notifications are not supported on this device.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Notifications were not enabled.");
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  const publicKey = await getPublicVapidKey();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  const userEmail = getUserEmail(email);
  const token = localStorage.getItem("teeradar_jwt") || "";

  const res = await fetch(`${PUSH_API_BASE}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify({
      email: userEmail,
      subscription
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not save push subscription");
  }

  return true;
}

/* =========================
   PUBLIC METHODS
========================= */
async function enablePush(email) {
  if (isNativeApp()) {
    return enableNativePush(email);
  }

  return enableWebPush(email);
}

async function disablePush() {
  if (isNativeApp()) {
    const PushNotifications = getPushPlugin();

    if (PushNotifications && typeof PushNotifications.removeAllListeners === "function") {
      await PushNotifications.removeAllListeners();
    }

    return true;
  }

  if (!("serviceWorker" in navigator)) {
    return true;
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    const endpoint = subscription.endpoint;

    await fetch(`${PUSH_API_BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint })
    });

    await subscription.unsubscribe();
  }

  return true;
}

window.TeeRadarPush = {
  enablePush,
  disablePush
};
