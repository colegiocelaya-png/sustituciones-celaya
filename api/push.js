/* Función de Vercel: envía las notificaciones push.
   La jefatura puede avisar a cualquier profesor. El profesorado solo puede avisar a la jefatura
   de un mensaje de chat (y solo si participa en el chat de ese día). */
let admin = null;

function init() {
  if (!admin) admin = require('firebase-admin'); // se carga aquí para poder explicar el error si falta
  if (admin.apps.length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { throw Object.assign(new Error('x'), { code: 'sin-clave' }); }
  raw = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!raw.startsWith('{')) {
    // por si se pegó codificada en base64
    try { raw = Buffer.from(raw, 'base64').toString('utf8').trim(); } catch (e) {}
  }
  let cred;
  try { cred = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('La clave de Vercel no es un JSON válido (pega el archivo entero)'), { code: 'clave-invalida' }); }
  if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'forbidden' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'no auth' });
    const decoded = await admin.auth().verifyIdToken(m[1], true);
    const email = (decoded.email || '').toLowerCase();
    const db = admin.firestore();
    const acc = email && decoded.email_verified ? await db.doc('access/' + email).get() : null;
    if (!acc || !acc.exists) return res.status(403).json({ error: 'forbidden' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    if (acc.data().role !== 'admin') {
      // profesorado: un único aviso de chat dirigido a la jefatura
      const it = items[0], tid = acc.data().tid;
      if (!it || it.kind !== 'chat-jefe' || !tid || typeof it.text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.date))) return res.status(403).json({ error: 'forbidden' });
      const day = await db.doc('days/' + it.date).get();
      if (!day.exists || !((day.data().subIds || {})[tid])) return res.status(403).json({ error: 'forbidden' });
      const school = await db.doc('school/main').get();
      const T = ((school.exists && school.data().teachers) || []).find((t) => t.id === tid);
      const admins = await db.collection('access').where('role', '==', 'admin').get();
      const toks = [], refs = [];
      for (const a of admins.docs) {
        let uid = null;
        try { uid = (await admin.auth().getUserByEmail(a.id)).uid; } catch (e) { continue; }
        const ts = await db.collection('tokens').where('uid', '==', uid).get();
        ts.docs.forEach((d) => { toks.push(d.data().token); refs.push(d.ref); });
      }
      if (!toks.length) return res.status(200).json({ sent: 0, removed: 0 });
      const r = await admin.messaging().sendEachForMulticast({
        tokens: toks,
        data: { title: 'Chat: ' + ((T && T.name) || 'profesorado'), body: String(it.text).slice(0, 200), url: '/' },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        android: { priority: 'high' }
      });
      let sent = 0, removed = 0;
      r.responses.forEach((x, i) => {
        if (x.success) { sent++; return; }
        const code = x.error && x.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') { refs[i].delete().catch(() => {}); removed++; }
      });
      return res.status(200).json({ sent, removed });
    }
    let sent = 0, removed = 0;
    for (const it of items) {
      if (!it || typeof it.to !== 'string' || !it.text) continue;
      const snap = await db.collection('tokens').where('tid', '==', it.to).get();
      if (snap.empty) continue;
      const tokens = snap.docs.map((d) => d.data().token);
      const title = it.kind === 'cancela' ? 'Sustitución cancelada' : it.kind === 'chat' ? 'Mensaje de Jefatura' : it.kind === 'exc' ? 'Excursión' : 'Nueva sustitución';
      const r = await admin.messaging().sendEachForMulticast({
        tokens,
        data: { title, body: String(it.text).slice(0, 300), url: '/' },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        android: { priority: 'high' }
      });
      r.responses.forEach((x, i) => {
        if (x.success) { sent++; return; }
        const code = x.error && x.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          snap.docs[i].ref.delete().catch(() => {}); removed++;
        }
      });
    }
    return res.status(200).json({ sent, removed });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', detail: String((e && (e.code || e.message)) || e).slice(0, 200) });
  }
};
