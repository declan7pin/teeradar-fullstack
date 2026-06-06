const PUSH_API_BASE = "https://teeradar-fullstack-5.onrender.com";

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

async function enableTeeRadarPushNotifications() {
  if (!("serviceWorker" in navigator)) {
    alert("Push notifications are not supported on this browser.");
    return false;
  }

  if (!("PushManager" in window)) {
    alert("Push notifications are not supported on this device.");
    return false;
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    alert("Notifications were not enabled.");
    return false;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");

  const publicKey = await getPublicVapidKey();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  const email =
    localStorage.getItem("teeradar_user_email") ||
    localStorage.getItem("teeradar_email") ||
    "";

  const token = localStorage.getItem("teeradar_jwt") || "";

  const res = await fetch(`${PUSH_API_BASE}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify({
      email,
      subscription
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not save push subscription");
  }

  alert("Push notifications enabled.");
  return true;
}

async function disablePush() {
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
  enablePush: enableTeeRadarPushNotifications,
  disablePush
};
