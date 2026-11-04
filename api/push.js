/* Función de Vercel: envía las notificaciones push.
   Solo la puede llamar una persona con sesión iniciada y con rol "admin" (jefatura). */
let admin = null;

function init() {
  if (!admin) admin = require('firebase-admin'); // se carga aquí para poder explicar el error si falta
  if (admin.apps.length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT en Vercel'), { code: 'sin-clave' });
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'no auth' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const email = (decoded.email || '').toLowerCase();
    const db = admin.firestore();
    const acc = email && decoded.email_verified ? await db.doc('access/' + email).get() : null;
    if (!acc || !acc.exists || acc.data().role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    let sent = 0, removed = 0;
    for (const it of items) {
      if (!it || typeof it.to !== 'string' || !it.text) continue;
      const snap = await db.collection('tokens').where('tid', '==', it.to).get();
      if (snap.empty) continue;
      const tokens = snap.docs.map((d) => d.data().token);
      const title = it.kind === 'cancela' ? 'Sustitución cancelada' : 'Nueva sustitución';
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
