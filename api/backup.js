/* Función de Vercel: copia de seguridad de los datos de la app.
   - Cron semanal de Vercel (GET con Authorization: Bearer CRON_SECRET): guarda una copia en Firestore (colección "backups"), conserva las últimas 8.
   - Jefatura (POST con su sesión): action 'status' (última copia), 'run' (hacer copia ahora) o 'download' (descargar todo en un JSON). */
const zlib = require('zlib');
let admin = null;

function init() {
  if (!admin) admin = require('firebase-admin');
  if (admin.apps.length) return;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('x'), { code: 'sin-clave' });
  raw = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!raw.startsWith('{')) { try { raw = Buffer.from(raw, 'base64').toString('utf8').trim(); } catch (e) {} }
  let cred;
  try { cred = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('La clave de Vercel no es un JSON válido'), { code: 'clave-invalida' }); }
  if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}

const COLECCIONES = ['access', 'school', 'days', 'patios', 'sm', 'private']; // no se copian avisos, chat, tokens de notificación ni presencia
const KEEP = 8, CHUNK = 700 * 1024;

async function dump(db) {
  const out = { version: 1, ts: Date.now(), colecciones: {} };
  for (const c of COLECCIONES) {
    const snap = await db.collection(c).get();
    out.colecciones[c] = {};
    snap.forEach((d) => { out.colecciones[c][d.id] = d.data(); });
  }
  return out;
}
const counts = (o) => Object.fromEntries(Object.entries(o.colecciones).map(([k, v]) => [k, Object.keys(v).length]));

async function save(db, data) {
  const id = new Date(data.ts).toISOString().slice(0, 10);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8')).toString('base64');
  const parts = []; for (let i = 0; i < gz.length; i += CHUNK) parts.push(gz.slice(i, i + CHUNK));
  const ref = db.collection('backups').doc(id);
  const old = await ref.collection('parts').get(); for (const d of old.docs) await d.ref.delete();
  for (let i = 0; i < parts.length; i++) await ref.collection('parts').doc(String(i).padStart(3, '0')).set({ data: parts[i] });
  await ref.set({ ts: data.ts, parts: parts.length, bytes: gz.length, counts: counts(data) });
  // conservar solo las últimas KEEP copias
  const all = await db.collection('backups').orderBy('ts', 'desc').get();
  for (const d of all.docs.slice(KEEP)) { const ps = await d.ref.collection('parts').get(); for (const p of ps.docs) await p.ref.delete(); await d.ref.delete(); }
  return { id, ts: data.ts, counts: counts(data), bytes: gz.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    init();
    const db = admin.firestore();
    const auth = req.headers.authorization || '';
    // 1) cron de Vercel
    if (req.method === 'GET') {
      const secret = process.env.CRON_SECRET;
      if (!secret || auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'no auth' });
      return res.status(200).json({ ok: true, ...(await save(db, await dump(db))) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'forbidden' });
    // 2) jefatura
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m) return res.status(401).json({ error: 'no auth' });
    const decoded = await admin.auth().verifyIdToken(m[1], true);
    const email = (decoded.email || '').toLowerCase();
    const acc = email && decoded.email_verified ? await db.doc('access/' + email).get() : null;
    if (!acc || !acc.exists || acc.data().role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.action === 'run') return res.status(200).json({ ok: true, ...(await save(db, await dump(db))) });
    if (body.action === 'download') {
      const data = await dump(db);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="copia-sustituciones-' + new Date().toISOString().slice(0, 10) + '.json"');
      return res.status(200).send(JSON.stringify(data));
    }
    const last = await db.collection('backups').orderBy('ts', 'desc').limit(1).get();
    const l = last.docs[0] && last.docs[0].data();
    return res.status(200).json({ last: l ? { ts: l.ts, counts: l.counts } : null, cron: !!process.env.CRON_SECRET });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', detail: String((e && (e.code || e.message)) || e).slice(0, 200) });
  }
};
