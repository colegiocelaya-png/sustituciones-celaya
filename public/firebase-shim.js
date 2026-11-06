/* Puente entre la app y Firebase.
   La app original pide window.claude.use('db') y ('user'); aquí se las damos con Firebase,
   tras iniciar sesión (enlace por correo o Google) y comprobar que el correo está autorizado. */
(function () {
  'use strict';
  var cfg = self.FIREBASE_CONFIG;
  var LS_EMAIL = 'celaya_email';
  var $ = function (s) { return document.querySelector(s); };

  if (!cfg || /PEGA_AQUI/.test(cfg.apiKey || '')) {
    window.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML = '<div style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h2>Falta configurar Firebase</h2><p>Abre <code>public/firebase-config.js</code> y pega los datos de tu proyecto (guía, paso 3).</p></div>';
    });
    window.claude = { use: function () { return new Promise(function () {}); } };
    return;
  }

  firebase.initializeApp(cfg);
  var auth = firebase.auth();
  var fs = firebase.firestore();
  // Datos guardados en el dispositivo: la app abre y se lee sin conexión
  try { if (fs.enablePersistence) fs.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}
  // Copia de la app para abrirla sin internet
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/firebase-messaging-sw.js').catch(function () {}); });
  var ctx = null; // { uid, email, role }

  /* ---------- pantalla de acceso ---------- */
  var overlay;
  function ui(html) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'login';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;background:var(--bg,#FBEFED);color:var(--ink,#1B1416);font-family:inherit;overflow:auto';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div style="width:100%;max-width:26rem;background:var(--card,#fff);border-radius:16px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.12)">' +
      '<img src="/icon-192.png" alt="" width="64" height="64" style="border-radius:14px;display:block;margin:0 auto 12px">' + html + '</div>';
    overlay.style.display = 'grid';
    return overlay;
  }
  function hide() { if (overlay) overlay.style.display = 'none'; }
  var btn = 'width:100%;min-height:48px;border:0;border-radius:12px;font:inherit;font-weight:700;cursor:pointer;margin-top:10px;';
  var primary = btn + 'background:var(--accent,#BF1D29);color:#fff;';
  var plain = btn + 'background:transparent;color:inherit;border:1px solid rgba(0,0,0,.25);';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function showLogin(msg, prefill) {
    var inp = 'width:100%;box-sizing:border-box;min-height:48px;font:inherit;padding:0 12px;border-radius:12px;border:1px solid rgba(0,0,0,.3);margin-top:6px';
    var o = ui('<h1 style="font-size:1.35rem;text-align:center;margin:0 0 4px">Sustituciones</h1>' +
      '<p style="text-align:center;margin:0 0 16px;opacity:.75">CEIP Gabriel Celaya</p>' +
      (msg ? '<p role="alert" style="background:#fde8e8;color:#7a1010;padding:10px 12px;border-radius:10px;margin:0 0 12px">' + esc(msg) + '</p>' : '') +
      '<label for="lg-mail" style="font-weight:700">Tu correo</label>' +
      '<input id="lg-mail" type="email" autocomplete="username" inputmode="email" placeholder="nombre@correo.es" value="' + esc(prefill || '') + '" style="' + inp + '">' +
      '<label for="lg-pass" style="font-weight:700;display:block;margin-top:12px">Contraseña</label>' +
      '<input id="lg-pass" type="password" autocomplete="current-password" placeholder="La que te ha dado la jefatura" style="' + inp + '">' +
      '<button id="lg-pw" style="' + primary + '">Entrar</button>' +
      '<p style="text-align:center;margin:14px 0 0;opacity:.7;font-size:.9rem">o</p>' +
      '<button id="lg-google" style="' + plain + '">Entrar con Google</button>' +
      '<p style="font-size:.85rem;opacity:.7;margin:14px 0 0">Solo pueden entrar los correos que ha autorizado la jefatura de estudios.</p>');
    o.querySelector('#lg-pw').onclick = signInPassword;
    o.querySelector('#lg-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') signInPassword(); });
    o.querySelector('#lg-google').onclick = function () {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function (e) { if (e && e.code !== 'auth/popup-closed-by-user') showLogin('No se pudo entrar con Google. Prueba con tu correo y contraseña.'); });
    };
  }
  function signInPassword() {
    var email = ($('#lg-mail').value || '').trim().toLowerCase();
    var pass = $('#lg-pass').value || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showLogin('Escribe un correo válido.', email);
    if (!pass) return showLogin('Escribe la contraseña que te dio la jefatura.', email);
    var b = $('#lg-pw'); b.disabled = true; b.textContent = 'Entrando…';
    auth.signInWithEmailAndPassword(email, pass).catch(function (e) {
      var wrong = e && /wrong-password|invalid-credential|user-not-found|invalid-login/.test(e.code || '');
      showLogin(wrong ? 'Correo o contraseña incorrectos. Pide a la jefatura que te genere una nueva.' : 'No se pudo entrar. Inténtalo de nuevo.', email);
    });
  }
  function sendLink() {
    var email = ($('#lg-mail').value || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showLogin('Escribe un correo válido.', email);
    var b = $('#lg-link'); b.disabled = true; b.textContent = 'Enviando…';
    auth.sendSignInLinkToEmail(email, { url: location.origin + '/', handleCodeInApp: true }).then(function () {
      try { localStorage.setItem(LS_EMAIL, email); } catch (e) {}
      ui('<h1 style="font-size:1.25rem;text-align:center;margin:0 0 8px">Revisa tu correo</h1><p style="text-align:center">Te hemos enviado un enlace a <b>' + esc(email) + '</b>. Ábrelo desde este mismo móvil. Si no llega, mira en spam.</p><button id="lg-back" style="' + plain + '">Volver</button>').querySelector('#lg-back').onclick = function () { showLogin('', email); };
    }).catch(function (e) {
      var c = (e && e.code) || '';
      var msg = c === 'auth/quota-exceeded' ? 'Firebase ha alcanzado su límite diario de enlaces por correo. Entra con tu contraseña o prueba mañana.'
        : c === 'auth/unauthorized-continue-uri' || c === 'auth/invalid-continue-uri' ? 'Esta dirección no está autorizada en Firebase (Authentication → Configuración → Dominios autorizados).'
        : c === 'auth/operation-not-allowed' ? 'El acceso por enlace no está activado en Firebase.'
        : 'No se pudo enviar el enlace' + (c ? ' (' + c + ')' : '') + '. Entra con tu contraseña o inténtalo más tarde.';
      showLogin(msg, email);
    });
  }
  function showDenied(email) {
    var o = ui('<h1 style="font-size:1.25rem;text-align:center;margin:0 0 8px">Este correo no tiene acceso</h1><p style="text-align:center"><b>' + esc(email) + '</b> no está en la lista del centro. Pide a la jefatura de estudios que lo añada y vuelve a entrar.</p><button id="lg-out" style="' + primary + '">Usar otro correo</button>');
    o.querySelector('#lg-out').onclick = function () { auth.signOut(); };
  }

  /* ---------- enlace recibido por correo ---------- */
  function finishEmailLink() {
    if (!auth.isSignInWithEmailLink(location.href)) return Promise.resolve();
    var email = null;
    try { email = localStorage.getItem(LS_EMAIL); } catch (e) {}
    if (!email) email = (window.prompt('Escribe el correo al que llegó el enlace') || '').trim().toLowerCase();
    if (!email) return Promise.resolve();
    return auth.signInWithEmailLink(email, location.href).then(function () {
      try { localStorage.removeItem(LS_EMAIL); } catch (e) {}
      history.replaceState(null, '', location.origin + '/');
    }).catch(function () { history.replaceState(null, '', location.origin + '/'); showLogin('El enlace ha caducado o ya se usó. Pide uno nuevo.'); });
  }

  /* ---------- estado de sesión ---------- */
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  var started = false;
  document.addEventListener('DOMContentLoaded', function () {
    ui('<p style="text-align:center;margin:0">Cargando…</p>');
    finishEmailLink().then(function () {
      auth.onAuthStateChanged(function (u) {
        if (!u) { if (started) return location.reload(); return showLogin(); }
        var email = (u.email || '').toLowerCase();
        fs.doc('access/' + email).get().then(function (snap) {
          if (!snap.exists) return showDenied(email);
          ctx = { uid: u.uid, email: email, role: snap.data().role === 'admin' ? 'admin' : 'teacher', tid: snap.data().tid || null };
          started = true; hide(); readyResolve(ctx);
        }).catch(function () { showDenied(email); });
      });
    });
  });

  window.claude = {
    use: function (name) {
      return ready.then(function (c) {
        if (name === 'db') return fs;
        if (name === 'user') return {
          id: function () { return Promise.resolve(c.uid); },
          canEdit: function () { return Promise.resolve(c.role === 'admin'); },
          can: function () { return Promise.resolve(true); },
          tid: function () { return Promise.resolve(c.tid); }
        };
        return null;
      });
    }
  };

  /* ---------- notificaciones push ---------- */
  var swReg = null;
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function supported() { return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window; }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function saveToken(tid) {
    if (!ctx || !firebase.messaging.isSupported()) return Promise.resolve(false);
    return navigator.serviceWorker.register('/firebase-messaging-sw.js').then(function (reg) {
      swReg = reg;
      return firebase.messaging().getToken({ vapidKey: self.FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
    }).then(function (token) {
      if (!token) return false;
      return fs.doc('tokens/' + ctx.uid + '_' + hash(token)).set({ uid: ctx.uid, tid: tid, token: token, ts: Date.now() }).then(function () { return true; });
    });
  }
  window.pushApi = {
    status: function () {
      if (isIOS() && !standalone()) return 'ios-install';
      if (!supported()) return 'unsupported';
      return Notification.permission; // granted | default | denied
    },
    enable: function (tid) {
      return Notification.requestPermission().then(function (p) {
        if (p !== 'granted') return { ok: false };
        return saveToken(tid).then(function (ok) { return { ok: ok }; });
      }).catch(function () { return { ok: false }; });
    },
    sync: function (tid) {
      if (!tid || !supported() || Notification.permission !== 'granted') return Promise.resolve();
      return saveToken(tid).catch(function () {});
    }
  };
  /* ---------- cerrar sesión: borra los datos guardados en este dispositivo ---------- */
  window.authApi = {
    signOut: function () {
      var tokenDel = Promise.resolve();
      try {
        if (ctx && swReg && firebase.messaging.isSupported()) {
          var uid = ctx.uid, m = firebase.messaging();
          tokenDel = m.getToken({ vapidKey: self.FIREBASE_VAPID_KEY, serviceWorkerRegistration: swReg }).then(function (t) {
            if (t) return fs.doc('tokens/' + uid + '_' + hash(t)).delete().then(function () { return m.deleteToken(); });
          }).catch(function () {});
        }
      } catch (e) {}
      return tokenDel.then(function () { return auth.signOut(); })
        .then(function () { return fs.terminate().then(function () { return fs.clearPersistence(); }); })
        .catch(function () {})
        .then(function () {
          try { Object.keys(localStorage).forEach(function (k) { if (/^celaya_/.test(k) && k !== 'celaya_musica') localStorage.removeItem(k); }); } catch (e) {}
          var clear = window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : Promise.resolve();
          return clear.catch(function () {});
        })
        .then(function () { location.replace('/'); });
    }
  };
  window.pushNotify = function (list) {
    if (!ctx || ctx.role !== 'admin') return Promise.resolve();
    return auth.currentUser.getIdToken().then(function (t) {
      return fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ items: list.map(function (n) { return { to: n.to, kind: n.kind, text: n.text, date: n.date }; }) })
      });
    });
  };

  /* ---------- lista de correos autorizados ---------- */
  window.accessApi = {
    me: function () { return ctx && ctx.email; },
    subscribe: function (cb) {
      return fs.collection('access').onSnapshot(function (s) {
        cb(s.docs.map(function (d) { return { id: d.id, role: d.data().role, tid: d.data().tid || null }; }));
      }, function () {});
    },
    add: function (text) {
      var seen = {}, jobs = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var admin = /,\s*jefatura\s*$/i.test(line);
        var m = line.replace(/,\s*jefatura\s*$/i, '').match(/[^\s,;]+@[^\s,;]+\.[^\s,;]+/g) || [];
        m.forEach(function (e) {
          e = e.toLowerCase();
          if (seen[e]) return; seen[e] = 1;
          jobs.push(fs.doc('access/' + e).set({ role: admin ? 'admin' : 'teacher', ts: Date.now() }));
        });
      });
      return Promise.all(jobs).then(function () { return jobs.length; });
    },
    remove: function (email) { return fs.doc('access/' + email).delete(); },
    // Liga un correo a un profesor/a concreto (cada persona solo ve sus propios avisos)
    setTid: function (email, tid) { return fs.doc('access/' + email).set({ tid: tid || null }, { merge: true }); },
    // Crea o restablece cuentas con contraseña (la jefatura se las da a cada profesor)
    passwords: function (emails) {
      return auth.currentUser.getIdToken().then(function (t) {
        return fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ emails: emails }) });
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (j) { throw new Error('HTTP ' + r.status + (j.detail ? ' · ' + j.detail : j.error ? ' · ' + j.error : '')); });
      }).then(function (j) { return j.users || []; });
    }
  };
})();
