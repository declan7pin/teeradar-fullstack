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

function getNotificationDestination(data = {}) {
  const type = String(data.type || "").trim().toUpperCase();

  const notificationId =
    data.notificationId ||
    data.notification_id ||
    data.meta?.notificationId ||
    data.meta?.notification_id ||
    "";

  const roundId =
    data.roundId ||
    data.round_id ||
    data.meta?.roundId ||
    data.meta?.round_id ||
    "";

  const friendUserId =
    data.friendUserId ||
    data.friend_user_id ||
    data.meta?.friendUserId ||
    data.meta?.friend_user_id ||
    "";

  const upcomingId =
    data.upcomingId ||
    data.upcoming_id ||
    data.meta?.upcomingId ||
    data.meta?.upcoming_id ||
    "";

  console.log("Resolving push destination:", {
    type,
    notificationId,
    roundId,
    friendUserId,
    upcomingId,
    suppliedUrl: data.url
  });

  // Tee-time availability alert
  if (type === "TEE_TIME_ALERT" && notificationId) {
    return `/alert-results.html?notificationId=${encodeURIComponent(notificationId)}`;
  }

  // Friend has started playing — open their live round
  if (
    (
      type === "FRIEND_STARTED_ROUND" ||
      type === "FRIEND_ROUND_STARTED" ||
      type === "LIVE_ROUND"
    ) &&
    roundId &&
    friendUserId
  ) {
    return `/friend-live-round.html?roundId=${encodeURIComponent(roundId)}&friendUserId=${encodeURIComponent(friendUserId)}`;
  }

  // Shared round / upcoming round
  if (
    type === "ROUND_SHARED" ||
    type === "SHARED_ROUND" ||
    type === "UPCOMING_ROUND_SHARED"
  ) {
    if (upcomingId) {
      return `/my-rounds.html?upcomingId=${encodeURIComponent(upcomingId)}`;
    }

    return "/my-rounds.html";
  }

  // Tee time is about to start
  if (
    type === "TEE_TIME_REMINDER" ||
    type === "ROUND_REMINDER" ||
    type === "TEE_TIME_STARTING"
  ) {
    if (upcomingId) {
      return `/my-rounds.html?upcomingId=${encodeURIComponent(upcomingId)}`;
    }

    return "/my-rounds.html";
  }

  // Friend request
  if (type === "FRIEND_REQUEST") {
    return "/friends.html";
  }

  // Friend accepted request
  if (type === "FRIEND_ACCEPTED") {
    return "/friends.html";
  }

  // If backend supplied a URL, use it.
  if (data.url) {
    return safeNotificationUrl(data.url);
  }

  // Final fallback
  return "/index.html";
}

function openNotificationUrl(rawUrl) {
  const url = safeNotificationUrl(rawUrl);
  console.log("Opening push URL:", url);

  setTimeout(() => {
    window.location.href = url;
  }, 150);
}

let nativePushListenersInstalled = false;

async function setupNativePushListeners() {
  if (!isNativeApp()) return;

  const FirebaseMessaging =
    window.Capacitor?.Plugins?.FirebaseMessaging || null;

  if (!FirebaseMessaging) {
    console.warn("Firebase Messaging plugin not available.");
    return;
  }

  if (nativePushListenersInstalled) return;
  nativePushListenersInstalled = true;

  await FirebaseMessaging.addListener("notificationReceived", (notification) => {
    console.log("Firebase notification received:", notification);
  });

  await FirebaseMessaging.addListener("notificationActionPerformed", (event) => {
    console.log("Firebase notification action:", event);

    const notification = event?.notification || {};
    const data = notification?.data || {};

    console.log("Firebase push tap data:", data);

    const destination = getNotificationDestination(data);

    console.log("Firebase push destination:", destination);

    openNotificationUrl(destination);
  });

  console.log("TeeRadar native push listeners installed.");
}

/* =========================
   NATIVE iOS / ANDROID PUSH
========================= */
 async function enableNativePush(email) {
  const FirebaseMessaging =
    window.Capacitor?.Plugins?.FirebaseMessaging || null;

  if (!FirebaseMessaging) {
    throw new Error("Firebase Messaging plugin not available. Run npm install @capacitor-firebase/messaging && npx cap sync ios.");
  }

  console.log("Firebase native push setup starting", {
    platform: window.Capacitor?.getPlatform?.(),
    apiBase: PUSH_API_BASE,
    email: getUserEmail(email)
  });

  let perm = await FirebaseMessaging.checkPermissions();

  if (perm.receive !== "granted") {
    perm = await FirebaseMessaging.requestPermissions();
  }

  if (perm.receive !== "granted") {
    throw new Error("Push permission was not granted.");
  }

  const result = await FirebaseMessaging.getToken();
  const tokenValue = String(result?.token || "").trim();

  console.log("FCM token:", tokenValue);

  if (!tokenValue) {
    throw new Error("No FCM token returned.");
  }

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
      token: tokenValue
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not save FCM token.");
  }

  console.log("FCM token saved to TeeRadar backend.");

  await setupNativePushListeners();

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
  console.log("Push enable clicked", {
    hasCapacitor: !!window.Capacitor,
    platform: window.Capacitor?.getPlatform?.(),
    isNative: isNativeApp(),
    hasPushPlugin: !!getPushPlugin()
  });

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

if (isNativeApp()) {
  setupNativePushListeners().catch((err) => {
    console.warn("Could not initialise native push listeners:", err);
  });
}
