self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "TeeRadar",
      body: event.data ? event.data.text() : "New TeeRadar notification"
    };
  }

  const title = data.title || "TeeRadar";
  const options = {
    body: data.body || "New tee time alert",
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    data: {
      url: data.url || "/index.html"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification?.data?.url || "/index.html";

  event.waitUntil(
    clients.openWindow(url)
  );
});
