/* Carga inicial: profesorado, horarios y turnos de patio.
   Uso:  FIREBASE_SERVICE_ACCOUNT='<json>' node seed.js   (o: node seed.js ruta/clave.json) */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const raw = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.error('Falta la clave de servicio (ver GUIA.md, paso 8).'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();
(async () => {
  const dir = path.join(__dirname, 'seed');
  await db.doc('school/main').set(JSON.parse(fs.readFileSync(path.join(dir, 'school_main.json'), 'utf8')));
  console.log('school/main cargado');
  for (const f of fs.readdirSync(dir).filter((x) => /^patio_\d{4}-\d{2}\.json$/.test(x))) {
    const id = f.replace(/^patio_|\.json$/g, '');
    await db.doc('patios/' + id).set(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    console.log('patios/' + id + ' cargado');
  }
  const email = (process.argv[3] || process.env.ADMIN_EMAIL || '').toLowerCase();
  if (email) { await db.doc('access/' + email).set({ role: 'admin', ts: Date.now() }); console.log('Jefatura autorizada: ' + email); }
})().catch((e) => { console.error(e); process.exit(1); });
