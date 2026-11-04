/* Función de Vercel: crea o restablece cuentas con contraseña (solo jefatura).
   Las cuentas se crean con el correo ya verificado, así no hace falta que llegue ningún correo. */
const admin = require('firebase-admin');

function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function genPassword() {
  const b = require('crypto').randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
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
    const list = Array.isArray(body.emails) ? body.emails.slice(0, 80) : [];
    const out = [];
    for (const raw of list) {
      const e = String(raw || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) continue;
      // solo a correos que estén en la lista de acceso
      const a = await db.doc('access/' + e).get();
      if (!a.exists) { out.push({ email: e, error: 'no está en la lista' }); continue; }
      const password = genPassword();
      try {
        const u = await admin.auth().getUserByEmail(e);
        await admin.auth().updateUser(u.uid, { password, emailVerified: true });
      } catch (err) {
        if (err.code === 'auth/user-not-found') await admin.auth().createUser({ email: e, password, emailVerified: true });
        else throw err;
      }
      out.push({ email: e, password });
    }
    return res.status(200).json({ users: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
};
