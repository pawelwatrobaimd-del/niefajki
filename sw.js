const CACHE_NAME = 'bezpapieroska-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Lock-screen notification ────────────────────────────────────────────────
function daysWord(n) {
  if (n === 1) return 'dzień';
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return 'dni';
  return 'dni';
}

self.addEventListener('message', event => {
  if (event.data?.type === 'LOCK_SCREEN_UPDATE') {
    const days = event.data.days || 0;
    const goal = event.data.goal ? event.data.goal.trim() : '';
    const body = goal
      ? `${days} ${daysWord(days)} bez papierosa 💪\n🎯 Cel: ${goal}`
      : `${days} ${daysWord(days)} bez papierosa! Tak trzymaj 💪`;
    self.registration.showNotification('🚭 Bez papierosa', {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'days-counter',
      renotify: false,
      silent: true,
      data: { url: self.registration.scope }
    });
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
