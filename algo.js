/* ===== Lógica pura: horarios, parseo de tablas de Word y reparto de sustituciones ===== */
const WD = ['L', 'M', 'X', 'J', 'V'];
const WDN = { L: 'Lunes', M: 'Martes', X: 'Miércoles', J: 'Jueves', V: 'Viernes' };
const CLASS_SLOTS = ['1', '2', '3', '4', '5', '6'];
const SLOT_ORDER = ['1', '2', '3', 'R', '4', '5', '6'];
const ROLES = { tutor: 'Primaria', especialista: 'Especialista', pt: 'PT', al: 'AL', directivo: 'Equipo directivo', infantil: 'Infantil', apoyoinf: 'Apoyo de infantil' };
const TIER_NAMES = { 1: 'Hora libre', 2: 'Apoyo', 3: 'PT / AL', 4: 'Directivo', 5: 'Apoyo infantil', 6: 'Coordinación', 7: 'Speaking' };
const CELL_NAMES = { c: 'Clase', l: 'Libre', a: 'Apoyo', o: 'Coordinación', s: 'Desdoble / speaking', n: 'No está' };
const DEFAULT_SESSIONS = {
  '1': '9:00–9:45', '2': '9:45–10:30', '3': '10:30–11:15', 'R': '11:15–11:45',
  '4': '11:45–12:30', '5': '12:30–13:15', '6': '13:15–14:00'
};

const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const isSpecial = (r) => r === 'pt' || r === 'al';
const isPrim = (T) => T.role === 'tutor' || T.role === 'especialista';
const isInfGroup = (g) => /infantil|\binf\b|\b[345]\s?(años|anos|a)\b|\bi[345]\b/i.test(norm(g || ''));

function weekdayKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ({ 1: 'L', 2: 'M', 3: 'X', 4: 'J', 5: 'V' })[new Date(y, m - 1, d).getDay()] || null;
}
function slotLabel(s) { return s === 'R' ? 'Recreo' : s + 'ª sesión'; }
function cellOf(T, wd, slot) { return (T && T.sched && T.sched[wd + slot]) || null; }
function presentDay(T, wd) {
  return CLASS_SLOTS.some((s) => { const c = cellOf(T, wd, s); return c && c.t !== 'n'; });
}
function isAbsent(day, tid, slot) {
  return (day.absences || []).some((a) => a.tid === tid && a.slots.includes(slot));
}
/* Vista del patio de un día concreto: si el mes trae calendario por fechas se usa ése; si no, el patrón semanal. */
function patioForDate(patio, date) {
  if (!patio) return patio;
  if (!patio.dates) return patio;
  const e = patio.dates[date] || {};
  const wd = weekdayKey(date);
  return { turns: { [wd]: e.prim || [] }, turnsInf: { [wd]: e.inf || [] }, todos: !!e.todos };
}
function onPatio(patio, wd, tid) {
  return !!(patio && ['turns', 'turnsInf'].some((k) => patio[k] && (patio[k][wd] || []).includes(tid)));
}
function tierOfTeacher(T, wd, slot) {
  if (!T) return 0;
  if (T.role === 'apoyoinf') return 5;
  if (T.role === 'directivo') return 4;
  if (isSpecial(T.role)) return 3;
  const c = cellOf(T, wd, slot);
  return c ? ({ a: 2, o: 6, s: 7 })[c.t] || 1 : 1;
}

/* Qué franjas necesitan sustituto */
function needsFor(day, wd, teachers, patio, strike) {
  strike = strike || [];
  const out = [];
  for (const a of day.absences || []) {
    const T = teachers.find((t) => t.id === a.tid);
    if (!T) continue;
    for (const s of a.slots) {
      if (s === 'R') {
        if (onPatio(patio, wd, T.id)) out.push({ key: a.id + '_R', absId: a.id, absentId: T.id, slot: 'R', place: (patio && patio.turnsInf && (patio.turnsInf[wd] || []).includes(T.id)) ? 'Patio de infantil' : 'Patio', strike: strike.includes(a.id) });
      } else {
        const c = cellOf(T, wd, s);
        if (c && c.t === 'c' && !isSpecial(T.role)) {
          out.push({ key: a.id + '_' + s, absId: a.id, absentId: T.id, slot: s, place: c.g || ('Clase de ' + T.name), subject: c.m || '', strike: strike.includes(a.id) });
        }
      }
    }
  }
  return out;
}

/* Huecos semanales (horas libres + apoyos): la capacidad real de sustituir de cada profesor */
function capacity(T) {
  let n = 0;
  for (const k in (T.sched || {})) { const c = T.sched[k]; if (c && (c.t === 'l' || c.t === 'a')) n++; }
  return Math.max(n, 1);
}
function lectiveDay(T, wd) {
  return CLASS_SLOTS.filter((s) => { const c = cellOf(T, wd, s); return c && c.t === 'c'; }).length;
}

function loadMap(days, exceptDate) {
  const m = {};
  for (const d in days) {
    if (d === exceptDate) continue;
    for (const s of days[d].subs || []) if (s.subId) m[s.subId] = (m[s.subId] || 0) + 1;
  }
  return m;
}

/* Rotación de patios extra: quien lleva menos patios extra va primero; a igualdad, quien hizo el último hace más tiempo
   (quien nunca ha hecho ninguno, antes); a igualdad total, orden alfabético. Se salta a quien no puede ese día sin perder su turno.
   Historial: ctx.patioExtra = { desde: 'AAAA-MM-DD', base: { id: { n, last } } }. Los patios extra de la app se cuentan desde "desde". */
const PATIO_DESDE = '2026-11-06';
const PATIO_BASE_DEFAULT = {
  natalia: { n: 1, last: '2026-10-15' },
  'miriam-f': { n: 1, last: '2026-10-16' },
  eli: { n: 1, last: '2026-10-14' },
  pablo: { n: 1, last: '2026-10-14' }
};
function patioLedger(ctx, exceptDate) {
  const px = ctx.patioExtra || {};
  const desde = px.desde || PATIO_DESDE, base = px.base || PATIO_BASE_DEFAULT;
  const led = {};
  for (const id in base) led[id] = { n: base[id].n || 0, last: base[id].last || '' };
  for (const d in ctx.days || {}) {
    if (d === exceptDate || d < desde) continue;
    for (const s of ctx.days[d].subs || []) {
      if (s.slot !== 'R' || !s.subId) continue;
      const e = led[s.subId] || (led[s.subId] = { n: 0, last: '' });
      e.n++; if (d > e.last) e.last = d;
    }
  }
  return led;
}
const patioCmp = (led) => (a, b) => {
  const x = led[a.id] || { n: 0, last: '' }, y = led[b.id] || { n: 0, last: '' };
  return x.n - y.n || (x.last < y.last ? -1 : x.last > y.last ? 1 : 0) || a.name.localeCompare(b.name, 'es');
};

/* Reparto. ctx = {teachers, patio, days, maxDir} */
function assign(day, date, ctx, resetAll) {
  const wd = weekdayKey(date);
  const teachers = ctx.teachers;
  if (!wd) return [];
  ctx = Object.assign({}, ctx, { patio: patioForDate(ctx.patio, date) });
  const needs = needsFor(day, wd, teachers, ctx.patio, ctx.strike);
  const old = new Map((day.subs || []).map((s) => [s.key, s]));
  const load = loadMap(ctx.days, date);
  const pled = patioLedger(ctx, date), pcmp = patioCmp(pled);
  const used = {};
  const mark = (slot, id) => {
    (used[slot] = used[slot] || new Set()).add(id); load[id] = (load[id] || 0) + 1;
    if (slot === 'R') { const e = pled[id] || (pled[id] = { n: 0, last: '' }); e.n++; if (date > e.last) e.last = date; }
  };
  const roleOf = (id) => (teachers.find((t) => t.id === id) || {}).role;
  const dirToday = {};
  const out = [];
  const todo = [];

  for (const n of needs) {
    const o = old.get(n.key);
    const keep = !resetAll && o && o.subId && teachers.some((t) => t.id === o.subId) && !isAbsent(day, o.subId, n.slot) && !(n.strike && !(ctx.sm || []).includes(o.subId));
    if (keep) {
      out.push({ ...n, subId: o.subId, tier: o.tier || 0, fb: !!o.fb, manual: !!o.manual });
      mark(n.slot, o.subId);
      if (roleOf(o.subId) === 'directivo') dirToday[o.subId] = (dirToday[o.subId] || 0) + 1;
    } else todo.push(n);
  }
  // los reservados a mano que quedaron fuera de "needs" no cuentan; el resto se reparte
  todo.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));

  const candidates = (tier, slot, need) => teachers.filter((T) => {
    if (need && need.strike && !(ctx.sm || []).includes(T.id)) return false;
    if (used[slot] && used[slot].has(T.id)) return false;
    if (isAbsent(day, T.id, slot)) return false;
    if (!presentDay(T, wd)) return false;
    const c = cellOf(T, wd, slot);
    const t = c ? c.t : 'n';
    if (slot === 'R') {
      if (onPatio(ctx.patio, wd, T.id)) return false;
      if (tier === 1) return isPrim(T);
      if (tier === 3) return isSpecial(T.role);
      return false; // el equipo directivo no cubre patio
    }
    if (tier === 1) return isPrim(T) && t === 'l';
    if (tier === 2) return isPrim(T) && t === 'a';
    if (tier === 6) return isPrim(T) && t === 'o';
    if (tier === 7) return isPrim(T) && t === 's';
    if (tier === 3) return isSpecial(T.role) && t !== 'n';
    if (tier === 4) return T.role === 'directivo' && t !== 'n' && (dirToday[T.id] || 0) < ctx.maxDir;
    if (tier === 9) return T.role === 'directivo' && t !== 'n';
    return false;
  });

  for (const n of todo) {
    if (roleOf(n.absentId) === 'infantil') {
      // Infantil: 1 ausente -> profesora de apoyo de infantil; 2 o más -> PT y AL (mejor quien ya da clase en infantil en esa franja)
      const infN = (day.absences || []).filter((a) => a.slots.includes(n.slot) && roleOf(a.tid) === 'infantil').length;
      const kinds = infN >= 2 ? ['pt', 'apoyoinf', 'dir', 'dir9'] : ['apoyoinf', 'pt', 'dir', 'dir9'];
      let got = null;
      for (const kind of kinds) {
        const list = teachers.filter((T) => {
          if (used[n.slot] && used[n.slot].has(T.id)) return false;
          if (isAbsent(day, T.id, n.slot) || !presentDay(T, wd)) return false;
          if (n.strike && !(ctx.sm || []).includes(T.id)) return false;
          if (n.slot === 'R' && onPatio(ctx.patio, wd, T.id)) return false;
          const c = cellOf(T, wd, n.slot), t = n.slot === 'R' ? 'l' : (c ? c.t : 'n');
          if (t === 'n') return false;
          if (n.slot === 'R' && kind.startsWith('dir')) return false; // el equipo directivo no cubre patio
          if (kind === 'apoyoinf') return T.role === 'apoyoinf';
          if (kind === 'pt') return isSpecial(T.role);
          return T.role === 'directivo' && !!T.cubreInf && (kind === 'dir9' || (dirToday[T.id] || 0) < ctx.maxDir);
        });
        if (!list.length) continue;
        const rank = (T) => {
          const c = cellOf(T, wd, n.slot), t = n.slot === 'R' ? 'l' : (c ? c.t : 'n');
          if (kind === 'pt') return t === 'c' && isInfGroup(c.g) ? 0 : ({ l: 1, a: 2, c: 3 })[t];
          if (kind === 'apoyoinf') return t === 'c' ? 1 : 0;
          return 0;
        };
        const score = (T) => kind.startsWith('dir') ? lectiveDay(T, wd) + (dirToday[T.id] || 0) : (load[T.id] || 0) / capacity(T);
        list.sort((a, b) => rank(a) - rank(b) || (n.slot === 'R' ? pcmp(a, b) : 0) || score(a) - score(b) || a.name.localeCompare(b.name, 'es'));
        got = { T: list[0], kind, fb: kind !== kinds[0] };
        break;
      }
      if (got) {
        mark(n.slot, got.T.id);
        if (got.kind.startsWith('dir')) dirToday[got.T.id] = (dirToday[got.T.id] || 0) + 1;
        out.push({ ...n, subId: got.T.id, tier: got.kind === 'apoyoinf' ? 5 : got.kind === 'pt' ? 3 : 4, fb: got.fb || got.kind === 'dir9', manual: false });
      } else out.push({ ...n, subId: null, tier: 0, fb: false, manual: false });
      continue;
    }
    const absentNow = (day.absences || []).filter((a) => a.slots.includes(n.slot) && roleOf(a.tid) !== 'infantil').length;
    const start = 1;
    // Fuentes permitidas según cuántos profesores faltan a la vez (en este orden):
    //  1 ausente: libre, coordinación, directivo (no se quitan apoyos)
    //  2 ausentes: libre, coordinación, apoyo (y speaking), directivo
    //  3 o más: libre, coordinación, apoyo (y speaking), PT/AL, directivo
    const order = absentNow <= 1 ? [1, 6, 4, 9] : absentNow === 2 ? [1, 6, 2, 7, 4, 9] : [1, 6, 2, 7, 3, 4, 9];
    let picked = null, pickedTier = 0;
    for (const tier of order) {
      const list = candidates(tier, n.slot, n);
      if (!list.length) continue;
      const rank = (T) => {
        if (tier === 2 && n.slot !== 'R') { const c = cellOf(T, wd, n.slot); return c && c.g && n.place && norm(n.place).includes(norm(c.g)) ? 0 : 1; }
        if (!(tier === 3 || tier === 4 || tier === 9) || n.slot === 'R') return 0;
        const c = cellOf(T, wd, n.slot);
        return ({ l: 0, o: 1, s: 1, a: 2, c: 3 })[c ? c.t : 'c'];
      };
      // Directivos: compensar clases del día con sustituciones. Resto: sustituciones pasadas en proporción a sus huecos.
      const score = (T) => (tier === 4 || tier === 9) ? lectiveDay(T, wd) + (dirToday[T.id] || 0) : (load[T.id] || 0) / capacity(T);
      list.sort((a, b) => rank(a) - rank(b) || (n.slot === 'R' ? pcmp(a, b) : 0) || score(a) - score(b) || (load[a.id] || 0) - (load[b.id] || 0) || a.name.localeCompare(b.name, 'es'));
      picked = list[0]; pickedTier = tier; break;
    }
    if (picked) {
      mark(n.slot, picked.id);
      if (picked.role === 'directivo') dirToday[picked.id] = (dirToday[picked.id] || 0) + 1;
      out.push({ ...n, subId: picked.id, tier: pickedTier === 9 ? 4 : pickedTier, fb: pickedTier === 9, manual: false });
    } else {
      out.push({ ...n, subId: null, tier: 0, fb: false, manual: false });
    }
  }
  out.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || a.absentId.localeCompare(b.absentId));
  return out;
}

/* ===== Importación desde tablas de Word ===== */
function parseCell(raw) {
  if (raw == null) return { t: 'n', g: '' };
  const txt = String(raw).replace(/\s+/g, ' ').trim();
  const n = norm(txt);
  if (!txt) return { t: 'l', g: '' };                                   // celda vacía = libre
  if (/^(-+|—|–|x|no|n\/a|ausente)$/.test(n)) return { t: 'n', g: '' };   // guion = no está
  if (/^(hora )?libre|^disponible|^(l|lib)$/.test(n)) return { t: 'l', g: '' };
  if (/^(coo|coord)|^reunion|^gestion/.test(n)) return { t: 'o', g: '' }; // COO = coordinación
  const sp = txt.match(/^(spk|speaking|desdoble)\b[\s:\-–.]*(.*)$/i);   // SPK = speaking (desdoble)
  if (sp) return { t: 's', g: sp[2].trim() };
  const m = txt.match(/^(ap\.?|apoyo|refuerzo)\b[\s:\-–.]*(.*)$/i);      // AP = apoyo
  if (m) return { t: 'a', g: m[2].trim() };
  return { t: 'c', g: txt };
}
function splitRows(text) {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  const useTab = rows.some((r) => r.includes('\t'));
  return rows.map((r) => useTab ? r.split('\t') : (r.includes('|') ? r.split('|') : r.split(/\s{2,}/)));
}
function parseTable(text) {
  let rows = splitRows(text);
  const hi = rows.findIndex((r) => /lunes|martes/.test(norm(r.join(' '))) || (r.filter((c) => /^[LMXJV]$/i.test(c.trim())).length >= 4));
  if (hi >= 0) rows = rows.slice(hi + 1);
  rows = rows.filter((r) => !/recreo|almuerzo|comedor/.test(norm(r.join(' '))));
  const sched = {};
  rows.slice(0, 6).forEach((r, i) => {
    const cells = r.length > 5 ? r.slice(-5) : r;
    WD.forEach((d, j) => { sched[d + CLASS_SLOTS[i]] = parseCell(cells[j]); });
  });
  return sched;
}
function parseRole(s) {
  const n = norm(s);
  if (/apoyo.*infantil|infantil.*apoyo/.test(n)) return 'apoyoinf';
  if (/^pt\b|terapeutica|pedagogia/.test(n)) return 'pt';
  if (/^al\b|audicion|lenguaje/.test(n)) return 'al';
  if (/direc|jefe|jefa|secret|equipo/.test(n)) return 'directivo';
  if (/infantil|3 anos|4 anos|5 anos/.test(n)) return 'infantil';
  if (/especial|ingl|music|fisica|\bef\b|franc|religi|plastica|especialista/.test(n)) return 'especialista';
  return 'tutor';
}
/* Bloques "@Nombre | rol" seguidos de su tabla. Sin "@", devuelve null. */
function parseBulk(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (/^\s*@/.test(l)) {
      const [name, role] = l.replace(/^\s*@/, '').split('|');
      cur = { name: (name || '').trim(), role: parseRole(role || ''), cubreInf: /infantil/.test(norm(role || '')), body: [] };
      blocks.push(cur);
    } else if (cur) cur.body.push(l);
  }
  if (!blocks.length) return null;
  return blocks.filter((b) => b.name).map((b) => ({ name: b.name, role: b.role, cubreInf: b.role === 'directivo' && b.cubreInf, sched: parseTable(b.body.join('\n')) }));
}
function matchTeacher(name, teachers) {
  const n = norm(name);
  if (!n) return null;
  let best = teachers.find((t) => norm(t.name) === n);
  if (best) return best;
  const hits = teachers.filter((t) => norm(t.name).includes(n) || n.includes(norm(t.name)));
  return hits.length === 1 ? hits[0] : null;
}
function parsePatios(text, teachers) {
  const turns = { L: [], M: [], X: [], J: [], V: [] };
  const unknown = [];
  const key = { lunes: 'L', martes: 'M', miercoles: 'X', jueves: 'J', viernes: 'V', l: 'L', m: 'M', x: 'X', j: 'J', v: 'V' };
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const d = key[norm(line.slice(0, i))];
    if (!d) continue;
    for (const nm of line.slice(i + 1).split(/[,;]/)) {
      if (!nm.trim()) continue;
      const T = matchTeacher(nm, teachers);
      if (T) { if (!turns[d].includes(T.id)) turns[d].push(T.id); } else unknown.push(nm.trim());
    }
  }
  return { turns, unknown };
}

/* ===== Datos de ejemplo ===== */
function buildExample() {
  const mk = (id, name, role, fn) => {
    const sched = {};
    WD.forEach((d, di) => CLASS_SLOTS.forEach((s, si) => { sched[d + s] = fn(di, si + 1); }));
    return { id, name, role, sched };
  };
  const tutors = ['Marta Ruiz', 'Javier Soto', 'Lucía Prieto', 'Andrés Gil', 'Elena Cano', 'Pablo Mena'].map((nm, i) =>
    mk('e' + (i + 1), nm, 'tutor', (d, s) => {
      if ((d + s + i) % 7 === 0) return { t: 'l', g: '' };
      if ((d + s + i) % 11 === 5) return { t: 'o', g: '' };
      if ((d * 2 + s + i) % 7 === 3) return { t: 'a', g: ((i + 1) % 6 + 1) + 'º' };
      return { t: 'c', g: (i + 1) + 'º' };
    }));
  const esp = [['Irene Vega', 'Inglés'], ['Raúl Peña', 'Ed. Física']].map(([nm, mat], i) =>
    mk('e' + (7 + i), nm, 'especialista', (d, s) => {
      if ((d + s + i) % 3 === 0) return { t: 'l', g: '' };
      if ((d + s * 2 + i) % 5 === 0) return { t: 'a', g: ((d + s) % 6 + 1) + 'º' };
      if (i === 0 && (d + s) % 7 === 2) return { t: 's', g: 'Speaking ' + ((d + s) % 6 + 1) + 'º' };
      return { t: 'c', g: mat + ' ' + ((d + s + i) % 6 + 1) + 'º' };
    }));
  const pt = mk('e9', 'Sonia Lara', 'pt', (d, s) => ((d + s) % 4 === 0 ? { t: 'l', g: '' } : (d + s) % 5 === 1 ? { t: 'c', g: 'Infantil 5 años' } : { t: 'c', g: 'Apoyo ' + ((d + s) % 6 + 1) + 'º' }));
  const al = mk('e10', 'Nuria Bravo', 'al', (d, s) => ((d + s) % 3 === 0 ? { t: 'l', g: '' } : { t: 'c', g: 'AL ' + ((d + s) % 6 + 1) + 'º' }));
  const dirs = [['e11', 'Carmen Ortiz (directora)', 3], ['e12', 'Tú (jefe de estudios)', 2], ['e13', 'Rosa Medina (secretaria)', 4]].map(([id, nm, m]) =>
    mk(id, nm, 'directivo', (d, s) => ((d + s) % m === 0 ? { t: 'c', g: ((d + s) % 6 + 1) + 'º' } : { t: 'l', g: '' })));
  const inf = ['Laura Pons', 'Sara Mora'].map((nm, i) => mk('e' + (14 + i), nm, 'infantil', (d, s) => ((d + s + i) % 6 === 0 ? { t: 'l', g: '' } : { t: 'c', g: 'Infantil ' + (4 + i) + ' años' })));
  const ana = mk('e16', 'Ana Beltrán', 'apoyoinf', (d, s) => ((d + s) % 4 === 0 ? { t: 'l', g: '' } : { t: 'a', g: 'Infantil' }));
  dirs[0].cubreInf = true; dirs[1].cubreInf = true;
  const teachers = [...tutors, ...esp, pt, al, ...dirs, ...inf, ana];
  const t = (i) => teachers[i].id;
  const turns = { L: [t(0), t(7)], M: [t(1), t(8)], X: [t(2), t(6)], J: [t(3), t(9)], V: [t(4), t(5)] };
  const turnsInf = { L: [t(13), t(15)], M: [t(14), t(15)], X: [t(13)], J: [t(14)], V: [t(13), t(15)] };
  return { teachers, turns, turnsInf };
}

if (typeof module !== 'undefined') {
  module.exports = { patioLedger, PATIO_BASE_DEFAULT, PATIO_DESDE, patioForDate, WD, assign, needsFor, parseTable, parseBulk, parseCell, parsePatios, buildExample, weekdayKey, DEFAULT_SESSIONS, TIER_NAMES, parseRole };
}
