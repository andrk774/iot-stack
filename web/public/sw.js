// Service worker панели: работа без сети (последняя загруженная версия) и push-уведомления.
// Стратегия «сначала сеть»: свежие файлы панели, а без связи — из кеша. API не кешируется.
const CACHE = 'iot-panel-v1';
// все файлы панели (список сверяет web/test/pwa.test.js)
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png',
  '/assets/api.js',
  '/assets/app.js',
  '/assets/chart.js',
  '/assets/dom.js',
  '/assets/format.js',
  '/assets/mqtt-client.js',
  '/assets/mqtt-codec.js',
  '/assets/qr.js',
  '/assets/store.js',
  '/assets/styles.css',
  '/assets/views/bridges.js',
  '/assets/views/device.js',
  '/assets/views/devices.js',
  '/assets/views/login.js',
  '/assets/views/notifications.js',
  '/assets/views/ota.js',
  '/assets/views/scenarios.js',
  '/assets/views/security.js',
  '/assets/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mqtt') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return (await caches.match('/index.html')) || Response.error();
      throw e;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = data.title || 'Домашний IoT';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    requireInteraction: data.level === 'alert',
    data: { url: data.url || '/#/notifications' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) await c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
