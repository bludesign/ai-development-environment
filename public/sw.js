self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }
  const href =
    typeof data.href === "string" &&
    data.href.startsWith("/") &&
    !data.href.startsWith("//")
      ? data.href
      : "/notifications";
  event.waitUntil(
    self.registration.showNotification(data.title || "Notification", {
      body: typeof data.body === "string" ? data.body : "",
      icon: data.icon || "/icon-192.png",
      badge: data.badge || "/icon-192.png",
      tag: `push:${data.id || href}`,
      data: { href },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = event.notification.data?.href || "/notifications";
  const target = new URL(href, self.location.origin).href;
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const existing = windowClients.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        if (existing) {
          if ("navigate" in existing) await existing.navigate(target);
          return existing.focus();
        }
        return clients.openWindow(target);
      }),
  );
});
