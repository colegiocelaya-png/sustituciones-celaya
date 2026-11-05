/* Service worker: recibe las notificaciones cuando la página está cerrada */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('/firebase-config.js');
firebase.initializeApp(self.FIREBASE_CONFIG);
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  // Si el mensaje ya trae "notification", el navegador lo muestra solo; si no, lo mostramos aquí.
  if (!payload.notification) {
    self.registration.showNotification(d.title || 'Sustituciones', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } });
  }
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && (e.notification.data.url || (e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.data && e.notification.data.FCM_MSG.data.url))) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { c.navigate && c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

/* ---- Uso sin conexión: se guarda una copia de la app y se usa si no hay internet ---- */
const CACHE = 'celaya-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim().then(() => caches.keys()).then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mine = u.origin === self.location.origin && !u.pathname.startsWith('/api/');
  const libs = /(^|\.)gstatic\.com$|^fonts\.googleapis\.com$/.test(u.hostname);
  if (!mine && !libs) return; // Firestore y autenticación van directos a la red
  e.respondWith(fetch(r).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(r).then((hit) => hit || (r.mode === 'navigate' ? caches.match('/') : undefined) || Response.error())));
});
