/* Función de Vercel: crea o restablece cuentas con contraseña (solo jefatura).
   Las cuentas se crean con el correo ya verificado, así no hace falta que llegue ningún correo. */
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
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function genPassword() {
  const b = require('crypto').randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
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
    if (!acc || !acc.exists || acc.data().role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const list = Array.isArray(body.emails) ? body.emails.slice(0, 80) : [];
    const out = [];
    for (const raw of list) {
      const e = String(raw || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) continue;
      // solo a correos que estén en la lista de acceso
      if (e === email) { out.push({ email: e, error: 'tu propia cuenta (no se toca para no cerrarte la sesión)' }); continue; }
      const a = await db.doc('access/' + e).get();
      if (!a.exists) { out.push({ email: e, error: 'no está en la lista' }); continue; }
      let existing = null;
      try { existing = await admin.auth().getUserByEmail(e); } catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
      // sin "reset" solo se crean las cuentas nuevas: a quien ya tiene cuenta no se le cambia la contraseña ni se le cierra la sesión
      if (existing && !body.reset) { out.push({ email: e, error: 'ya tiene cuenta: no se ha tocado' }); continue; }
      const password = genPassword();
      if (existing) await admin.auth().updateUser(existing.uid, { password, emailVerified: true });
      else await admin.auth().createUser({ email: e, password, emailVerified: true });
      out.push({ email: e, password });
    }
    return res.status(200).json({ users: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', detail: String((e && (e.code || e.message)) || e).slice(0, 200) });
  }
};
