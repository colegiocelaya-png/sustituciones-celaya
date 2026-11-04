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
