/* Añade la asignatura de cada clase a los horarios YA cargados, sin tocar nada más.
   Uso:  node seed-materias.js clave.json */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) });
const db = admin.firestore();
(async () => {
  const nuevo = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'school_main.json'), 'utf8'));
  const ref = db.doc('school/main');
  const snap = await ref.get();
  if (!snap.exists) { console.error('Aún no hay datos: usa seed.js'); process.exit(1); }
  const cur = snap.data();
  const byId = new Map(nuevo.teachers.map((t) => [t.id, t]));
  let n = 0;
  for (const t of cur.teachers) {
    const src = byId.get(t.id); if (!src) continue;
    for (const k of Object.keys(t.sched || {})) {
      const a = t.sched[k], b = src.sched[k];
      if (a && b && a.t === 'c' && b.m && !a.m) { a.m = b.m; n++; }
    }
  }
  await ref.set(cur);
  console.log('Asignaturas añadidas: ' + n);
})().catch((e) => { console.error(e); process.exit(1); });
