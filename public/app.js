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
const PLAN_ESPECIFICO = ['belen']; // no se les quita el apoyo para sustituir, salvo si su grupo se queda sin profesor
const isPrim = (T) => T.role === 'tutor' || T.role === 'especialista';
// grupo de referencia de un tutor: el que más horas tiene en su horario
function homeGroup(T) {
  if (!T || !['tutor', 'infantil', 'especialista'].includes(T.role)) return null;
  const m = {}; let tot = 0;
  for (const k in T.sched || {}) { const c = T.sched[k]; if (c && c.t === 'c' && c.g) { m[c.g] = (m[c.g] || 0) + 1; tot++; } }
  let best = null; for (const g in m) if (!best || m[g] > m[best]) best = g;
  // un especialista solo tiene grupo de referencia si más de la mitad de sus clases son de ese grupo (p. ej. un tutor que da inglés)
  if (best && T.role === 'especialista' && m[best] < tot / 2) return null;
  return best;
}
// Profesores que se quedan libres porque su grupo se va de excursión: { id: ['2','5'] }
function freedByExcursion(day, wd, teachers) {
  const out = {};
  for (const e of (day && day.exc) || []) {
    for (const tid of e.tids || []) {
      const g = homeGroup(teachers.find((t) => t.id === tid));
      if (!g) continue;
      for (const U of teachers) {
        if ((e.tids || []).includes(U.id) || !isPrim(U)) continue;
        for (const sl of ['1', '2', '3', '4', '5', '6']) {
          const c = U.sched && U.sched[wd + sl];
          if (c && c.t === 'c' && c.g === g) (out[U.id] = out[U.id] || new Set()).add(sl);
        }
      }
    }
  }
  return out;
}
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
    // si el profesor sale de excursión, las clases que da a su propio grupo no se sustituyen: ese grupo va con él
    const hg = (day.exc || []).some((e) => (e.tids || []).includes(T.id)) ? homeGroup(T) : null;
    for (const s of a.slots) {
      if (s === 'R') {
        if (onPatio(patio, wd, T.id)) out.push({ key: a.id + '_R', absId: a.id, absentId: T.id, slot: 'R', place: (patio && patio.turnsInf && (patio.turnsInf[wd] || []).includes(T.id)) ? 'Patio de infantil' : 'Patio', strike: strike.includes(a.id) });
      } else {
        const c = cellOf(T, wd, s);
        if (c && c.t === 'c' && !isSpecial(T.role) && !(hg && c.g === hg)) {
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
    // una asignación automática antigua que incumple el horario de un profesor de plan específico (Belén) se vuelve a repartir
    const planBad = (() => { if (!o || !o.subId || o.manual || !PLAN_ESPECIFICO.includes(o.subId)) return false; const T = teachers.find((t) => t.id === o.subId), c = n.slot === 'R' ? null : cellOf(T, wd, n.slot); return !(c && (c.t === 'l' || (c.t === 'a' && c.g && n.place && norm(n.place).includes(norm(c.g))))); })();
    if (keep && !planBad) {
      out.push({ ...n, subId: o.subId, tier: o.tier || 0, fb: !!o.fb, manual: !!o.manual });
      mark(n.slot, o.subId);
      if (roleOf(o.subId) === 'directivo') dirToday[o.subId] = (dirToday[o.subId] || 0) + 1;
    } else todo.push(n);
  }
  // los reservados a mano que quedaron fuera de "needs" no cuentan; el resto se reparte
  todo.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));

  const freed = freedByExcursion(day, wd, teachers);
  const isExcAbs = (n) => { const a = (day.absences || []).find((x) => x.id === n.absId); return !!(a && a.exc); };
  const candidates = (tier, slot, need) => teachers.filter((T) => {
    if (need && need.strike && !(ctx.sm || []).includes(T.id)) return false;
    if (used[slot] && used[slot].has(T.id)) return false;
    if (isAbsent(day, T.id, slot)) return false;
    if (!presentDay(T, wd)) return false;
    const c = cellOf(T, wd, slot);
    const t = c ? c.t : 'n';
    if (slot === 'R') {
      if (onPatio(ctx.patio, wd, T.id)) return false;
      if (PLAN_ESPECIFICO.includes(T.id)) return false;
      if (tier === 1) return isPrim(T);
      if (tier === 3) return isSpecial(T.role);
      return false; // el equipo directivo no cubre patio
    }
    if (tier === 10) return !!(freed[T.id] && freed[T.id].has(slot)) && t === 'c';
    if (tier === 1) return isPrim(T) && t === 'l';
    if (tier === 2) {
      if (!(isPrim(T) && t === 'a')) return false;
      // profesorado de un plan específico (apoyo de matemáticas): solo sustituye en su apoyo si el grupo al que apoya se queda sin profesor
      if (PLAN_ESPECIFICO.includes(T.id)) return !!(c && c.g && need && need.place && norm(need.place).includes(norm(c.g)));
      return true;
    }
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
    const absentNow = new Set(needs.filter((x) => roleOf(x.absentId) !== 'infantil').map((x) => x.absentId)).size; // profesores distintos que necesitan sustituto ese día
    const start = 1;
    // Fuentes permitidas según cuántos profesores faltan ese día (en este orden):
    //  1 ausente: libre, coordinación, directivo (no se quitan apoyos)
    //  2 ausentes: libre, coordinación, apoyo (y speaking), directivo
    //  3 o más: libre, coordinación, apoyo (y speaking), PT/AL, directivo
    const order = absentNow <= 1 ? [1, 6, 4, 9] : absentNow === 2 ? [1, 6, 2, 7, 4, 9] : [1, 6, 2, 7, 3, 4, 9];
    // quien se queda libre porque su grupo está de excursión cubre primero las ausencias que no son de excursión
    if (!isExcAbs(n) && n.slot !== 'R' && Object.keys(freed).length) order.unshift(10);
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
      out.push({ ...n, subId: picked.id, tier: pickedTier === 9 ? 4 : pickedTier === 10 ? 1 : pickedTier, fb: pickedTier === 9, manual: false });
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

/* ===== Interfaz ===== */
(() => { const ap = Element.prototype.append; Element.prototype.append = function (...a) { return ap.apply(this, a.flat(Infinity).filter((x) => x != null && x !== false)); }; })();
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let val;
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (k === 'value') val = v;
    else if (k === 'checked') el.checked = true;
    else if (k === 'disabled') el.disabled = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (val !== undefined) el.value = val;
  return el;
}
const $ = (s, el) => (el || document).querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtDate = (s) => toDate(s).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = (s) => toDate(s).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const rid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const timeAgo = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'ahora mismo';
  if (m < 60) return 'hace ' + m + ' min';
  const hh = Math.round(m / 60);
  if (hh < 24) return 'hace ' + hh + ' h';
  return fmtShort(new Date(ts).getFullYear() + '-' + pad(new Date(ts).getMonth() + 1) + '-' + pad(new Date(ts).getDate()));
};

const S = {
  db: null, user: null, uid: null, admin: false, canWrite: null, me: null,
  school: null, days: {}, patios: {}, priv: {}, sm: {}, smWeek: null, notifs: [], dayNotifs: [], chatMsgs: [],
  tab: null, date: todayStr(), chatDate: null, patioMonth: todayStr().slice(0, 7), selT: null,
  loaded: { school: false, days: false, patios: false }
};
const DEFAULT_SCHOOL = () => ({ teachers: [], sessions: { ...DEFAULT_SESSIONS }, maxDir: 2, example: false });
S.school = DEFAULT_SCHOOL();

const tById = (id) => S.school.teachers.find((t) => t.id === id);
const tName = (id) => (tById(id) ? tById(id).name : '(ya no está)');
const sessTime = (s) => (S.school.sessions && S.school.sessions[s]) || DEFAULT_SESSIONS[s] || '';
const sortedTeachers = () => [...S.school.teachers].sort((a, b) => a.name.localeCompare(b.name, 'es'));
const strikeIds = (d) => (S.priv[d] && S.priv[d].huelga) || [];
const weekStart = (date) => addDays(date, -((toDate(date).getDay() + 6) % 7));
const smFor = (date) => { const wd = weekdayKey(date); return wd ? (((S.sm[weekStart(date)] || {}).days || {})[wd] || []) : []; };
const ctxFor = (date) => ({ teachers: S.school.teachers, patio: S.patios[date.slice(0, 7)], days: S.days, maxDir: S.school.maxDir || 2, patioExtra: S.school.patioExtra, strike: strikeIds(date), sm: smFor(date) });
function savePriv(date, ids) { S.priv[date] = { ...(S.priv[date] || {}), huelga: ids }; return S.db.doc('private/' + date).set({ huelga: ids }, { merge: true }); }
const notasOf = (date) => (S.priv[date] || {}).notas || {};

/* ---------- avisos en pantalla y cola de escrituras ---------- */
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = '';
  t.append(icon(bad ? 'info' : 'check'), h('span', null, msg));
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 4200);
}
const offBar = h('div', { id: 'offbar', role: 'status' }, 'Sin conexión · se muestran los últimos datos guardados');
offBar.hidden = navigator.onLine !== false;
document.body.prepend(offBar);
window.addEventListener('offline', () => { offBar.hidden = false; });
window.addEventListener('online', () => { offBar.hidden = true; });
let queue = Promise.resolve();
function enqueue(fn) {
  if (navigator.onLine === false) { toast('Sin conexión: no se puede guardar ahora.', true); return queue; }
  queue = queue.then(fn).catch((e) => {
    console.error(e);
    toast(e && e.code === 'invalid_argument' ? 'No tienes permiso para guardar este cambio.' : 'No se pudo guardar. Inténtalo de nuevo.', true);
  });
  return queue;
}

/* ---------- guardado ---------- */
function saveSchool(mut) {
  return enqueue(async () => {
    const next = JSON.parse(JSON.stringify(S.school));
    mut(next);
    S.school = next;
    renderAll();
    await S.db.doc('school/main').set(next);
  });
}
function savePatio(month, mut) {
  return enqueue(async () => {
    const cur = S.patios[month] ? JSON.parse(JSON.stringify(S.patios[month])) : { turns: { L: [], M: [], X: [], J: [], V: [] } };
    cur.turnsInf = cur.turnsInf || { L: [], M: [], X: [], J: [], V: [] };
    mut(cur);
    S.patios[month] = cur;
    renderAll();
    await S.db.doc('patios/' + month).set(cur);
  });
}
const placeTxt = (s) => (s.place || '') + (s.subject ? ' · ' + s.subject : '');
function notifText(date, s, kind, nota) {
  const place = placeTxt(s);
  if (kind === 'cancela') {
    return 'Ya no tienes que sustituir a ' + tName(s.absentId) + ' el ' + fmtShort(date) + ' en ' + slotLabel(s.slot).toLowerCase() + '.';
  }
  return 'Sustituyes a ' + tName(s.absentId) + ' el ' + fmtShort(date) + ', ' + slotLabel(s.slot).toLowerCase() + ' (' + sessTime(s.slot) + '). Lugar: ' + place + '.' + (nota ? ' Nota: ' + nota : '');
}
async function saveDay(date, next, old) {
  const oldMap = new Map(((old && old.subs) || []).map((s) => [s.key, s]));
  const nextMap = new Map(next.subs.map((s) => [s.key, s]));
  // Las notas para el sustituto no se guardan en el documento del día (lo lee todo el profesorado):
  // van en el espacio privado de jefatura y en el aviso de quien sustituye.
  const notas = { ...notasOf(date) };
  let notasCambian = false;
  for (const a of next.absences || []) { if (a.nota && notas[a.id] !== a.nota) { notas[a.id] = a.nota; notasCambian = true; } delete a.nota; }
  const noteOf = (d, s) => notas[s.absId] || '';
  const out = [];
  const mk = (s, to, kind, d) => ({ to, date, slot: s.slot, key: s.key, kind, text: notifText(date, s, kind, kind === 'cancela' ? '' : noteOf(d, s)), nota: kind === 'cancela' ? '' : noteOf(d, s), ts: Date.now(), read: false, absentId: s.absentId });
  for (const [k, s] of nextMap) {
    const o = oldMap.get(k);
    if (s.subId && (!o || o.subId !== s.subId)) out.push(mk(s, s.subId, 'asigna', next));
    if (o && o.subId && o.subId !== s.subId) out.push(mk(o, o.subId, 'cancela', old));
  }
  for (const [k, o] of oldMap) if (!nextMap.has(k) && o.subId) out.push(mk(o, o.subId, 'cancela', old));
  // la marca de huelga es privada de jefatura: no se guarda en el documento que lee el profesorado
  next.subs = next.subs.map((x) => { const y = { ...x }; delete y.strike; return y; });
  // quién sustituye ese día: lo usan las reglas de seguridad para limitar el chat del día a sus participantes
  next.subIds = {}; for (const x of next.subs) if (x.subId) next.subIds[x.subId] = true;
  S.days[date] = next;
  renderAll();
  if (notasCambian) { S.priv[date] = { ...(S.priv[date] || {}), notas }; await S.db.doc('private/' + date).set({ notas }, { merge: true }); }
  await S.db.doc('days/' + date).set(next);
  for (const n of out) await S.db.collection('notifs').add(n);
  if (window.pushNotify && out.length) window.pushNotify(out).catch(() => {});
  return out.length;
}
const cloneDay = (date) => {
  const d = S.days[date];
  return d ? JSON.parse(JSON.stringify(d)) : { date, absences: [], subs: [] };
};
async function doAddAbsence(date, tid, slots, nota, tipo) {
  const old = S.days[date] ? JSON.parse(JSON.stringify(S.days[date])) : null;
  const day = cloneDay(date);
  let aid;
  const ex = day.absences.find((a) => a.tid === tid);
  if (ex) { ex.slots = [...new Set([...ex.slots, ...slots])]; if (nota) ex.nota = nota; aid = ex.id; }
  else { aid = rid(); day.absences.push({ id: aid, tid, slots, nota: nota || '' }); }
  const strike = strikeIds(date).slice();
  if (tipo === 'huelga' && !strike.includes(aid)) strike.push(aid);
  day.subs = assign(day, date, { ...ctxFor(date), strike }, false);
  if (strike.length !== strikeIds(date).length) await savePriv(date, strike);
  const n = await saveDay(date, day, old);
  return { n, sin: day.subs.filter((s) => !s.subId).length };
}
const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
function addAbsence(date, tid, slots, nota, tipo) {
  return enqueue(async () => {
    const { n, sin } = await doAddAbsence(date, tid, slots, nota, tipo);
    toast('Ausencia registrada · ' + plural(n, 'aviso enviado', 'avisos enviados') + (sin ? ' · ' + sin + ' franja(s) sin cubrir' : ''), !!sin);
  });
}
function addAbsenceRange(from, to, tid, slots, nota, tipo) {
  return enqueue(async () => {
    let d = from, days = 0, n = 0, sin = 0;
    while (d <= to && days < 45) {
      if (weekdayKey(d)) { const r = await doAddAbsence(d, tid, slots, nota, tipo); n += r.n; sin += r.sin; days++; }
      d = addDays(d, 1);
    }
    toast('Ausencia registrada en ' + plural(days, 'día lectivo', 'días lectivos') + ' · ' + plural(n, 'aviso enviado', 'avisos enviados') + (sin ? ' · ' + sin + ' franja(s) sin cubrir' : ''), !!sin);
  });
}
function removeAbsence(date, absId) {
  return enqueue(async () => {
    const old = JSON.parse(JSON.stringify(S.days[date]));
    const day = cloneDay(date);
    day.absences = day.absences.filter((a) => a.id !== absId);
    const strike = strikeIds(date).filter((i) => i !== absId);
    day.subs = assign({ ...day, subs: day.subs.filter((s) => s.absId !== absId) }, date, { ...ctxFor(date), strike }, false);
    if (strike.length !== strikeIds(date).length) await savePriv(date, strike);
    await saveDay(date, day, old);
    toast('Ausencia quitada y avisos de cancelación enviados');
  });
}
function setStrike(date, absId, on) {
  return enqueue(async () => {
    const old = JSON.parse(JSON.stringify(S.days[date]));
    const day = cloneDay(date);
    const strike = strikeIds(date).filter((i) => i !== absId);
    if (on) strike.push(absId);
    day.subs = assign({ ...day, subs: day.subs.filter((s) => s.absId !== absId) }, date, { ...ctxFor(date), strike }, false);
    await savePriv(date, strike);
    const n = await saveDay(date, day, old);
    toast(on ? 'Marcada como huelga: solo cubren los servicios mínimos · ' + n + ' aviso(s)' : 'Ya no es huelga · ' + n + ' aviso(s)');
  });
}
function saveSM(week, tid, d, on) {
  return enqueue(async () => {
    const cur = S.sm[week] ? JSON.parse(JSON.stringify(S.sm[week])) : { days: {} };
    cur.days = cur.days || {};
    const set = new Set(cur.days[d] || []);
    on ? set.add(tid) : set.delete(tid);
    cur.days[d] = [...set];
    S.sm[week] = cur; renderAll();
    await S.db.doc('sm/' + week).set(cur);
  });
}
function reassignDay(date) {
  return enqueue(async () => {
    const old = JSON.parse(JSON.stringify(S.days[date]));
    const day = cloneDay(date);
    day.subs = assign(day, date, ctxFor(date), true);
    const n = await saveDay(date, day, old);
    toast('Reparto recalculado · ' + n + ' aviso' + (n === 1 ? '' : 's') + ' enviados');
  });
}
function setSub(date, key, subId) {
  return enqueue(async () => {
    const old = JSON.parse(JSON.stringify(S.days[date]));
    const day = cloneDay(date);
    const s = day.subs.find((x) => x.key === key);
    if (!s) return;
    s.subId = subId || null;
    s.manual = !!subId;
    s.fb = false;
    s.tier = subId ? tierOfTeacher(tById(subId), weekdayKey(date), s.slot) : 0;
    const n = await saveDay(date, day, old);
    toast(subId ? 'Cambio guardado · aviso enviado a ' + tName(subId) : 'Franja sin asignar' + (n ? ' · aviso de cancelación enviado' : ''));
  });
}

/* ---------- identidad ---------- */
const LS_ME = 'celaya_me';
function setMe(tid) {
  S.me = tid || null;
  try { tid ? localStorage.setItem(LS_ME, tid) : localStorage.removeItem(LS_ME); } catch (e) {}
  if (S.uid && S.db) {
    const ref = S.db.doc('data/users/' + S.uid + '/profile');
    (tid ? ref.set({ tid }) : ref.delete()).catch(() => {});
  }
  subscribeNotifs();
  renderAll();
}
function pingPresence() { try { if (window.presenceApi) window.presenceApi.ping(); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pingPresence(); });
// Corrige asignaciones automáticas antiguas que incumplen el horario de Belén (plan de apoyo): solo hoy y días futuros
const _fixDone = new Set();
function fixPlanEspecifico() {
  if (!S.loaded.school || !S.school.teachers.length) return;
  const today = todayStr();
  for (const date in S.days) {
    if (date < today || !weekdayKey(date)) continue;
    const day = S.days[date], wd = weekdayKey(date);
    const bad2 = (day.exc || []).length && (day.subs || []).some((x) => {
      if (!x.subId || x.manual || x.slot === 'R') return false;
      const T = tById(x.absentId); if (!T || !(day.exc || []).some((e) => (e.tids || []).includes(T.id))) return false;
      const g = homeGroup(T), c = cellOf(T, wd, x.slot); return !!(g && c && c.t === 'c' && c.g === g);
    });
    const bad1 = (day.subs || []).some((x) => {
      if (!x.subId || x.manual || !PLAN_ESPECIFICO.includes(x.subId)) return false;
      const T = tById(x.subId), c = x.slot === 'R' ? null : cellOf(T, wd, x.slot);
      return !(c && (c.t === 'l' || (c.t === 'a' && c.g && x.place && norm(x.place).includes(norm(c.g)))));
    });
    const bad = bad1 || bad2;
    const sig = date + '|' + JSON.stringify((day.subs || []).map((x) => x.key + x.subId));
    if (!bad || _fixDone.has(sig)) continue;
    _fixDone.add(sig);
    enqueue(async () => {
      const old = JSON.parse(JSON.stringify(S.days[date])), d2 = cloneDay(date);
      d2.subs = assign(d2, date, ctxFor(date), false);
      const n = await saveDay(date, d2, old);
      toast('Reparto corregido el ' + fmtShort(date) + ' · ' + plural(n, 'aviso enviado', 'avisos enviados'));
    });
  }
}
let unsubN = null;
function subscribeNotifs() {
  if (window.pushApi && S.me) window.pushApi.sync(S.me);
  if (unsubN) { unsubN(); unsubN = null; }
  S.notifs = [];
  if (!S.me || !S.db) return;
  unsubN = S.db.collection('notifs').where('to', '==', S.me).onSnapshot((snap) => {
    S.notifs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.ts - a.ts);
    renderAll();
  }, () => {});
}
let unsubDN = null, dnDate = null;
function subscribeDayNotifs() {
  if (!S.admin || !S.db || dnDate === S.date) return;
  if (unsubDN) unsubDN();
  dnDate = S.date; S.dayNotifs = [];
  unsubDN = S.db.collection('notifs').where('date', '==', S.date).onSnapshot((snap) => {
    S.dayNotifs = snap.docs.map((d) => d.data());
    refresh(Hoy);
  }, () => {});
}

/* ---------- vistas: refresco con espera si se está escribiendo ---------- */
const views = {};
function refresh(v) {
  if (!v || !v.built) return;
  if (v.deferOnFocus) {
    const a = document.activeElement;
    if (a && v.el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { v.pending = true; return; }
  }
  v.pending = false;
  v.render();
}
/* ---------- avisos del chat (sin leer) ---------- */
const CHATBG = { unsub: null, date: null, msgs: [], first: true };
function chatSeenLocal(d) { try { return +localStorage.getItem('celaya_cs_' + d) || 0; } catch (e) { return 0; } }
function setChatSeenLocal(d, ts) { try { localStorage.setItem('celaya_cs_' + d, String(ts)); } catch (e) {} }
function chatUnread() {
  const d = CHATBG.date; if (!d) return 0;
  const last = chatSeenLocal(d);
  return CHATBG.msgs.filter((m) => !(m.uid && m.uid === S.uid) && m.ts > last).length;
}
function syncChatBg() {
  const d = todayStr();
  const day = S.days[d];
  const ok = !!S.db && !!S.uid && (S.admin || (!!S.me && !!day && (day.subs || []).some((x) => x.subId === S.me)));
  if (!ok) { if (CHATBG.unsub) { CHATBG.unsub(); CHATBG.unsub = null; } CHATBG.date = null; CHATBG.msgs = []; return; }
  if (CHATBG.unsub && CHATBG.date === d) return;
  if (CHATBG.unsub) CHATBG.unsub();
  CHATBG.date = d; CHATBG.msgs = []; CHATBG.first = true;
  let q = S.db.collection('chats/' + d + '/msgs').orderBy('ts');
  if (q.limitToLast) q = q.limitToLast(60);
  CHATBG.unsub = q.onSnapshot((snap) => {
    const prev = CHATBG.msgs.length;
    CHATBG.msgs = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
    const viewing = S.tab === 'chat' && S.chatDate === d && !Chat.el.hidden;
    if (viewing && CHATBG.msgs.length) setChatSeenLocal(d, CHATBG.msgs[CHATBG.msgs.length - 1].ts);
    else if (!CHATBG.first && CHATBG.msgs.length > prev) {
      const nuevo = CHATBG.msgs[CHATBG.msgs.length - 1];
      if (!(nuevo.uid && nuevo.uid === S.uid)) toast('Nuevo mensaje en el chat de hoy');
    }
    CHATBG.first = false;
    renderTabs();
  }, () => {});
}
function renderAll() {
  renderHeader();
  syncChatBg();
  renderTabs();
  if (S.skel) {
    const loading = !S.loaded.school;
    S.skel.hidden = !loading;
    if (loading) { for (const k in views) views[k].el.hidden = true; return; }
  }
  const v = views[S.tab];
  if (v) { if (!v.built) { v.build(); v.built = true; } refresh(v); }
}
document.addEventListener('focusout', () => {
  setTimeout(() => { for (const k in views) if (views[k].pending && views[k].built && !views[k].el.contains(document.activeElement)) refresh(views[k]); }, 60);
});

function renderHeader() {
  const w = $('#who'); w.textContent = '';
  const me = S.me && tById(S.me);
  w.append(h('span', { class: 'pill ' + (S.admin ? 'accent' : '') }, S.admin ? 'Jefatura de estudios' : 'Profesorado'));
  if (me) w.append(h('span', { class: 'who-name' }, me.name));
  w.append(musicBtn());
  if (window.authApi) w.append(h('button', { class: 'btn ghost sm no-print', type: 'button', 'aria-label': 'Cerrar sesión', title: 'Cerrar sesión', onclick: () => { if (confirm('¿Cerrar sesión en este dispositivo?\n\nDejará de recibir avisos hasta que vuelvas a entrar.')) window.authApi.signOut(); } }, icon('out')));
}
function unreadCount() { return S.notifs.filter((n) => !n.read).length; }
const TAB_ICONS = { hoy: 'home', panel: 'calendar', mis: 'bell', chat: 'chat', patios: 'sun', prof: 'users', exc: 'pin', sm: 'shield', centro: 'school' };
function tabsList() {
  const t = [];
  if (S.admin) t.push(['hoy', 'Hoy']);
  t.push(['panel', 'Panel del día']);
  t.push(['mis', 'Mis sustituciones']);
  t.push(['chat', 'Comunicación']);
  t.push(['patios', 'Patios']);
  t.push(['prof', S.admin ? 'Profesorado' : 'Horarios']);
  if (S.admin) t.push(['exc', 'Excursiones']);
  if (S.admin) t.push(['sm', 'Servicios mínimos']);
  if (S.admin) t.push(['centro', 'Centro']);
  return t;
}
function renderTabs() {
  const nav = $('#tabs');
  if (!S.tab) S.tab = S.admin ? 'hoy' : 'panel';
  nav.textContent = '';
  for (const [k, label] of tabsList()) {
    const u = k === 'mis' ? unreadCount() : k === 'chat' ? chatUnread() : 0;
    nav.append(h('button', { class: 'tab' + (S.tab === k ? ' on' : '') + (u ? (k === 'chat' ? ' alert-chat' : ' alert-bell') : ''), role: 'tab', 'aria-selected': S.tab === k ? 'true' : 'false', onclick: () => go(k) }, icon(TAB_ICONS[k] || 'info'), label, u ? h('span', { class: 'badge' }, u) : null));
  }
  for (const k in views) views[k].el.hidden = k !== S.tab;
  renderBottomNav();
}
const SHORT = { hoy: 'Hoy', panel: 'Panel', mis: 'Mi turno', chat: 'Chat', patios: 'Patios', prof: 'Horarios', exc: 'Excursión', sm: 'Huelga', centro: 'Centro' };
function renderBottomNav() {
  const nav = $('#bnav'), sheet = $('#sheet');
  if (!nav) return;
  const all = tabsList();
  const main = all.length <= 5 ? all : all.slice(0, 4), more = all.length <= 5 ? [] : all.slice(4);
  nav.textContent = ''; sheet.textContent = '';
  const mk = (k, label, ic, on, fn, badge) => h('button', { class: 'bn' + (on ? ' on' : '') + (badge ? (k === 'chat' ? ' alert-chat' : k === 'mis' ? ' alert-bell' : '') : ''), 'aria-current': on ? 'page' : null, onclick: fn }, h('span', { class: 'bn-ico' }, icon(ic), badge ? h('span', { class: 'badge' }, badge) : null), h('span', { class: 'bn-l' }, label));
  for (const [k, label] of main) nav.append(mk(k, SHORT[k] || label, TAB_ICONS[k], S.tab === k, () => { S.more = false; go(k); }, k === 'mis' ? unreadCount() : k === 'chat' ? chatUnread() : 0));
  if (more.length) {
    const inMore = more.some(([k]) => k === S.tab);
    nav.append(mk('more', 'Más', 'grid', inMore || S.more, () => { S.more = !S.more; renderBottomNav(); }));
    sheet.hidden = !S.more;
    if (S.more) {
      sheet.append(h('div', { class: 'sheet-bg', onclick: () => { S.more = false; renderBottomNav(); } }),
        h('div', { class: 'sheet-list', role: 'dialog', 'aria-label': 'Más secciones' }, more.map(([k, label]) => h('button', { class: 'sheet-item' + (S.tab === k ? ' on' : ''), onclick: () => { S.more = false; go(k); } }, icon(TAB_ICONS[k]), label))));
    }
  } else sheet.hidden = true;
}
function go(k) {
  S.tab = k; renderAll(); window.scrollTo(0, 0);
  if (!REDUCE()) { document.querySelectorAll('#bnav .bn.on .bn-ico, #tabs .tab.on .ico').forEach((ic) => { ic.classList.remove('bump'); void ic.offsetWidth; ic.classList.add('bump'); }); }
  const v = views[k];
  if (v && v.el && !v.el.hidden) { v.el.classList.remove('enter'); void v.el.offsetWidth; v.el.classList.add('enter'); }
}

/* ---------- piezas reutilizables ---------- */
const tierPill = (s) => {
  if (!s.subId) return h('span', { class: 'pill bad' }, 'Sin cubrir');
  return h('span', { class: 'pill tier t' + (s.tier || 1) }, TIER_NAMES[s.tier] || 'Manual');
};
function cellState(T, wd, slot) {
  if (!T) return '';
  if (slot === 'R') return onPatio(patioForDate(S.patios[S.date.slice(0, 7)], S.date), wd, T.id) ? 'patio' : 'libre';
  const c = cellOf(T, wd, slot);
  if (!c || c.t === 'n') return 'no está';
  if (c.t === 'l') return 'hora libre';
  if (c.t === 'a') return 'apoyo' + (c.g ? ' ' + c.g : '');
  if (c.t === 'o') return 'coordinación';
  if (c.t === 's') return 'desdoble' + (c.g ? ' ' + c.g : '');
  return (isSpecial(T.role) ? 'sesión ' + ROLES[T.role] : 'en clase') + (c.g ? ' ' + c.g : '');
}
const ICONS = {
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  home: '<path d="m3 11 9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  school: '<path d="m2 9 10-6 10 6-10 6z"/><path d="M6 11.5V17c0 1 3 3 6 3s6-2 6-3v-5.5"/>',
  chevl: '<path d="m15 18-6-6 6-6"/>', chevr: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'
};
function icon(name, cls) {
  const sp = h('span', { class: 'ico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
  sp.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.info) + '</svg>';
  return sp;
}
function initials(name) {
  const w = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0] || '?')[0] + (w.length > 1 ? w[1][0] : '')).toUpperCase();
}
// Profesorado con foto (archivos en /avatars/<id>.jpg). Si falla la carga se muestran las iniciales.
const FOTOS = new Set(['pablo','jesus-canedo','carmen-gordillo','jorge','ana-hernandez','carmen','victoria','gema','andrea','conchi','mar','eli','belen','pilar','natalia','miriam-f','ana-torres','noelia','juanfran','sonia','virginia-amor','miriam-del-castillo','alba','miriam-vela','merche','susana-ruiz','rebeca','ricardo']);
const FOTOS_V = 22;
function avatar(id, size, jefe) {
  const T = tById(id), name = jefe ? 'Jefatura' : (T ? T.name : '?');
  let n = 0; for (const ch of String(jefe ? 'jefe' : id)) n = (n * 31 + ch.charCodeAt(0)) % 997;
  const foto = !jefe && FOTOS.has(id);
  const el = h('span', { class: 'av av' + (jefe ? 'J' : n % 6) + (size ? ' ' + size : '') + (foto ? ' foto' : ''), 'aria-hidden': 'true', title: name }, jefe ? 'JE' : initials(name));
  if (foto) { const im = h('img', { src: '/avatars/' + id + '.jpg?v=' + FOTOS_V, alt: '', loading: 'lazy', decoding: 'async' }); im.onerror = () => { im.remove(); el.classList.remove('foto'); }; el.append(im); }
  return el;
}
document.documentElement.lang = 'es';
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.more) { S.more = false; renderBottomNav(); const b = document.querySelector('#bnav .bn:last-child'); if (b) b.focus(); } });
function doPrint() {
  try { window.print(); } catch (e) { toast('No se pudo abrir la impresión. Usa Ctrl+P o el menú Compartir/Imprimir del navegador.', true); }
}
const QR_PNG = 'data:image/png;base64,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';
function printPw(users) {
  const ok = users.filter((u) => u.password);
  if (!ok.length) return toast('No hay contraseñas que imprimir.', true);
  const url = location.origin;
  const box = h('div', { id: 'pwprint' },
    h('h1', null, 'Sustituciones · CEIP Gabriel Celaya'),
    h('p', null, 'Tarjetas de acceso. Recorta cada una y entrégala a su destinatario. No compartas tu contraseña.'),
    h('div', { class: 'slips' }, ok.map((u) => h('div', { class: 'slip' },
      h('img', { src: QR_PNG, alt: 'QR de acceso a la app', class: 'qr' }),
      h('b', null, 'Acceso a la app de sustituciones'),
      h('div', null, 'Dirección: ', h('b', null, url.replace(/^https?:\/\//, ''))),
      h('div', null, 'Correo: ', h('b', null, u.email)),
      h('div', null, 'Contraseña: ', h('b', { class: 'pw' }, u.password))))));
  document.body.append(box); document.body.classList.add('print-pw');
  const done = () => { document.body.classList.remove('print-pw'); box.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  const imgs = [...box.querySelectorAll('img')];
  Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))).then(() => setTimeout(doPrint, 100));
}
const printBtn = (label) => h('button', { class: 'btn ghost no-print', onclick: doPrint }, icon('print'), label || 'Imprimir');
window.addEventListener('beforeprint', () => { const f = document.getElementById('pfoot'); if (f) f.textContent = 'CEIP Gabriel Celaya · Impreso el ' + new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }); });
function empty(title, body, action, ico) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(ico || 'info')), h('h3', null, title), body ? h('p', { class: 'muted' }, body) : null, action || null);
}
function skeleton() {
  return h('div', { class: 'skel', 'aria-busy': 'true', 'aria-label': 'Cargando' },
    h('div', { class: 'skel-line w40 big' }),
    h('div', { class: 'skel-stats' }, [1, 2, 3, 4].map(() => h('div', { class: 'skel-box' }))),
    h('div', { class: 'skel-card' }, h('div', { class: 'skel-line w30' }), h('div', { class: 'skel-line' }), h('div', { class: 'skel-line w80' }), h('div', { class: 'skel-line w60' })),
    h('div', { class: 'skel-card' }, h('div', { class: 'skel-line w30' }), h('div', { class: 'skel-line' }), h('div', { class: 'skel-line w70' })));
}

/* =====================================================  SALUDO Y SERPENTINAS  */
const SALUDO = "¡¡¡Buenos días profe!!!";
const FRASES = [["El único modo de hacer un gran trabajo es amar lo que haces.","Steve Jobs",0],["La educación es el arma más poderosa que puedes usar para cambiar el mundo.","Nelson Mandela",0],["Caminante, no hay camino, se hace camino al andar.","Antonio Machado",0],["El que tiene un porqué para vivir puede soportar casi cualquier cómo.","Friedrich Nietzsche",0],["Un viaje de mil millas comienza con un solo paso.","Lao Tse",0],["Todo parece imposible hasta que se hace.","Nelson Mandela",0],["La educación no cambia el mundo, cambia a las personas que van a cambiar el mundo.","Paulo Freire",0],["Un buen maestro puede inspirar esperanza, encender la imaginación e infundir amor por el aprendizaje.","Brad Henry",0],["El éxito es la suma de pequeños esfuerzos repetidos día tras día.","Robert Collier",0],["La mejor manera de predecir el futuro es crearlo.","Peter Drucker",1],["Lo que haces hoy puede mejorar todos tus mañanas.","Ralph Marston",0],["Un día sin sonreír es un día perdido.","Charles Chaplin",1],["La vida es un 10 % lo que me sucede y un 90 % cómo reacciono ante ello.","Charles Swindoll",0],["Nada grande se ha hecho en el mundo sin pasión.","Georg W. F. Hegel",0],["No hay viento favorable para quien no sabe adónde va.","Séneca",0],["Somos lo que hacemos repetidamente. La excelencia no es un acto, sino un hábito.","Will Durant",0],["La imaginación es más importante que el conocimiento.","Albert Einstein",0],["La vida es como montar en bicicleta: para mantener el equilibrio, hay que seguir avanzando.","Albert Einstein",0],["Haz de cada día tu obra maestra.","John Wooden",0],["El optimismo es la fe que conduce al logro.","Helen Keller",0],["Lo único que debemos temer es al propio miedo.","Franklin D. Roosevelt",0],["Vivir es lo más raro del mundo. La mayoría de la gente existe, eso es todo.","Oscar Wilde",0],["La sonrisa cuesta menos que la electricidad y da más luz.","Proverbio escocés",0],["Educar la mente sin educar el corazón no es educación en absoluto.","Aristóteles",1],["El fracaso es la oportunidad de comenzar de nuevo con más inteligencia.","Henry Ford",1],["Cae siete veces, levántate ocho.","Proverbio japonés",0],["Cada mañana nacemos de nuevo. Lo que hacemos hoy es lo que más importa.","Buda",1],["Un maestro afecta a la eternidad; nunca puede saber dónde termina su influencia.","Henry Adams",0],["El secreto para salir adelante es comenzar.","Mark Twain",1],["Haz lo que puedas, con lo que tengas, donde estés.","Theodore Roosevelt",0],["Nunca dejes que lo que no puedes hacer interfiera con lo que sí puedes hacer.","John Wooden",0],["Haz lo mejor que puedas hasta que sepas más. Cuando sepas más, hazlo mejor.","Maya Angelou",0],["Quien lee mucho y anda mucho, ve mucho y sabe mucho.","Miguel de Cervantes",0],["La paciencia todo lo alcanza.","Santa Teresa de Jesús",0],["Lo esencial es invisible a los ojos.","Antoine de Saint-Exupéry",0],["Aprender sin pensar es inútil; pensar sin aprender, peligroso.","Confucio",0],["No importa lo despacio que vayas, siempre que no te detengas.","Confucio",1],["El mejor momento para plantar un árbol fue hace veinte años. El segundo mejor momento es ahora.","Proverbio chino",0],["Tu tiempo es limitado, no lo malgastes viviendo la vida de otro.","Steve Jobs",0],["El talento gana partidos, pero el trabajo en equipo gana campeonatos.","Michael Jordan",0],["No puedes cruzar el mar simplemente mirando el agua.","Rabindranath Tagore",0],["El futuro pertenece a quienes creen en la belleza de sus sueños.","Eleanor Roosevelt",1],["Si no puedes volar, corre; si no puedes correr, camina; pero sigue avanzando.","Martin Luther King Jr.",0],["La inspiración existe, pero tiene que encontrarte trabajando.","Pablo Picasso",1],["¡Qué maravilloso es que nadie necesite esperar un solo momento para empezar a mejorar el mundo!","Anne Frank",0],["Es más fácil construir niños fuertes que reparar adultos rotos.","Frederick Douglass",1],["Enseñar no es transferir conocimiento, sino crear las posibilidades para su producción.","Paulo Freire",0],["La alegría está en la lucha y el esfuerzo, no en la victoria misma.","Mahatma Gandhi",1],["Lo que con mucho trabajo se adquiere, más se ama.","Aristóteles",0],["Hoy es un buen día para empezar.","Walt Disney",1],["La alegría de ver y entender es el más perfecto don de la naturaleza.","Albert Einstein",0],["El arte supremo del maestro es despertar el placer de la expresión creativa y del conocimiento.","Albert Einstein",0],["Dime y lo olvido, enséñame y lo recuerdo, involúcrame y lo aprendo.","Benjamin Franklin",1],["Enseñar es recordar a otros que saben tan bien como tú.","Richard Bach",0],["La enseñanza que deja huella no es la que va de cabeza a cabeza, sino de corazón a corazón.","Howard Hendricks",0],["Lo que se les da a los niños, los niños darán a la sociedad.","Karl A. Menninger",0],["Hay un solo bien, el saber, y un solo mal, la ignorancia.","Sócrates",0],["La felicidad no es algo hecho. Viene de tus propias acciones.","Dalai Lama",0],["Sé el cambio que quieres ver en el mundo.","Mahatma Gandhi",1],["Nuestra mayor gloria no está en no caer nunca, sino en levantarnos cada vez que caemos.","Confucio",1],["La gente olvidará lo que dijiste, pero nunca cómo les hiciste sentir.","Maya Angelou",1],["Da siempre lo mejor de ti. Lo que plantes ahora, lo cosecharás más tarde.","Og Mandino",0],["Pensar es el trabajo más difícil que existe; quizá por eso son pocos los que lo practican.","Henry Ford",0],["No es que tengamos poco tiempo, sino que perdemos mucho.","Séneca",0],["Cuando cambias la forma de mirar las cosas, las cosas que miras cambian.","Wayne Dyer",0],["Si quieres ir rápido, ve solo; si quieres llegar lejos, ve acompañado.","Proverbio africano",0],["Lo que sabemos es una gota de agua; lo que ignoramos es el océano.","Isaac Newton",0],["Vive como si fueras a morir mañana. Aprende como si fueras a vivir siempre.","Mahatma Gandhi",1],["El que no sabe lo que busca no entiende lo que encuentra.","Claude Bernard",0],["El asombro es el principio de la sabiduría.","Sócrates",0],["Juntarse es un comienzo, mantenerse juntos es un progreso, trabajar juntos es un éxito.","Henry Ford",0],["La gota horada la piedra no por su fuerza, sino por su constancia.","Ovidio",0],["Mientras enseñamos, aprendemos.","Séneca",0],["El verdadero viaje de descubrimiento no consiste en buscar nuevas tierras, sino en mirar con nuevos ojos.","Marcel Proust",0],["Yo soy yo y mi circunstancia.","José Ortega y Gasset",0],["Hay quienes luchan toda la vida: esos son los imprescindibles.","Bertolt Brecht",0],["Hoy es siempre todavía.","Antonio Machado",0],["La infancia es el reino donde nadie muere.","Edna St. Vincent Millay",0],["Todo lo que una persona pueda imaginar, otras podrán hacerlo realidad.","Julio Verne",1],["Educar es lo mismo que poner motor a una barca.","Gabriel Celaya",0]]; // [frase, autor, atribuida]
function fraseDelDia(d = new Date()) {
  const n = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return FRASES[((n % FRASES.length) + FRASES.length) % FRASES.length];
}
/* ---------- música de bienvenida ---------- */
const MUS = { a: null, tried: false };
const musOff = () => { try { return localStorage.getItem('celaya_musica') === 'off'; } catch (e) { return false; } };
function musAudio() {
  if (!MUS.a) { MUS.a = new Audio('/sonido/energia-matutina.mp3'); MUS.a.preload = 'auto'; MUS.a.volume = 0.6; MUS.a.addEventListener('ended', syncMusicBtn); }
  return MUS.a;
}
function musicBtn() {
  const b = h('button', { class: 'btn ghost sm snd no-print', id: 'snd', type: 'button', onclick: toggleMusic });
  MUS.btn = b; syncMusicBtn(); return b;
}
function syncMusicBtn() {
  const b = MUS.btn; if (!b) return;
  const on = !musOff() && MUS.a && !MUS.a.paused && !MUS.a.ended;
  const off = musOff();
  b.textContent = ''; b.append(icon(on ? 'sound' : 'mute'));
  b.setAttribute('aria-label', off ? 'Activar la música de bienvenida' : on ? 'Parar la música' : 'Música de bienvenida');
  b.title = off ? 'Música desactivada · pulsa para activarla' : on ? 'Parar la música (y no volver a ponerla)' : 'Activar la música';
}
function toggleMusic() {
  const a = musAudio();
  if (!musOff() && !a.paused) { try { localStorage.setItem('celaya_musica', 'off'); } catch (e) {} a.pause(); }
  else { try { localStorage.removeItem('celaya_musica'); } catch (e) {} a.currentTime = 0; a.play().catch(() => {}); }
  syncMusicBtn();
}
function startMusic() {
  if (MUS.tried || musOff()) return; MUS.tried = true;
  const a = musAudio();
  const go = () => { if (musOff()) return; a.play().then(syncMusicBtn).catch(() => {}); };
  a.addEventListener('play', syncMusicBtn); a.addEventListener('pause', syncMusicBtn);
  a.play().then(syncMusicBtn).catch(() => {
    // el navegador exige un gesto del usuario: suena con el primer toque
    const once = () => { removeEventListener('pointerdown', once, true); removeEventListener('keydown', once, true); go(); };
    addEventListener('pointerdown', once, true); addEventListener('keydown', once, true);
  });
}
/* ---------- animaciones suaves ---------- */
const REDUCE = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function countUp(root, key) {
  // los contadores suben de 0 al valor solo cuando cambian (no en cada refresco de datos)
  const vals = [...root.querySelectorAll('.stat b')];
  const sig = key + '|' + vals.map((b) => b.textContent).join(',');
  if (S._statSig === sig || REDUCE()) { S._statSig = sig; return; }
  S._statSig = sig;
  vals.forEach((b) => {
    const n = parseInt(b.textContent, 10); if (!(n > 0)) return;
    const t0 = performance.now(), dur = 650;
    const tick = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); b.textContent = Math.round(n * e); if (k < 1) requestAnimationFrame(tick); else b.textContent = n; };
    b.textContent = 0; requestAnimationFrame(tick);
  });
}
/* ---------- "Hoy te toca a ti" ---------- */
function miDia(date) {
  if (!S.me || !tById(S.me) || !weekdayKey(date) || !S.loaded.school) return null;
  const wd = weekdayKey(date), today = todayStr(), isToday = date === today;
  const day = S.days[date] || { absences: [], subs: [] };
  const mine = (day.subs || []).filter((x) => x.subId === S.me).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  const patio = onPatio(patioForDate(S.patios[date.slice(0, 7)], date), wd, S.me);
  const absent = (day.absences || []).some((a) => a.tid === S.me);
  const sm = strikeIds(date).length && smFor(date).includes(S.me);
  const first = tName(S.me).split(' ')[0];
  const when = isToday ? 'Hoy' : 'Ese día';
  let title, sub, cls = 'calm';
  if (mine.length) { title = when + ' tienes ' + mine.length + (mine.length === 1 ? ' sustitución' : ' sustituciones'); cls = 'busy'; }
  else if (patio) { title = when + ' te toca patio'; cls = 'busy'; }
  else if (absent) { title = when + ' faltas tú'; sub = 'Que todo vaya bien. Tus clases ya están cubiertas o en marcha.'; }
  else { title = isToday ? 'Día tranquilo' : 'Ese día vas tranquilo/a'; sub = 'No tienes sustituciones ni patio ' + (isToday ? 'hoy.' : 'ese día.'); }
  const items = h('div', { class: 'md-items' });
  for (const m of mine) {
    const nota = ([...S.notifs, ...S.dayNotifs].find((n) => n.key === m.key && n.to === S.me && n.kind === 'asigna') || {}).nota;
    items.append(h('div', { class: 'md-it' }, h('b', { class: 'md-time' }, sessTime(m.slot).split('–')[0]),
      h('span', null, h('b', null, (m.slot === 'R' ? 'Recreo' : m.slot + 'ª hora') + ' · '), 'cubres a ' + tName(m.absentId) + ' · ' + placeTxt(m), nota ? h('span', { class: 'small muted' }, ' · Nota: ' + nota) : null)));
  }
  if (patio) items.append(h('div', { class: 'md-it' }, h('b', { class: 'md-time' }, sessTime('R').split('–')[0]), h('span', null, h('b', null, 'Patio'), ' · recreo ' + sessTime('R'))));
  if (sm) items.append(h('div', { class: 'md-it' }, h('b', { class: 'md-time' }, '—'), h('span', null, h('b', null, 'Servicios mínimos'), ' ese día')));
  // «Enterado»: confirma desde aquí los avisos de sustitución de ese día (y desaparecen también de la pestaña Avisos)
  const pend = S.notifs.filter((n) => n.date === date && !n.read && (n.kind === 'asigna' || n.kind === 'cancela'));
  const cancelled = pend.filter((n) => n.kind === 'cancela').length;
  let ack = null;
  if (pend.length) ack = h('div', { class: 'md-ack' },
    cancelled ? h('p', { class: 'small md-cancel' }, cancelled === 1 ? 'Se te ha quitado una sustitución.' : 'Se te han quitado ' + cancelled + ' sustituciones.') : null,
    h('button', { class: 'btn primary md-ack-btn', onclick: () => { pend.forEach((n) => Mis.read(n)); } }, icon('check'), 'Enterado'));
  else if (mine.length && [...S.notifs].some((n) => n.date === date && n.kind === 'asigna')) ack = h('div', { class: 'md-ack done' }, h('span', { class: 'ent ok' }, '✓ Enterado'));
  const mk = date + '|' + title + '|' + items.children.length, pop = S._mdKey !== mk; S._mdKey = mk;
  return h('div', { class: 'card mydia ' + cls + ' no-print' + (pop && !REDUCE() ? ' pop' : '') },
    avatar(S.me, 'xl'),
    h('div', { class: 'md-body' }, h('p', { class: 'md-hi' }, 'Hola, ' + first), h('h2', { class: 'md-title' }, title), sub ? h('p', { class: 'muted md-sub' }, sub) : null, items.children.length ? items : null, ack));
}
function greeting() {
  const [txt, autor, atr] = fraseDelDia();
  const el = h('div', { class: 'greet no-print' },
    h('h2', { class: 'greet-hi' }, SALUDO),
    h('blockquote', { class: 'greet-q' }, h('p', null, '“' + txt + '”'), h('footer', null, '— ' + (atr ? 'Atribuida a ' : '') + autor)));
  if (!S.serpentinas) { S.serpentinas = true; setTimeout(serpentinas, 400); startMusic(); }
  return el;
}
function serpentinas() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9998';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d'); if (!ctx) return cv.remove();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
  const cols = ['#BF1D29', '#E8A9AE', '#1B1416', '#F4C7CB', '#FFFFFF', '#D9434E'];
  const mob = innerWidth < 600, N = mob ? 46 : 80;
  const ps = Array.from({ length: N }, (_, i) => {
    const ribbon = i % 3 !== 0;
    return { ribbon, x: Math.random() * W, y: -Math.random() * H * 0.5 - 20 * dpr, vx: (Math.random() - 0.5) * 1.6 * dpr, vy: (1.6 + Math.random() * 2.6) * dpr,
      ph: Math.random() * 6.28, sp: 0.06 + Math.random() * 0.08, len: (36 + Math.random() * 46) * dpr, amp: (5 + Math.random() * 6) * dpr, w: (2 + Math.random() * 2) * dpr,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.12, c: cols[Math.floor(Math.random() * cols.length)] };
  });
  const T0 = performance.now(), DUR = 4200;
  (function frame(t) {
    const e = t - T0; ctx.clearRect(0, 0, W, H);
    const fade = e > DUR - 900 ? Math.max(0, (DUR - e) / 900) : 1;
    ctx.globalAlpha = fade;
    for (const p of ps) {
      p.x += p.vx + Math.sin(p.ph) * 0.6 * dpr; p.y += p.vy; p.ph += p.sp; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (p.ribbon) {
        ctx.strokeStyle = p.c; ctx.lineWidth = p.w; ctx.lineCap = 'round'; ctx.beginPath();
        for (let k = 0; k <= 10; k++) { const yy = (k / 10) * p.len, xx = Math.sin(p.ph + k * 0.7) * p.amp; k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
        ctx.stroke();
      } else { ctx.fillStyle = p.c; ctx.fillRect(-p.w, -p.w, p.w * 2.2, p.w * 1.4); }
      ctx.restore();
    }
    if (e < DUR) requestAnimationFrame(frame); else cv.remove();
  })(T0);
}

/* =====================================================  HOY  */

/* ---------- Excursiones / salidas complementarias ---------- */
// franjas que hay que cubrir: todas, salvo las clases que un tutor da a su propio grupo (ese grupo también va a la excursión)
function excSlots(date, tid) {
  const T = tById(tid), wd = weekdayKey(date), g = homeGroup(T);
  return SLOT_ORDER.filter((sl) => { if (sl === 'R' || !g) return true; const c = cellOf(T, wd, sl); return !(c && c.t === 'c' && c.g === g); });
}
function excImpact(date, e) {
  // tutores cuyos cursos se quedan sin un profesor que se va de excursión: { tutorId: [{ who, g, slots }] }
  const wd = weekdayKey(date), res = {};
  if (!wd) return res;
  const tutorsOf = (g) => {
    const own = S.school.teachers.filter((T) => homeGroup(T) === g).map((T) => T.id);
    if (own.length) return own;
    const cnt = {};
    for (const T of S.school.teachers) for (const k in T.sched || {}) { const c = T.sched[k]; if (T.role === 'tutor' && c && c.t === 'c' && c.g === g) cnt[T.id] = (cnt[T.id] || 0) + 1; }
    const mx = Math.max(0, ...Object.values(cnt)); return Object.keys(cnt).filter((id) => cnt[id] === mx);
  };
  for (const tid of e.tids || []) {
    const T = tById(tid); if (!T) continue;
    const by = {};
    for (const sl of ['1', '2', '3', '4', '5', '6']) {
      const c = cellOf(T, wd, sl);
      if (!(c && c.t === 'c' && c.g)) continue;
      for (const tu of tutorsOf(c.g)) { if ((e.tids || []).includes(tu) || tu === tid) continue; const k = tu + '|' + c.g; (by[k] = by[k] || { tu, g: c.g, slots: [] }).slots.push(sl); }
    }
    for (const k in by) (res[by[k].tu] = res[by[k].tu] || []).push({ who: tid, g: by[k].g, slots: by[k].slots });
  }
  return res;
}
const horasTxt = (sl) => sl.map((x) => x + 'ª').join(', ') + (sl.length === 1 ? ' hora' : ' horas');
function excTexto(date, e, tid) {
  const when = date === todayStr() ? 'Hoy' : fmtShort(date);
  const lugar = e.title ? ' (' + e.title + ')' : '';
  if ((e.tids || []).includes(tid)) return when + ' tienes salida complementaria fuera del centro' + lugar + '.';
  const imp = (excImpact(date, e)[tid] || []);
  const quien = imp.map((i) => tName(i.who));
  const nombres = quien.length ? [...new Set(quien)] : (e.tids || []).map(tName);
  const lista = nombres.join(' y ');
  const gr = imp.map((i) => 'Tu grupo ' + i.g + ' se queda sin ' + tName(i.who).split(' ')[0] + ' en ' + horasTxt(i.slots) + '.').join(' ');
  return when + ' ' + lista + ' tiene' + (nombres.length > 1 ? 'n' : '') + ' salida complementaria fuera del centro' + lugar + '. ' + gr;
}
function excCards(date) {
  const day = S.days[date], list = (day && day.exc) || [];
  if (!list.length || !S.loaded.school) return null;
  const when = date === todayStr() ? 'Hoy' : fmtShort(date);
  return h('div', { class: 'exc-wrap no-print' }, list.map((e) => {
    const imp = S.me ? (excImpact(date, e)[S.me] || []) : [];
    const mine = S.me && (e.tids || []).includes(S.me);
    return h('div', { class: 'card exc' + (imp.length || mine ? ' mine' : '') },
      h('div', { class: 'exc-head' }, icon('pin'), h('b', null, 'Excursión' + (e.title ? ' · ' + e.title : '')), h('span', { class: 'muted small' }, when)),
      h('p', { class: 'small' }, 'Van: ', h('b', null, (e.tids || []).map(tName).join(', ') || '—'), '.'),
      imp.length || mine ? h('p', { class: 'exc-me' }, excTexto(date, e, S.me)) : null);
  }));
}
async function exNotify(date, e, cancel) {
  const out = [], ids = new Set(e.tids || []), imp = excImpact(date, e);
  Object.keys(imp).forEach((t) => ids.add(t));
  for (const to of ids) {
    const text = cancel ? 'Se ha cancelado la salida complementaria' + (e.title ? ' (' + e.title + ')' : '') + ' del ' + fmtShort(date) + '.' : excTexto(date, e, to);
    out.push({ to, date, kind: 'exc', text, ts: Date.now(), read: false });
  }
  for (const n of out) await S.db.collection('notifs').add(n);
  if (window.pushNotify && out.length) window.pushNotify(out).catch(() => {});
  return out.length;
}
function addExcursion(date, title, tids) {
  return enqueue(async () => {
    const old = S.days[date] ? JSON.parse(JSON.stringify(S.days[date])) : null;
    const day = cloneDay(date);
    const e = { id: rid(), title, tids };
    day.exc = [...(day.exc || []), e];
    for (const tid of tids) {
      const ex = day.absences.find((a) => a.tid === tid);
      if (ex) ex.slots = [...new Set([...ex.slots, ...excSlots(date, tid)])];
      else day.absences.push({ id: rid(), tid, slots: excSlots(date, tid), nota: '', exc: e.id });
    }
    day.subs = assign(day, date, { ...ctxFor(date), strike: strikeIds(date).slice() }, false);
    await saveDay(date, day, old);
    const n = await exNotify(date, e, false);
    toast('Excursión guardada · ' + plural(n, 'aviso enviado', 'avisos enviados') + (day.subs.filter((s) => !s.subId).length ? ' · hay franjas sin cubrir' : ''));
  });
}
function removeExcursion(date, id) {
  return enqueue(async () => {
    const old = JSON.parse(JSON.stringify(S.days[date]));
    const day = cloneDay(date);
    const e = (day.exc || []).find((x) => x.id === id); if (!e) return;
    const imp = excImpact(date, e);
    day.exc = day.exc.filter((x) => x.id !== id);
    day.absences = day.absences.filter((a) => a.exc !== id);
    const strike = strikeIds(date).filter((i) => day.absences.some((a) => a.id === i));
    day.subs = assign({ ...day, subs: day.subs.filter((s) => day.absences.some((a) => a.id === s.absId)) }, date, { ...ctxFor(date), strike }, false);
    if (strike.length !== strikeIds(date).length) await savePriv(date, strike);
    await saveDay(date, day, old);
    await exNotify(date, e, true);
    toast('Excursión cancelada y avisos enviados');
  });
}
const Exc = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { this.sel = new Set(); this.date = todayStr(); $('#main').append(this.el); },
  render() {
    const el = this.el; el.textContent = '';
    if (!S.school.teachers.length) return el.append(empty('No hay profesorado cargado', 'Importa antes los horarios en la pestaña Profesorado.', null, 'users'));
    const title = h('input', { type: 'text', id: 'exc-lugar', placeholder: 'Lugar o nombre de la salida (opcional)', maxlength: 80, value: this._title || '', oninput: (e) => { this._title = e.target.value; } });
    const dateIn = h('input', { type: 'date', id: 'exc-fecha', value: this.date, onchange: (e) => { if (e.target.value) { this.date = e.target.value; this.render(); } } });
    const chips = h('div', { class: 'chips picker' }, sortedTeachers().map((t) => h('button', { type: 'button', class: 'chip pick' + (this.sel.has(t.id) ? ' on' : ''), 'aria-pressed': this.sel.has(t.id) ? 'true' : 'false', onclick: () => { this.sel.has(t.id) ? this.sel.delete(t.id) : this.sel.add(t.id); this.render(); } }, avatar(t.id, 'sm'), t.name)));
    const go = () => {
      if (!this.sel.size) return toast('Elige al menos un profesor.', true);
      if (!weekdayKey(this.date)) return toast('Esa fecha es fin de semana.', true);
      const tids = [...this.sel], t = (this._title || '').trim();
      this.sel = new Set(); this._title = '';
      addExcursion(this.date, t, tids);
    };
    el.append(h('h2', { class: 'cap' }, 'Excursiones y salidas'),
      h('p', { class: 'muted small' }, 'Marca quién sale. La app trata sus clases como una ausencia (busca sustitutos con las reglas de siempre, salvo PT y AL, que no se sustituyen, y las clases que un tutor da a su propio grupo, que también sale), avisa a todo el profesorado en su Panel y manda un aviso a los tutores de los cursos que se quedan sin ese profesor.'),
      h('div', { class: 'card' }, h('h3', null, 'Nueva excursión'),
        h('div', { class: 'field' }, h('span', null, 'Fecha'), dateIn), h('div', { class: 'field' }, h('span', null, 'Lugar'), title),
        h('div', { class: 'field' }, h('span', null, 'Profesores que van (' + this.sel.size + ')'), chips),
        h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: go }, icon('plus'), 'Guardar y avisar'))));
    const today = todayStr(), all = [];
    for (const d in S.days) for (const e of S.days[d].exc || []) all.push({ d, e });
    const up = all.filter((x) => x.d >= today).sort((a, b) => a.d.localeCompare(b.d)), past = all.filter((x) => x.d < today).sort((a, b) => b.d.localeCompare(a.d)).slice(0, 8);
    const row = ({ d, e }) => h('div', { class: 'exc-row' }, h('div', null, h('b', null, fmtDate(d) + (e.title ? ' · ' + e.title : '')), h('div', { class: 'small muted' }, (e.tids || []).map(tName).join(', '))),
      d >= today ? h('button', { class: 'btn ghost sm', onclick: () => { if (confirm('¿Cancelar esta excursión? Se quitan las ausencias y se avisa de la cancelación.')) removeExcursion(d, e.id); } }, 'Cancelar') : null);
    el.append(h('div', { class: 'card' }, h('h3', null, 'Próximas'), up.length ? up.map(row) : h('p', { class: 'muted' }, 'No hay excursiones previstas.')));
    if (past.length) el.append(h('details', { class: 'card' }, h('summary', null, 'Anteriores'), past.map(row)));
  }
};
views.exc = Exc;
const Hoy = {
  el: h('section', { class: 'view', hidden: true }), built: false,
  build() {
    const el = this.el;
    this.dateIn = h('input', { type: 'date', id: 'hoy-fecha', 'aria-label': 'Fecha', value: S.date, onchange: (e) => { if (e.target.value) { S.date = e.target.value; subscribeDayNotifs(); refresh(Hoy); } } });
    const step = (n) => () => { S.date = addDays(S.date, n); this.dateIn.value = S.date; subscribeDayNotifs(); refresh(Hoy); };
    this.dateLabel = h('p', { class: 'date-label' });
    el.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost', 'aria-label': 'Día anterior', onclick: step(-1) }, icon('chevl')),
        this.dateIn,
        h('button', { class: 'btn ghost', 'aria-label': 'Día siguiente', onclick: step(1) }, icon('chevr')),
        h('button', { class: 'btn ghost', onclick: () => { S.date = todayStr(); this.dateIn.value = S.date; subscribeDayNotifs(); refresh(Hoy); } }, 'Hoy')),
      this.dateLabel,
      (this.mine = h('div', { class: 'mydia-wrap' })),
      greeting(),
      (this.banner = h('div', { class: 'banners' })),
      (this.summary = h('div', { class: 'summary' })),
      (this.timeline = h('div', { class: 'card timeline-card' }))
    );
    // formulario
    this.selT = h('select', { id: 'abs-prof', required: true });
    this.all = h('input', { type: 'checkbox', id: 'abs-todo', checked: true, onchange: () => this.syncSlots() });
    this.slotBox = h('div', { class: 'slotbox' });
    this.motivo = h('select', { id: 'abs-motivo' }, h('option', { value: 'falta' }, 'Falta normal'), h('option', { value: 'huelga' }, 'Huelga'));
    this.hasta = h('input', { type: 'date', id: 'abs-hasta' });
    this.nota = h('textarea', { id: 'abs-nota', rows: 2, placeholder: 'Opcional: tareas dejadas, material, dónde está el libro…' });
    for (const s of SLOT_ORDER) {
      this.slotBox.append(h('label', { class: 'chk slot' }, h('input', { type: 'checkbox', 'data-slot': s, checked: true, disabled: true }), h('span', null, s === 'R' ? 'Recreo' : s + 'ª')));
    }
    this.form = h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); this.submit(); } },
      h('h2', null, 'Registrar ausencia'),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Profesor/a que falta'), this.selT),
        h('div', { class: 'field' }, h('span', null, 'Franjas'),
          h('label', { class: 'chk' }, this.all, h('span', null, 'Todo el día')), this.slotBox)),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'Motivo'), this.motivo),
        h('label', { class: 'field' }, h('span', null, 'Hasta el (si falta varios días)'), this.hasta)),
      h('label', { class: 'field' }, h('span', null, 'Nota para quien sustituya'), this.nota),
      h('div', { class: 'row-end' }, h('button', { class: 'btn primary', type: 'submit' }, icon('send'), 'Registrar y avisar'))
    );
    this.absWrap = h('div', { class: 'card' });
    this.subWrap = h('div', { class: 'card' });
    el.append(this.form, this.absWrap, this.subWrap);
    $('#main').append(el);
  },
  syncSlots() {
    const all = this.all.checked;
    this.slotBox.querySelectorAll('input').forEach((i) => { i.disabled = all; if (all) i.checked = true; });
  },
  submit() {
    const tid = this.selT.value;
    if (!tid) return toast('Elige a quién falta.', true);
    const slots = this.all.checked ? [...SLOT_ORDER] : [...this.slotBox.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.dataset.slot);
    if (!slots.length) return toast('Marca al menos una franja.', true);
    if (!weekdayKey(S.date)) return toast('Esa fecha cae en fin de semana.', true);
    const hasta = this.hasta.value;
    if (hasta && hasta < S.date) return toast('La fecha final no puede ser anterior a la inicial.', true);
    if (hasta && hasta > S.date) addAbsenceRange(S.date, hasta, tid, slots, this.nota.value.trim(), this.motivo.value);
    else addAbsence(S.date, tid, slots, this.nota.value.trim(), this.motivo.value);
    this.hasta.value = '';
    this.nota.value = '';
    this.selT.value = '';
  },
  render() {
    subscribeDayNotifs();
    const date = S.date, wd = weekdayKey(date);
    this.dateIn.value = date;
    this.dateLabel.textContent = fmtDate(date) + (date === todayStr() ? ' · hoy' : '');
    this.mine.textContent = ''; { const md = miDia(date); if (md) this.mine.append(md); const ex = excCards(date); if (ex) this.mine.append(ex); }
    const prev = this.selT.value;
    this.selT.textContent = '';
    this.selT.append(h('option', { value: '' }, '— Elegir —'), sortedTeachers().map((t) => h('option', { value: t.id }, t.name + ' · ' + ROLES[t.role])));
    this.selT.value = prev;

    const day = S.days[date] || { absences: [], subs: [] };
    // avisos
    this.banner.textContent = '';
    if (!S.loaded.school) this.banner.append(h('p', { class: 'note' }, 'Cargando datos del centro…'));
    else if (!S.school.teachers.length) this.banner.append(h('p', { class: 'note warn' }, 'Aún no hay profesorado. Ve a la pestaña Profesorado para importar los horarios, o a Centro para cargar datos de ejemplo.'));
    if (!wd) this.banner.append(h('p', { class: 'note warn' }, 'Esa fecha es fin de semana: no hay clase.'));
    else if (S.school.teachers.length && !(S.patios[date.slice(0, 7)])) this.banner.append(h('p', { class: 'note warn' }, 'Faltan los turnos de patio de este mes. Sin ellos no se cubren los recreos.'));
    if (strikeIds(date).some((id) => day.absences.some((a) => a.id === id))) {
      const sm = smFor(date);
      this.banner.append(h('p', { class: 'note' + (sm.length ? '' : ' warn') }, sm.length ? 'Hay huelga: solo cubren los servicios mínimos (' + sm.map(tName).join(', ') + ').' : 'Hay huelga y no has marcado servicios mínimos para este día. Márcalos en la pestaña Servicios mínimos y pulsa “Recalcular todo”.'));
    }
    if (S.school.example) this.banner.append(h('p', { class: 'note' }, 'Estás viendo datos de ejemplo. Bórralos en Centro antes de empezar.'));

    // resumen
    const sin = day.subs.filter((s) => !s.subId).length;
    this.summary.textContent = '';
    this.summary.append(
      h('div', { class: 'stat' }, h('b', null, day.absences.length), h('span', null, day.absences.length === 1 ? 'profesor/a ausente' : 'profesores ausentes')),
      h('div', { class: 'stat' }, h('b', null, day.subs.filter((s) => s.subId).length), h('span', null, 'clases cubiertas')),
      h('div', { class: 'stat' + (sin ? ' bad' : ' good') }, h('b', null, sin), h('span', null, 'sin cubrir')));
    countUp(this.summary, date);

    // línea del día
    this.timeline.textContent = '';
    this.timeline.append(h('div', { class: 'card-head' }, h('h2', null, 'La jornada, hora a hora'),
      sin ? h('span', { class: 'pill bad' }, sin + ' sin cubrir') : (day.subs.length ? h('span', { class: 'pill tier t1' }, 'Todo cubierto') : null),
      (() => { const ss = day.subs.map((x) => this.seen(x)).filter(Boolean); if (!ss.length) return null; const ok = ss.filter((v) => v === 'read').length; return h('span', { class: 'pill ' + (ok === ss.length ? 'tier t1' : 'tier t3'), title: 'Sustituciones que el profesor ya ha confirmado' }, '✓ Enterados ' + ok + '/' + ss.length); })()));
    if (!day.absences.length) this.timeline.append(h('div', { class: 'empty good slim' }, h('div', { class: 'empty-ico' }, icon(wd ? 'check' : 'calendar')), h('div', null, h('b', null, wd ? 'No falta nadie' : 'Sin clase este día'), wd ? h('p', { class: 'muted small' }, 'Cuando registres una ausencia, aquí verás quién cubre cada hora.') : null)));
    else {
      const tl = h('ol', { class: 'tl' });
      for (const slot of SLOT_ORDER) {
        const subs = day.subs.filter((x) => x.slot === slot);
        const st = !subs.length ? 'is-idle' : subs.some((x) => !x.subId) ? 'is-bad' : 'is-ok';
        tl.append(h('li', { class: 'tl-row ' + st },
          h('div', { class: 'tl-time' }, h('b', null, slot === 'R' ? 'Recreo' : slot + 'ª'), h('span', { class: 'time' }, sessTime(slot))),
          h('div', { class: 'tl-dot', 'aria-hidden': 'true' }),
          h('div', { class: 'tl-body' }, subs.length ? subs.map((x) => h('div', { class: 'tl-item' },
            h('span', { class: 'tl-abs' }, avatar(x.absentId, 'sm'), tName(x.absentId)), h('span', { class: 'tl-arrow', 'aria-hidden': 'true' }, icon('chevr')),
            x.subId ? h('span', { class: 'tl-subwrap' }, h('b', { class: 'tl-sub' }, avatar(x.subId, 'sm'), tName(x.subId)), (() => { const st = this.seen(x); return st ? h('span', { class: 'ent ' + (st === 'read' ? 'ok' : 'no'), title: st === 'read' ? 'El profesor ha pulsado «Enterado»' : 'Ha recibido el aviso pero aún no ha pulsado «Enterado»' }, st === 'read' ? '✓ Enterado' : '… sin enterar') : null; })()) : h('b', { class: 'tl-sub bad' }, 'Sin cubrir'),
            h('span', { class: 'muted small' }, placeTxt(x)), x.subId ? tierPill(x) : null)) : h('span', { class: 'muted small' }, 'Sin sustituciones'))));
      }
      this.timeline.append(tl);
    }

    // ausencias
    this.absWrap.textContent = '';
    this.absWrap.append(h('div', { class: 'card-head' }, h('h2', null, 'Ausencias del día'),
      day.absences.length ? h('span', { class: 'muted' }, day.absences.length + ' persona' + (day.absences.length === 1 ? '' : 's')) : null));
    if (!day.absences.length) this.absWrap.append(h('p', { class: 'muted' }, 'Nadie ha avisado de que falta este día.'));
    for (const a of day.absences) {
      const T = tById(a.tid);
      const needs = day.subs.filter((s) => s.absId === a.id).length;
      const isStrike = strikeIds(date).includes(a.id);
      const full = a.slots.length >= SLOT_ORDER.length;
      this.absWrap.append(h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'who-line' }, avatar(a.tid), h('b', null, tName(a.tid)), a.exc ? h('span', { class: 'pill accent' }, 'Excursión') : null, h('span', { class: 'role-tag' }, T ? ROLES[T.role] : ''), isStrike ? h('span', { class: 'pill tier t3' }, 'Huelga') : null),
          h('div', { class: 'muted small' }, full ? 'Todo el día' : a.slots.map((s) => (s === 'R' ? 'Recreo' : s + 'ª')).join(', '),
            needs ? ' · ' + needs + ' franja' + (needs === 1 ? '' : 's') + ' que cubrir' : ' · no necesita sustitución'),
          notasOf(date)[a.id] ? h('div', { class: 'small' }, 'Nota: ' + notasOf(date)[a.id]) : null),
        h('div', { class: 'row-wrap' }, h('button', { class: 'btn ghost sm', onclick: () => setStrike(date, a.id, !isStrike) }, isStrike ? 'Quitar huelga' : 'Marcar huelga'),
          h('button', { class: 'btn ghost sm', onclick: () => removeAbsence(date, a.id) }, 'Quitar'))));
    }

    // sustituciones
    this.subWrap.textContent = '';
    this.subWrap.append(h('div', { class: 'card-head' }, h('h2', null, 'Sustituciones'),
      day.subs.length ? h('button', { class: 'btn ghost sm', onclick: () => reassignDay(date) }, icon('refresh'), 'Recalcular todo') : null));
    if (!day.subs.length) this.subWrap.append(h('p', { class: 'muted' }, 'Cuando registres una ausencia, aquí aparecerá el reparto por franjas.'));
    for (const slot of SLOT_ORDER) {
      const subs = day.subs.filter((s) => s.slot === slot);
      if (!subs.length) continue;
      const n = day.absences.filter((a) => a.slots.includes(slot)).length;
      const infN = day.absences.filter((x) => x.slots.includes(slot) && (tById(x.tid) || {}).role === 'infantil').length;
      const crit = (infN ? (infN >= 2 ? 'Infantil: PT y AL' : 'Infantil: apoyo de infantil') + ' · ' : '') + (n <= 1 ? 'Criterio: libres, coordinación, directivo' : n === 2 ? 'Criterio: libres, coordinación, apoyos, directivo' : 'Criterio: libres, coordinación, apoyos, PT/AL, directivo');
      this.subWrap.append(h('div', { class: 'slot-group' },
        h('div', { class: 'slot-head' }, h('b', null, slotLabel(slot)), h('span', { class: 'time' }, sessTime(slot)), h('span', { class: 'muted small' }, n + ' ausente' + (n === 1 ? '' : 's') + ' · ' + crit)),
        subs.map((s) => {
          const notif = this.seen(s);
          return h('div', { class: 'row sub' },
            h('div', { class: 'grow' },
              h('div', null, 'Cubre a ', h('b', null, tName(s.absentId))),
              h('div', { class: 'muted small' }, 'Lugar: ' + placeTxt(s))),
            h('div', { class: 'sub-pick' },
              this.subSelect(s, date, wd),
              h('div', { class: 'meta' }, tierPill(s), s.fb ? h('span', { class: 'small muted', title: 'No había nadie en el nivel que marca el criterio; se ha usado otro.' }, 'criterio ampliado') : null, s.manual ? h('span', { class: 'small muted' }, 'manual') : null,
                notif ? h('span', { class: 'small ' + (notif === 'read' ? 'ok' : 'muted') }, notif === 'read' ? '✓ enterado' : 'avisado · sin enterar') : null)));
        })));
    }
  },
  seen(s) {
    if (!s.subId) return null;
    const ns = S.dayNotifs.filter((n) => n.key === s.key && n.to === s.subId && n.kind === 'asigna');
    if (!ns.length) return null;
    return ns.some((n) => n.read) ? 'read' : 'sent';
  },
  subSelect(s, date, wd) {
    const sel = h('select', { 'aria-label': 'Sustituto de ' + tName(s.absentId) + ', ' + slotLabel(s.slot), onchange: (e) => setSub(date, s.key, e.target.value) },
      h('option', { value: '' }, '— Sin asignar —'),
      sortedTeachers().map((t) => {
        const gone = isAbsent(S.days[date] || { absences: [] }, t.id, s.slot);
        return h('option', { value: t.id, disabled: gone }, t.name + ' · ' + (gone ? 'ausente' : cellState(t, wd, s.slot)));
      }));
    sel.value = s.subId || '';
    return sel;
  }
};
views.hoy = Hoy;


/* =====================================================  PANEL DEL DÍA (para todos)  */
const Panel = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { S.panelDate = todayStr(); $('#main').append(this.el); },
  render() {
    const el = this.el; el.textContent = '';
    const date = S.panelDate, today = todayStr();
    const go2 = (d) => { S.panelDate = d; refresh(Panel); };
    el.append(h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost', 'aria-label': 'Día anterior', onclick: () => go2(addDays(date, -1)) }, icon('chevl')),
      h('input', { type: 'date', id: 'panel-fecha', 'aria-label': 'Fecha', value: date, onchange: (e) => { if (e.target.value) go2(e.target.value); } }),
      h('button', { class: 'btn ghost', 'aria-label': 'Día siguiente', onclick: () => go2(addDays(date, 1)) }, icon('chevr')),
      h('button', { class: 'btn ghost', onclick: () => go2(today) }, 'Hoy'), printBtn('Imprimir panel')));
    el.append(h('p', { class: 'date-label' }, fmtDate(date) + (date === today ? ' · hoy' : '')));
    el.append(greeting());
    if (!S.loaded.days) return el.append(skeleton());
    { const md = miDia(date); if (md) el.append(md); const ex = excCards(date); if (ex) el.append(ex); }
    const day = S.days[date] || { absences: [], subs: [] };
    if (!weekdayKey(date)) el.append(h('p', { class: 'note warn' }, 'Fin de semana: no hay clase.'));
    else if (!day.absences.length) el.append(h('div', { class: 'empty good' }, h('div', { class: 'empty-ico' }, icon('check')), h('h3', null, 'No falta nadie'), h('p', { class: 'muted' }, date === today ? 'Hoy están todos los profesores.' : 'No hay ausencias registradas para este día.')));
    else {
      const sin = day.subs.filter((s) => !s.subId).length;
      el.append(h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, day.absences.length + (day.absences.length === 1 ? ' ausencia' : ' ausencias')), sin ? h('span', { class: 'pill bad' }, sin + ' sin cubrir') : null),
        day.absences.map((a) => {
          const T = tById(a.tid), subs = day.subs.filter((s) => s.absId === a.id);
          const full = a.slots.length >= SLOT_ORDER.length;
          const wd = weekdayKey(date);
          const lost = T && isSpecial(T.role) ? a.slots.filter((s) => s !== 'R').map((s) => ({ s, c: cellOf(T, wd, s) })).filter((l) => l.c && l.c.t === 'c') : [];
          return h('div', { class: 'row sub' },
            h('div', { class: 'grow' },
              h('div', { class: 'who-line' }, avatar(a.tid), h('b', null, tName(a.tid)), a.exc ? h('span', { class: 'pill accent' }, 'Excursión') : null, h('span', { class: 'role-tag' + (T && isSpecial(T.role) ? ' hl' : '') }, T ? ROLES[T.role] : '')),
              h('div', { class: 'muted small' }, full ? 'Todo el día' : a.slots.map((s) => (s === 'R' ? 'Recreo' : s + 'ª')).join(', '))),
            h('div', { class: 'cover' }, subs.length ? subs.map((s) => h('div', { class: 'small' + (s.subId && s.subId === S.me ? ' mine-line' : '') },
              h('span', { class: 'time' }, (s.slot === 'R' ? 'Recreo' : s.slot + 'ª') + ' '), s.subId ? tName(s.subId) + (s.subId === S.me ? ' (tú)' : '') : h('b', { class: 'bad-t' }, 'sin cubrir'), h('span', { class: 'muted' }, ' · ' + placeTxt(s))))
              : h('span', { class: 'muted small' }, 'No necesita sustituto'),
              lost.length ? h('div', { class: 'lost small' }, h('b', null, 'Sin su apoyo: '), lost.map((l) => l.s + 'ª ' + (l.c.g || '')).join(' · ')) : null));
        })));
    }
    // próximos días
    const next = Object.keys(S.days).filter((d) => d > date && d >= today && (S.days[d].absences || []).length).sort().slice(0, 7);
    if (next.length) {
      const c = h('div', { class: 'card no-print' }, h('h3', null, 'Próximos días con ausencias'));
      for (const d of next) c.append(h('button', { class: 'row link', onclick: () => go2(d) },
        h('b', { class: 'nowrap cap-first' }, fmtShort(d)), h('span', { class: 'grow left' }, S.days[d].absences.map((a) => tName(a.tid)).join(', '))));
      el.append(c);
    }
  }
};
views.panel = Panel;

/* =====================================================  MIS SUSTITUCIONES  */
const Mis = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { $('#main').append(this.el); },
  render() {
    const el = this.el; el.textContent = '';
    if (!S.loaded.school) return el.append(skeleton());
    if (!S.school.teachers.length) return el.append(empty('Todavía no hay profesorado cargado', S.admin ? 'Importa los horarios en la pestaña Profesorado.' : 'La jefatura de estudios está preparando los horarios.', null, 'users'));
    if (S.locked && (!S.me || !tById(S.me))) {
      return el.append(empty('Tu cuenta aún no está ligada a tu ficha', 'Pide a la jefatura de estudios que asigne tu correo a tu nombre (Centro → Quién puede entrar). Cuando lo haga, recarga esta página.', null, 'lock'));
    }
    if (!S.me || !tById(S.me)) {
      const sel = h('select', { id: 'yo' }, h('option', { value: '' }, '— Elige tu nombre —'), sortedTeachers().map((t) => h('option', { value: t.id }, t.name)));
      return el.append(h('div', { class: 'card narrow' }, h('h2', null, '¿Quién eres?'),
        h('p', { class: 'muted' }, 'Así podremos avisarte cuando te toque sustituir. Solo tienes que hacerlo una vez en este dispositivo.'),
        h('div', { class: 'field' }, sel),
        h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: () => { if (sel.value) setMe(sel.value); } }, 'Continuar'))));
    }
    const me = tById(S.me), today = todayStr();
    el.append(h('div', { class: 'card-head' }, h('h2', null, 'Hola, ' + me.name.split(' ')[0]),
      S.locked || S.myTid ? null : h('button', { class: 'btn ghost sm', onclick: () => setMe(null) }, 'No soy yo')));
    if (window.pushApi) el.append(this.pushCard(me));
    // avisos
    const unread = S.notifs.filter((n) => !n.read);
    const nCard = h('div', { class: 'avisos' }, h('div', { class: 'card-head' }, h('h3', null, 'Avisos', unread.length ? h('span', { class: 'badge inl' }, unread.length) : null),
      unread.length > 1 ? h('button', { class: 'btn ghost sm', onclick: () => this.readAll() }, icon('check'), 'Marcar todo como visto') : null));
    if (!unread.length) nCard.append(h('div', { class: 'empty good slim' }, h('div', { class: 'empty-ico' }, icon('bell')), h('div', null, h('b', null, 'Estás al día'), h('p', { class: 'muted small' }, 'No tienes avisos nuevos.'))));
    unread.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)).forEach((n) => nCard.append(this.aviso(n)));
    el.append(nCard);
    // próximas
    const mine = [];
    for (const d in S.days) for (const s of S.days[d].subs || []) if (s.subId === S.me) mine.push({ date: d, ...s, nota: (S.notifs.find((n) => n.date === d && n.key === s.key && n.kind === 'asigna') || {}).nota });
    const slotIdx = (s) => SLOT_ORDER.indexOf(s.slot);
    const up = mine.filter((m) => m.date >= today).sort((a, b) => a.date.localeCompare(b.date) || slotIdx(a) - slotIdx(b));
    const past = mine.filter((m) => m.date < today).sort((a, b) => b.date.localeCompare(a.date) || slotIdx(a) - slotIdx(b)).slice(0, 12);
    const uCard = h('div', { class: 'card' }, h('h3', null, 'Próximas sustituciones'));
    if (!up.length) uCard.append(h('p', { class: 'muted' }, 'No tienes sustituciones previstas.'));
    let last = '';
    for (const m of up) {
      if (m.date !== last) { uCard.append(h('div', { class: 'day-head' }, fmtDate(m.date), m.date === today ? h('span', { class: 'pill accent' }, 'hoy') : null)); last = m.date; }
      uCard.append(this.item(m));
    }
    el.append(uCard);
    // patio
    const turns = (S.patios[today.slice(0, 7)] || { turns: {} }).turns || {};
    const pdoc = S.patios[today.slice(0, 7)];
    let myP = [];
    if (pdoc && pdoc.dates) myP = Object.keys(pdoc.dates).sort().filter((dt) => dt >= today && [...(pdoc.dates[dt].prim || []), ...(pdoc.dates[dt].inf || [])].includes(S.me));
    else myP = WD.filter((d) => onPatio(pdoc, d, S.me)).map((d) => WDN[d]);
    const shown = pdoc && pdoc.dates ? myP.map((dt) => fmtDate(dt)) : myP;
    el.append(h('div', { class: 'card' }, h('h3', null, pdoc && pdoc.dates ? 'Tus próximos patios este mes' : 'Tu turno de patio este mes'),
      h('p', null, shown.length ? shown.join(' · ') + ' · ' + sessTime('R') : h('span', { class: 'muted' }, pdoc ? 'No tienes más turnos de patio este mes.' : 'Aún no se han publicado los turnos de este mes.'))));
    const wk = weekStart(today), smDays = WD.filter((d) => (((S.sm[wk] || {}).days || {})[d] || []).includes(S.me));
    if (smDays.length) el.append(h('div', { class: 'card' }, h('h3', null, 'Servicios mínimos esta semana'), h('p', null, smDays.map((d) => WDN[d]).join(', '))));
    if (past.length) {
      const det = h('details', { class: 'card' }, h('summary', null, 'Sustituciones anteriores'));
      for (const m of past) det.append(this.item(m, true));
      el.append(det);
    }
  },
  pushCard(me) {
    const st = window.pushApi.status();
    if (st === 'granted') return h('div', { class: 'empty good slim' }, h('div', { class: 'empty-ico' }, icon('bell')), h('div', null, h('b', null, 'Avisos en el móvil activados'), h('p', { class: 'muted small' }, 'Te llegará una notificación cuando te toque sustituir o se cancele.')));
    const msg = { 'ios-install': 'En iPhone, primero añade esta página a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) y ábrela desde ese icono. Después podrás activar los avisos.', unsupported: 'Este navegador no permite avisos en el móvil. Prueba con Chrome (Android) o instala la página en la pantalla de inicio.', denied: 'Has bloqueado las notificaciones. Para activarlas, entra en los ajustes del navegador o del móvil y permítelas para esta página.', default: 'Recibe un aviso en el móvil cuando te toque sustituir, aunque no tengas la página abierta.' }[st];
    return h('div', { class: 'card pushcard' }, h('div', { class: 'who-line' }, h('div', { class: 'empty-ico', style: 'width:44px;height:44px;font-size:22px;margin:0' }, icon('bell')), h('div', { class: 'grow' }, h('b', null, 'Avisos en el móvil'), h('p', { class: 'muted small', style: 'margin:2px 0 0' }, msg))),
      st === 'default' ? h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: async () => { const r = await window.pushApi.enable(me.id); toast(r.ok ? 'Avisos activados' : 'No se han podido activar los avisos', !r.ok); refresh(Mis); } }, icon('bell'), 'Activar avisos')) : null);
  },
  aviso(n) {
    const cancel = n.kind === 'cancela';
    if (!n.date || !n.slot) return h('div', { class: 'aviso ' + n.kind }, h('div', { class: 'aviso-body' }, h('p', null, n.text), h('span', { class: 'muted small' }, timeAgo(n.ts))), h('button', { class: 'btn ghost sm', onclick: () => this.read(n) }, 'Visto'));
    const sub = ((S.days[n.date] || {}).subs || []).find((x) => x.key === n.key);
    const ab = ((S.days[n.date] || {}).absences || []).find((a) => sub && a.id === sub.absId);
    const [t1, t2] = sessTime(n.slot).split('–');
    const today = todayStr(), rel = n.date === today ? 'Hoy' : n.date === addDays(today, 1) ? 'Mañana' : fmtDate(n.date);
    return h('article', { class: 'aviso ' + n.kind + (n.date === today && !cancel ? ' hoy' : '') },
      h('div', { class: 'aviso-time' }, h('b', null, t1), h('span', null, t2 || ''), h('em', null, n.slot === 'R' ? 'Recreo' : n.slot + 'ª hora')),
      h('div', { class: 'aviso-body' },
        h('div', { class: 'aviso-when' }, icon(cancel ? 'x' : 'bell'), rel, h('span', { class: 'muted' }, ' · ' + timeAgo(n.ts))),
        h('h4', null, cancel ? 'Ya no tienes que sustituir a ' : 'Sustituyes a ', h('b', null, tName(n.absentId))),
        !cancel && sub && sub.place ? h('div', { class: 'aviso-place' }, icon('home'), placeTxt(sub)) : null,
        !cancel && n.nota ? h('div', { class: 'small muted' }, 'Nota: ' + n.nota) : null),
      h('button', { class: 'btn ' + (cancel ? 'ghost' : 'primary') + ' sm', onclick: () => this.read(n) }, icon('check'), 'Enterado'));
  },
  item(m, quiet) {
    return h('div', { class: 'row sub' + (quiet ? ' quiet' : '') },
      h('div', { class: 'time-col' }, h('b', { class: 'tc-big' }, sessTime(m.slot).split('–')[0]), h('span', { class: 'time' }, (m.slot === 'R' ? 'Recreo' : m.slot + 'ª hora'))),
      h('div', { class: 'grow' }, h('div', null, 'Sustituyes a ', h('b', null, tName(m.absentId))),
        h('div', null, 'Lugar: ', h('b', null, placeTxt(m))), m.nota ? h('div', { class: 'small muted' }, 'Nota: ' + m.nota) : null),
      quiet ? h('span', { class: 'muted small' }, fmtShort(m.date)) : null);
  },
  read(n) { if (S.canWrite === false) return; S.db.doc('notifs/' + n.id).update({ read: true }).catch(() => toast('No se pudo marcar como visto.', true)); },
  readAll() { S.notifs.filter((n) => !n.read).forEach((n) => this.read(n)); }
};
views.mis = Mis;

/* =====================================================  COMUNICACIÓN  */
const Chat = {
  el: h('section', { class: 'view', hidden: true }), built: false, unsub: null, sub: null,
  build() {
    this.sel = h('select', { id: 'chat-dia', 'aria-label': 'Día', onchange: (e) => { S.chatDate = e.target.value; this.watch(); this.render(); } });
    this.who = h('div', { class: 'chips' });
    this.list = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
    this.input = h('input', { type: 'text', id: 'chat-msg', placeholder: S.admin ? 'Escribe a quienes sustituyen hoy…' : 'Escribe al jefe de estudios…', 'aria-label': S.admin ? 'Mensaje para el chat del día' : 'Mensaje para el jefe de estudios', autocomplete: 'off', maxlength: 600 });
    this.send = h('button', { class: 'btn primary', type: 'submit' }, icon('send'), 'Enviar');
    this.note = h('p', { class: 'note small' });
    this.el.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Comunicación de sustitutos'), this.sel),
        h('p', { class: 'muted small' }, 'Un espacio por día para el profesorado que sustituye y la jefatura de estudios.'),
        this.who, this.list, this.note,
        h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); this.post(); } }, this.input, this.send)));
    $('#main').append(this.el);
  },
  dates() {
    const today = todayStr(), set = new Set();
    for (const d in S.days) {
      const subs = S.days[d].subs || [];
      if (S.admin ? subs.length : subs.some((s) => s.subId && s.subId === S.me)) set.add(d);
    }
    if (S.admin) set.add(today);
    return [...set].sort().reverse();
  },
  participants(date) {
    const day = S.days[date]; if (!day) return [];
    return [...new Set((day.subs || []).filter((s) => s.subId).map((s) => s.subId))];
  },
  canTalk(date) { return S.canWrite !== false && (S.admin || this.participants(date).includes(S.me)); },
  watch() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.unsubSeen) { this.unsubSeen(); this.unsubSeen = null; }
    this.sub = S.chatDate; S.chatMsgs = []; S.chatSeen = {}; this.seenW = 0;
    if (!S.chatDate || !S.db) return;
    this.unsubSeen = S.db.collection('chats/' + S.chatDate + '/seen').onSnapshot((snap) => {
      S.chatSeen = {}; snap.docs.forEach((d) => { S.chatSeen[d.id] = (d.data() || {}).ts || 0; });
      if (S.admin) this.renderMsgs();
    }, () => {});
    this.unsub = S.db.collection('chats/' + S.chatDate + '/msgs').orderBy('ts').onSnapshot((snap) => {
      S.chatMsgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      this.renderMsgs();
    }, () => {});
  },
  render() {
    const dates = this.dates(), today = todayStr();
    if (!S.chatDate || !dates.includes(S.chatDate)) {
      S.chatDate = dates.includes(today) ? today : (dates.filter((d) => d > today).pop() || dates[0] || null);
    }
    if (this.sub !== S.chatDate) this.watch();
    this.sel.textContent = '';
    this.sel.append(dates.map((d) => h('option', { value: d }, fmtShort(d) + (d === today ? ' (hoy)' : ''))));
    if (S.chatDate) this.sel.value = S.chatDate;
    this.sel.hidden = !dates.length;
    const date = S.chatDate;
    this.who.textContent = '';
    if (date) {
      this.who.append(h('span', { class: 'chip jefe' }, 'Jefatura de estudios'), this.participants(date).map((id) => h('span', { class: 'chip' }, avatar(id, 'sm'), tName(id) + (id === S.me ? ' (tú)' : ''))));
    }
    const ok = !!date && this.canTalk(date);
    this.input.disabled = !ok; this.send.disabled = !ok;
    this.note.textContent = !date ? 'Todavía no tienes sustituciones, así que no hay ningún chat abierto.' : (!ok ? (S.canWrite === false ? 'Con tu nivel de acceso solo puedes leer los mensajes.' : 'Este día no tienes sustituciones. Puedes leer pero no escribir.') : '');
    this.note.hidden = !this.note.textContent;
    this.renderMsgs();
  },
  renderMsgs() {
    this.list.textContent = '';
    if (!S.chatDate) return;
    const date = S.chatDate, msgs = S.chatMsgs;
    if (!msgs.length) this.list.append(h('div', { class: 'empty slim' }, h('div', { class: 'empty-ico' }, icon('chat')), h('div', null, h('b', null, 'Aún no hay mensajes este día'), h('p', { class: 'muted small' }, 'Escribe para coordinaros: dónde dejar el material, cambios de última hora…'))));
    const fmtT = (ts) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const parts = this.participants(date);
    let lastMine = -1;
    msgs.forEach((m, i) => { if (m.uid && m.uid === S.uid) lastMine = i; });
    let prev = null;
    msgs.forEach((m, i) => {
      const mine = !!(m.uid && m.uid === S.uid);
      const who = m.jefe ? 'Jefatura de estudios' : (m.tid ? tName(m.tid) : 'Profesorado');
      const key = (m.jefe ? 'J' : '') + (m.tid || '') + (m.uid || '');
      const grouped = prev && prev.key === key && m.ts - prev.ts < 5 * 60 * 1000;
      const next = msgs[i + 1];
      const lastOfGroup = !next || (((next.jefe ? 'J' : '') + (next.tid || '') + (next.uid || '')) !== key) || next.ts - m.ts >= 5 * 60 * 1000;
      prev = { key, ts: m.ts };
      const av = m.jefe ? avatar(null, null, true) : (m.tid && tById(m.tid) ? avatar(m.tid) : h('span', { class: 'av av0' }, '?'));
      let seen = null;
      if (S.admin && mine && i === lastMine && parts.length) {
        const by = parts.filter((id) => (S.chatSeen[id] || 0) >= m.ts);
        seen = h('div', { class: 'seen' + (by.length === parts.length ? ' all' : ''), title: by.length ? 'Visto por: ' + by.map(tName).join(', ') : 'Aún no lo ha visto nadie' },
          icon('check'), by.length === parts.length ? 'Visto por todos' : by.length ? 'Visto por ' + by.length + ' de ' + parts.length : 'Enviado · sin ver');
      }
      this.list.append(h('div', { class: 'msgrow' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '') },
        mine ? null : h('div', { class: 'msg-av' }, grouped ? null : av),
        h('div', { class: 'bubble-wrap' },
          !grouped && !mine ? h('div', { class: 'msg-meta' }, who) : null,
          h('div', { class: 'bubble' + (m.jefe && !mine ? ' jefe' : '') + (mine ? ' mine' : '') + (lastOfGroup ? ' tail' : '') }, h('span', { class: 'msg-text' }, m.text), h('span', { class: 'msg-time' }, fmtT(m.ts))),
          seen)));
    });
    this.list.scrollTop = this.list.scrollHeight;
    this.markSeen();
    if (!this.el.hidden && msgs.length && date === CHATBG.date) { const b = chatUnread(); setChatSeenLocal(date, msgs[msgs.length - 1].ts); if (b !== chatUnread()) renderTabs(); }
  },
  markSeen() {
    if (!S.db || !S.chatDate || this.el.hidden || S.canWrite === false) return;
    const id = S.admin ? 'jefe' : S.me;
    if (!id || !S.chatMsgs.length) return;
    if (!S.admin && !this.participants(S.chatDate).includes(S.me)) return;
    const last = S.chatMsgs[S.chatMsgs.length - 1].ts;
    if (S.admin) return;                       // la jefatura no necesita acuse
    if ((this.seenW || 0) >= last) return;
    this.seenW = last;
    S.db.doc('chats/' + S.chatDate + '/seen/' + id).set({ ts: Date.now(), tid: id }).catch(() => {});
  },
  post() {
    const text = this.input.value.trim();
    if (!text || !S.chatDate) return;
    this.input.value = '';
    S.db.collection('chats/' + S.chatDate + '/msgs').add({ uid: S.uid, tid: S.me, jefe: S.admin, text, ts: Date.now() })
      .then(() => { if (S.admin && window.pushNotify) { const d = S.chatDate; window.pushNotify(this.participants(d).map((id) => ({ to: id, kind: 'chat', date: d, text: 'Jefatura: ' + text.slice(0, 140) }))).catch(() => {}); } })
      .catch(() => { this.input.value = text; toast('No se pudo enviar el mensaje.', true); });
  }
};
views.chat = Chat;

/* =====================================================  PATIOS  */
/* ---------- rotación de patios extra (solo jefatura) ---------- */
function rotacionCard() {
  const ctx = ctxFor(todayStr()), px = S.school.patioExtra || { desde: PATIO_DESDE, base: PATIO_BASE_DEFAULT };
  const base = px.base || {}, desde = px.desde || PATIO_DESDE;
  const led = patioLedger(ctx, ''), cmp = patioCmp(led);
  const app = {};
  for (const d in S.days) { if (d < desde) continue; for (const x of S.days[d].subs || []) if (x.slot === 'R' && x.subId) app[x.subId] = (app[x.subId] || 0) + 1; }
  const who = S.school.teachers.filter((t) => t.role !== 'directivo').slice().sort(cmp);
  const fm = (d) => (d ? d.slice(8) + '/' + d.slice(5, 7) : '—');
  const saveBase = (id, patch) => saveSchool((x) => {
    x.patioExtra = x.patioExtra || { desde: PATIO_DESDE, base: JSON.parse(JSON.stringify(PATIO_BASE_DEFAULT)) };
    x.patioExtra.base = x.patioExtra.base || {};
    x.patioExtra.base[id] = Object.assign({ n: 0, last: '' }, x.patioExtra.base[id], patch);
  });
  const next = who.slice(0, 3).map((t) => t.name).join(' · ');
  const list = h('div', { class: 'rot-list' }, who.map((t, i) => {
    const b = base[t.id] || { n: 0, last: '' };
    const row = h('div', { class: 'rot-row' + (i < 3 ? ' next' : '') },
      h('span', { class: 'rot-pos' }, i + 1), avatar(t.id, 'sm'),
      h('span', { class: 'rot-name' }, h('b', null, t.name), h('span', { class: 'muted small rot-last' }, 'Último patio extra: ' + fm((led[t.id] || {}).last))),
      h('span', { class: 'pill' + ((led[t.id] || {}).n ? ' tier t1' : '') , title: 'Patios extra hechos este curso' }, ((led[t.id] || {}).n || 0) + ' extra'));
    const ed = h('div', { class: 'rot-edit' },
      h('label', { class: 'field' }, h('span', null, 'Historial'), h('input', { type: 'number', min: 0, max: 99, value: b.n || 0, 'aria-label': 'Patios extra anteriores de ' + t.name, onchange: (e) => saveBase(t.id, { n: Math.max(0, parseInt(e.target.value, 10) || 0) }) })),
      h('label', { class: 'field' }, h('span', null, 'Último (historial)'), h('input', { type: 'date', value: b.last || '', 'aria-label': 'Fecha del último patio extra de ' + t.name, onchange: (e) => saveBase(t.id, { last: e.target.value || '' }) })),
      h('span', { class: 'muted small' }, 'En la app: ' + (app[t.id] || 0)));
    return h('div', { class: 'rot-item' }, row, ed);
  }));
  return h('details', { class: 'card rot no-print' },
    h('summary', null, h('b', null, 'Rotación de patios extra'), h('span', { class: 'muted small rot-next' }, 'Siguen: ' + (next || '—'))),
    h('p', { class: 'muted small' }, 'Los patios que hay que cubrir van por turno riguroso: primero quien menos patios extra lleva y, a igualdad, quien hizo el último hace más tiempo. Si alguien no puede ese día (falta, tiene patio o no está), se salta sin perder su turno. Se cuentan los hechos en la app desde el ' + fm(desde) + ' más el historial anterior.'),
    list);
}
const Patios = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { $('#main').append(this.el); },
  render() {
    const el = this.el; el.textContent = '';
    const month = S.patioMonth, doc = S.patios[month];
    const monthIn = h('input', { type: 'month', id: 'patio-mes', 'aria-label': 'Mes', value: month, onchange: (e) => { if (e.target.value) { S.patioMonth = e.target.value; refresh(Patios); } } });
    const label = toDate(month + '-01').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    el.append(h('div', { class: 'toolbar' }, monthIn, S.admin && S.patios[prevMonth(month)] && !doc ? h('button', { class: 'btn ghost', onclick: () => savePatio(month, (d) => { const p = S.patios[prevMonth(month)]; d.turns = JSON.parse(JSON.stringify(p.turns || d.turns)); d.turnsInf = JSON.parse(JSON.stringify(p.turnsInf || d.turnsInf)); }) }, 'Copiar del mes anterior') : null));
    el.append(h('h2', { class: 'cap' }, 'Turnos de patio · ' + label));
    if (S.admin && S.school.teachers.length) el.append(rotacionCard());
    if (!S.school.teachers.length) return el.append(empty('No hay profesorado cargado', 'Importa antes los horarios en la pestaña Profesorado.', null, 'users'));
    if (!doc && !S.admin) return el.append(empty('Aún no se han publicado los turnos de este mes', 'Cuando la jefatura los cargue, los verás aquí.', null, 'calendar'));
    if (doc && doc.dates) return el.append(this.byDate(month, doc));
    el.append(this.section(month, doc, 'turns', 'Primaria'), this.section(month, doc, 'turnsInf', 'Infantil'));
  },
  byDate(month, doc) {
    const wrap = h('div', { class: 'patio-sec' });
    const today = todayStr();
    const reqP = S.school.patioPrim || 6, reqI = S.school.patioInf || 5;
    const col = (dt, k, req, lbl) => {
      const e = doc.dates[dt], ids = e[k] || [];
      const sel = S.admin ? h('select', { 'aria-label': 'Añadir el ' + dt + ' (' + lbl + ')', onchange: (ev) => { const v = ev.target.value; if (v) savePatio(month, (x) => { const q = x.dates[dt]; q[k] = [...new Set([...(q[k] || []), v])]; }); } },
        h('option', { value: '' }, '+ Añadir'), sortedTeachers().filter((t) => !ids.includes(t.id)).map((t) => h('option', { value: t.id }, t.name))) : null;
      return h('div', { class: 'pd-grp' },
        h('div', { class: 'pd-lbl' }, h('b', null, lbl), h('span', { class: 'pill' + (ids.length === req ? ' tier t1' : ' bad'), title: 'Asignados / necesarios' }, ids.length + '/' + req)),
        ids.length ? h('div', { class: 'chips' }, ids.map((id) => h('span', { class: 'chip rm' + (id === S.me ? ' me' : '') }, tName(id),
          S.admin ? h('button', { class: 'x', 'aria-label': 'Quitar a ' + tName(id), onclick: () => savePatio(month, (x) => { x.dates[dt][k] = (x.dates[dt][k] || []).filter((i) => i !== id); }) }, '×') : null))) : h('p', { class: 'muted small' }, 'Sin asignar'),
        sel);
    };
    const list = h('div', { class: 'pd-list' }), olds = h('div', { class: 'pd-list' });
    for (const dt of Object.keys(doc.dates).sort()) {
      const e = doc.dates[dt];
      const head = h('div', { class: 'pd-head' }, h('h3', null, ((x) => x.charAt(0).toUpperCase() + x.slice(1))(fmtDate(dt))), dt === today ? h('span', { class: 'pill accent' }, 'hoy') : null);
      const dest = dt < today ? olds : list;
      if (e.todos) { dest.append(h('div', { class: 'card pd-day' + (dt === today ? ' today' : '') + (dt < today ? ' past' : '') }, head, h('span', { class: 'pill accent' }, 'Todos los profesores en el patio'))); continue; }
      const mine = S.me && ((e.prim || []).includes(S.me) || (e.inf || []).includes(S.me));
      dest.append(h('div', { class: 'card pd-day' + (dt === today ? ' today' : '') + (dt < today ? ' past' : '') + (mine ? ' mine' : '') }, head, col(dt, 'prim', reqP, 'Primaria'), col(dt, 'inf', reqI, 'Infantil')));
    }
    wrap.append(h('p', { class: 'muted small' }, 'Recreo ' + sessTime('R') + ' · calendario por fechas.' + (S.me ? ' Tus días llevan una marca roja.' : '')), list);
    if (olds.children.length) wrap.append(h('details', { class: 'pd-old' }, h('summary', null, 'Días anteriores (' + olds.children.length + ')'), olds));
    return wrap;
  },
  section(month, doc, key, label) {
    const turns = (doc && doc[key]) || { L: [], M: [], X: [], J: [], V: [] };
    const wrap = h('div', { class: 'patio-sec' }, h('h3', null, 'Patio de ' + label.toLowerCase()));
    const grid = h('div', { class: 'patio-grid' });
    for (const d of WD) {
      const ids = turns[d] || [];
      const sel = h('select', { 'aria-label': 'Añadir al ' + WDN[d] + ' (' + label + ')', onchange: (e) => { const v = e.target.value; if (v) savePatio(month, (x) => { x[key] = x[key] || {}; x[key][d] = [...new Set([...(x[key][d] || []), v])]; }); } },
        h('option', { value: '' }, '+ Añadir'), sortedTeachers().filter((t) => !ids.includes(t.id)).map((t) => h('option', { value: t.id }, t.name)));
      const req = key === 'turns' ? (S.school.patioPrim || 6) : (S.school.patioInf || 5);
      grid.append(h('div', { class: 'card day-col' }, h('div', { class: 'card-head tight' }, h('h3', null, WDN[d]), h('span', { class: 'pill' + (ids.length === req ? ' tier t1' : ' bad'), title: 'Profesores asignados / necesarios' }, ids.length + '/' + req)), h('p', { class: 'muted small' }, 'Recreo ' + sessTime('R')),
        ids.length ? h('div', { class: 'chips col' }, ids.map((id) => h('span', { class: 'chip rm' + (id === S.me ? ' me' : '') }, tName(id),
          S.admin ? h('button', { class: 'x', 'aria-label': 'Quitar a ' + tName(id), onclick: () => savePatio(month, (x) => { x[key][d] = (x[key][d] || []).filter((i) => i !== id); }) }, '×') : null))) : h('p', { class: 'muted small' }, 'Sin asignar'),
        S.admin ? sel : null));
    }
    wrap.append(grid);
    if (S.admin) {
      const ta = h('textarea', { id: 'patio-pegar-' + key, rows: 6, placeholder: 'Lunes: Marta Ruiz, Raúl Peña\nMartes: Javier Soto, Sonia Lara\nMiércoles: …' });
      wrap.append(h('details', { class: 'card' }, h('summary', null, 'Pegar los turnos de ' + label.toLowerCase() + ' desde Word'),
        h('p', { class: 'muted small' }, 'Una línea por día con los nombres separados por comas. Sustituye los turnos de ' + label.toLowerCase() + ' de este mes.'),
        ta, h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: () => {
          const r = parsePatios(ta.value, S.school.teachers);
          const total = WD.reduce((n, d) => n + r.turns[d].length, 0);
          if (!total) return toast('No he reconocido ningún nombre. Revisa el formato.', true);
          savePatio(month, (x) => { x[key] = r.turns; });
          toast(total + ' turnos cargados' + (r.unknown.length ? ' · sin reconocer: ' + r.unknown.join(', ') : ''), !!r.unknown.length);
          ta.value = '';
        } }, 'Cargar turnos'))));
    }
    return wrap;
  }
};
views.patios = Patios;

/* =====================================================  PROFESORADO / HORARIOS  */
const Prof = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { $('#main').append(this.el); },
  render() {
    const el = this.el; el.textContent = '';
    const list = sortedTeachers();
    if (!S.selT || !tById(S.selT)) S.selT = (S.me && tById(S.me) ? S.me : (list[0] && list[0].id)) || null;
    el.append(h('h2', { class: 'cap' }, S.admin ? 'Profesorado y horarios' : 'Horarios del profesorado'));
    if (S.admin) el.append(this.adder(), this.importer());
    if (!list.length) return el.append(empty('Todavía no hay profesorado', S.admin ? 'Añade a alguien arriba o pega las tablas de Word.' : '', null, 'users'));
    el.append(h('div', { class: 'chips picker' }, list.map((t) => h('button', { class: 'chip pick' + (t.id === S.selT ? ' on' : ''), onclick: () => { S.selT = t.id; refresh(Prof); } }, avatar(t.id, 'sm'), t.name))));
    el.append(this.detail(tById(S.selT)));
  },
  adder() {
    const name = h('input', { type: 'text', id: 'nuevo-nombre', 'aria-label': 'Nombre y apellidos', placeholder: 'Nombre y apellidos', required: true });
    const role = h('select', { id: 'nuevo-rol', 'aria-label': 'Rol' }, Object.keys(ROLES).map((k) => h('option', { value: k }, ROLES[k])));
    return h('form', { class: 'card inline', onsubmit: (e) => {
      e.preventDefault();
      const nm = name.value.trim(); if (!nm) return;
      const id = rid();
      saveSchool((s) => { s.teachers.push({ id, name: nm, role: role.value, sched: {} }); });
      S.selT = id; name.value = '';
    } }, h('b', null, 'Añadir'), name, role, h('button', { class: 'btn primary', type: 'submit' }, 'Añadir'));
  },
  importer() {
    const ta = h('textarea', { id: 'importar', 'aria-label': 'Pegar tablas de horarios', rows: 8, placeholder: '@Marta Ruiz | tutora\nHora\tL\tM\tX\tJ\tV\n9:00\t3ºA\t3ºA\t\tAP 2ºB\t3ºA\n…\n\n@Raúl Peña | especialista\n…' });
    return h('details', { class: 'card' }, h('summary', null, 'Importar horarios desde Word'),
      h('ol', { class: 'steps' },
        h('li', null, 'En Word, selecciona la tabla del horario de un profesor y cópiala.'),
        h('li', null, 'Pégala aquí. Para varios a la vez, pon antes de cada tabla una línea con ', h('code', null, '@Nombre | rol'), ' (roles: tutor, especialista, PT, AL, directivo).'),
        h('li', null, 'Para un directivo que también cubra infantil, escribe ', h('code', null, '@Nombre | directivo infantil'), '.'),
        h('li', null, 'Si pegas una sola tabla sin “@”, se aplica al profesor seleccionado abajo.'),
        h('li', null, 'Se entiende así: celda vacía = libre; AP (o “AP 2ºA”) = apoyo; COO = coordinación; SPK = speaking (desdoble); un guion (-) = no está en el centro; cualquier otro texto es una clase con ese grupo. Revisa después el resultado y corrige lo que haga falta.')),
      ta, h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: () => {
        if (!ta.value.trim()) return;
        const bulk = parseBulk(ta.value);
        if (bulk) {
          if (!bulk.length) return toast('No he encontrado ningún “@Nombre”.', true);
          saveSchool((s) => {
            for (const b of bulk) {
              const ex = s.teachers.find((t) => norm(t.name) === norm(b.name));
              if (ex) { ex.sched = b.sched; ex.role = b.role; if (b.role === 'directivo') ex.cubreInf = !!b.cubreInf; } else s.teachers.push({ id: rid(), name: b.name, role: b.role, cubreInf: !!b.cubreInf, sched: b.sched });
            }
          });
          toast(bulk.length + ' horario' + (bulk.length === 1 ? '' : 's') + ' importado' + (bulk.length === 1 ? '' : 's'));
        } else {
          if (!S.selT) return toast('Primero añade o selecciona a un profesor.', true);
          const sched = parseTable(ta.value);
          if (!Object.keys(sched).length) return toast('No he reconocido la tabla.', true);
          const id = S.selT;
          saveSchool((s) => { s.teachers.find((t) => t.id === id).sched = sched; });
          toast('Horario importado para ' + tName(id));
        }
        ta.value = '';
      } }, 'Importar')));
  },
  detail(T) {
    const edit = S.admin;
    const card = h('div', { class: 'card' });
    const head = h('div', { class: 'card-head' });
    if (edit) {
      const nm = h('input', { type: 'text', value: T.name, 'aria-label': 'Nombre', onchange: (e) => { const v = e.target.value.trim(); if (v) saveSchool((s) => { s.teachers.find((t) => t.id === T.id).name = v; }); } });
      const rl = h('select', { 'aria-label': 'Rol', onchange: (e) => saveSchool((s) => { s.teachers.find((t) => t.id === T.id).role = e.target.value; }) }, Object.keys(ROLES).map((k) => h('option', { value: k }, ROLES[k])));
      rl.value = T.role;
      const inf = T.role === 'directivo' ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!T.cubreInf, onchange: (e) => saveSchool((s) => { s.teachers.find((t) => t.id === T.id).cubreInf = e.target.checked; }) }), h('span', null, 'Cubre infantil')) : null;
      head.append(h('div', { class: 'inline grow' }, nm, rl, inf), this.deleter(T));
    } else head.append(h('div', { class: 'who-line' }, avatar(T.id), h('h3', null, T.name), h('span', { class: 'role-tag' }, ROLES[T.role])));
    head.append(printBtn('Imprimir horario'));
    if (edit) card.append(h('h3', { class: 'print-only' }, T.name + ' · ' + ROLES[T.role]));
    card.append(head);
    if (isSpecial(T.role)) card.append(h('p', { class: 'note small' }, 'Sus sesiones de apoyo no necesitan sustituto cuando falta. Sí puede cubrir a otros cuando faltan tres o más.'));
    const mkTable = (edit) => {
    const tbl = h('table', { class: 'sched' });
    const todayK = weekdayKey(todayStr());
    tbl.append(h('thead', null, h('tr', null, h('th', null, ''), WD.map((d) => h('th', { class: d === todayK ? 'today' : '' }, WDN[d].slice(0, 3), d === todayK ? h('span', { class: 'time block' }, 'hoy') : null)))));
    const body = h('tbody');
    const month = todayStr().slice(0, 7), wkS = weekStart(todayStr());
    for (const s of SLOT_ORDER) {
      if (s === 'R') {
        body.append(h('tr', { class: 'recreo' }, h('th', null, 'Recreo', h('span', { class: 'time' }, sessTime('R'))),
          WD.map((d, di) => { const dt = addDays(wkS, di); return h('td', { class: d === todayK ? 'today' : '' }, onPatio(patioForDate(S.patios[dt.slice(0, 7)], dt), d, T.id) ? h('span', { class: 'cell patio' }, h('b', null, 'Patio')) : ''); })));
        continue;
      }
      body.append(h('tr', null, h('th', null, s + 'ª', h('span', { class: 'time' }, sessTime(s))),
        WD.map((d) => {
          const c = cellOf(T, d, s) || { t: 'n', g: '' };
          if (!edit) {
            const main = c.t === 'n' ? '–' : c.t === 'l' ? 'Libre' : c.t === 'o' ? 'Coord.' : c.t === 's' ? 'Speaking' : c.t === 'a' ? 'Apoyo' : (c.g || 'Clase');
            const sub = c.t === 'c' ? (c.g ? 'Clase' : '') : (c.t === 'a' || c.t === 's') ? c.g : '';
            return h('td', { class: d === todayK ? 'today' : '' }, h('span', { class: 'cell ' + c.t }, h('b', null, main), sub ? h('small', null, sub) : null));
          }
          const sel = h('select', { class: 'cell-sel ' + c.t, 'aria-label': WDN[d] + ' ' + s + 'ª', onchange: (e) => this.setCell(T.id, d + s, { t: e.target.value, g: ['c', 'a', 's'].includes(e.target.value) ? (cellOf(tById(T.id), d, s) || {}).g || '' : '' }) },
            Object.keys(CELL_NAMES).map((k) => h('option', { value: k }, CELL_NAMES[k])));
          sel.value = c.t;
          const g = h('input', { type: 'text', class: 'cell-g', value: c.g, placeholder: ['c', 'a', 's'].includes(c.t) ? 'Grupo' : '', disabled: !['c', 'a', 's'].includes(c.t), 'aria-label': 'Grupo ' + WDN[d] + ' ' + s + 'ª', onchange: (e) => this.setCell(T.id, d + s, { t: c.t, g: e.target.value.trim() }) });
          return h('td', null, sel, g);
        })));
    }
    tbl.append(body);
    return tbl;
    };
    const legend = () => h('div', { class: 'legend' }, [['c', 'Clase'], ['l', 'Libre'], ['a', 'Apoyo'], ['o', 'Coordinación'], ['s', 'Speaking'], ['patio', 'Patio']].map(([k, l]) => h('span', { class: 'lg' }, h('i', { class: 'cell ' + k }), l)));
    if (edit) card.append(h('div', { class: 'scroll edit-only' }, mkTable(true)), h('div', { class: 'print-only' }, legend(), mkTable(false)));
    else card.append(legend(), h('div', { class: 'scroll' }, mkTable(false)));
    return card;
  },
  setCell(id, key, cell) { saveSchool((s) => { const t = s.teachers.find((x) => x.id === id); t.sched = t.sched || {}; t.sched[key] = cell; }); },
  deleter(T) {
    const b = h('button', { class: 'btn danger sm', onclick: () => {
      if (b.dataset.armed) { S.selT = null; saveSchool((s) => { s.teachers = s.teachers.filter((t) => t.id !== T.id); }); return; }
      b.dataset.armed = '1'; b.textContent = 'Pulsa otra vez para borrar';
      setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Borrar'; }, 3500);
    } }, 'Borrar');
    return b;
  }
};
views.prof = Prof;


/* =====================================================  SERVICIOS MÍNIMOS  */
const SM = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { S.smWeek = weekStart(todayStr()); $('#main').append(this.el); },
  render() {
    const el = this.el;
    // al marcar una casilla la tabla se repinta: se conserva dónde estaba el desplazamiento
    const oldSc = el.querySelector('.scroll'), keepX = oldSc ? oldSc.scrollLeft : 0, keepY = window.scrollY, keepWk = this._wk;
    el.textContent = '';
    const wk = S.smWeek, doc = S.sm[wk] || { days: {} }, days = doc.days || {};
    const go2 = (d) => { S.smWeek = weekStart(d); refresh(SM); };
    el.append(h('div', { class: 'toolbar' },
      h('button', { class: 'btn ghost', 'aria-label': 'Semana anterior', onclick: () => go2(addDays(wk, -7)) }, icon('chevl')),
      h('input', { type: 'date', id: 'sm-semana', value: wk, 'aria-label': 'Semana', onchange: (e) => { if (e.target.value) go2(e.target.value); } }),
      h('button', { class: 'btn ghost', 'aria-label': 'Semana siguiente', onclick: () => go2(addDays(wk, 7)) }, icon('chevr')),
      h('button', { class: 'btn ghost', onclick: () => go2(todayStr()) }, 'Esta semana'),
      S.sm[addDays(wk, -7)] && !S.sm[wk] ? h('button', { class: 'btn', onclick: () => enqueue(async () => { const c = JSON.parse(JSON.stringify(S.sm[addDays(wk, -7)])); S.sm[wk] = c; renderAll(); await S.db.doc('sm/' + wk).set(c); }) }, 'Copiar la semana anterior') : null));
    el.append(h('h2', { class: 'cap' }, 'Servicios mínimos · semana del ' + fmtShort(wk)));
    el.append(h('p', { class: 'muted small' }, 'Marca qué profesores están de servicios mínimos cada día. Cuando registres una ausencia como huelga, la app solo usará a estas personas para cubrirla.'));
    if (!S.school.teachers.length) return el.append(empty('No hay profesorado cargado', 'Importa antes los horarios en la pestaña Profesorado.', null, 'users'));
    const tbl = h('table', { class: 'sched sm' });
    tbl.append(h('thead', null, h('tr', null, h('th', null, 'Profesor/a'), WD.map((d, i) => h('th', null, WDN[d].slice(0, 3) + ' ' + toDate(addDays(wk, i)).getDate(), h('span', { class: 'time block' }, (days[d] || []).length + ' en SM'))))));
    const body = h('tbody');
    for (const T of sortedTeachers()) {
      body.append(h('tr', null, h('th', null, T.name, h('span', { class: 'time block' }, ROLES[T.role])),
        WD.map((d) => h('td', null, h('input', { type: 'checkbox', class: 'smchk', 'aria-label': T.name + ' ' + WDN[d], checked: (days[d] || []).includes(T.id), onchange: (e) => saveSM(wk, T.id, d, e.target.checked) })))));
    }
    tbl.append(body);
    const sc = h('div', { class: 'scroll' }, tbl);
    el.append(h('div', { class: 'card' }, sc));
    if (keepWk === wk) { sc.scrollLeft = keepX; window.scrollTo(0, keepY); }
    this._wk = wk;
  }
};
views.sm = SM;

/* =====================================================  CENTRO  */
const Centro = {
  el: h('section', { class: 'view', hidden: true }), built: false, deferOnFocus: true,
  build() { $('#main').append(this.el); },
  accessCard() {
    const list = (S.access || []).slice().sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'admin' ? -1 : 1));
    const ta = h('textarea', { rows: 4, 'aria-label': 'Correos a añadir', placeholder: 'maria@colegio.es\njuan@colegio.es\ndirectora@colegio.es, jefatura' });
    const res = h('div', { class: 'pwres' });
    const showPw = (users) => {
      S.pwRes = users; res.textContent = '';
      if (!users.length) return;
      const text = users.map((u) => u.email + '\t' + (u.password || ('(' + u.error + ')'))).join('\n');
      res.append(h('div', { class: 'card inner' }, h('b', null, 'Contraseñas nuevas'),
        h('p', { class: 'muted small' }, 'Cópialas ahora y entrégalas a cada persona: no se pueden volver a ver (puedes generar otra cuando quieras).'),
        h('pre', { class: 'pwlist' }, text),
        h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => printPw(users) }, icon('print'), 'Imprimir / PDF'), h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copiadas'); } catch (e) { toast('Selecciona el texto y cópialo a mano.', true); } } }, 'Copiar'))));
    };
    showPw(S.pwRes || []);
    const gen = async (emails, btn) => {
      if (btn) btn.disabled = true;
      try { showPw(await window.accessApi.passwords(emails)); }
      catch (e) { const m = String((e && e.message) || ''); toast('No se pudieron crear' + (m ? ' (' + m + ')' : '') + '. ' + (/404/.test(m) ? 'La función no está publicada en Vercel.' : /403/.test(m) ? 'Tu cuenta no es de jefatura.' : /500/.test(m) ? 'Revisa la clave del servidor en Vercel.' : ''), true); }
      if (btn) btn.disabled = false;
    };
    const teachersOnly = list.filter((a) => a.role !== 'admin').map((a) => a.id);
    return h('div', { class: 'card' }, h('h3', null, 'Quién puede entrar'),
      h('p', { class: 'muted small' }, 'Solo estos correos pueden abrir la app. Escribe uno por línea; añade “, jefatura” para dar permisos de edición. Asigna a cada correo su nombre: así cada profesor solo ve sus avisos.'),
      list.length ? (() => { const P = S.presence || {}, nIn = list.filter((a) => P[a.id]).length, nPush = list.filter((a) => P[a.id] && P[a.id].push).length;
        return h('p', { class: 'small pres-sum' }, h('b', null, nIn + ' de ' + list.length), ' han entrado en la app · ', h('b', null, nPush), ' con avisos activados. ', h('span', { class: 'muted' }, 'Se actualiza cada vez que alguien abre la app.')); })() : null,
      list.length ? h('div', { class: 'chips col' }, list.map((a) => h('span', { class: 'chip rm' }, a.id, a.role === 'admin' ? h('span', { class: 'role-tag hl' }, 'jefatura') : null,
        (() => { const q = (S.presence || {})[a.id]; return q ? h('span', { class: 'pres ok', title: 'Último acceso' }, timeAgo(q.ts), q.push ? h('span', { class: 'pres-bell', title: 'Avisos activados' }, icon('bell')) : null) : h('span', { class: 'pres no' }, 'Aún no ha entrado'); })(),
        h('select', { class: 'tidsel', 'aria-label': 'Profesor/a de ' + a.id, onchange: (ev) => window.accessApi.setTid(a.id, ev.target.value).then(() => toast('Asignado'), () => toast('No se pudo asignar.', true)) },
          h('option', { value: '' }, '— sin asignar —'), sortedTeachers().map((t) => h('option', { value: t.id, selected: t.id === a.tid }, t.name))),
        h('button', { class: 'btn ghost sm', title: 'Crea o restablece su contraseña', onclick: (ev) => gen([a.id], ev.currentTarget) }, 'Contraseña'),
        a.id === window.accessApi.me() ? null : h('button', { class: 'x', 'aria-label': 'Quitar a ' + a.id, onclick: () => window.accessApi.remove(a.id) }, '×')))) : h('p', { class: 'muted small' }, 'Todavía no hay nadie más.'),
      teachersOnly.length ? h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: (ev) => { const b = ev.currentTarget; if (b.dataset.armed) { b.dataset.armed = ''; b.textContent = 'Generar contraseñas para todo el profesorado'; gen(teachersOnly, b); return; } b.dataset.armed = '1'; b.textContent = 'Pulsa otra vez: se restablecerán las de todos'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Generar contraseñas para todo el profesorado'; }, 4000); } }, 'Generar contraseñas para todo el profesorado')) : null,
      res,
      ta, h('div', { class: 'row-end' }, h('button', { class: 'btn primary', onclick: async () => { const n = await window.accessApi.add(ta.value); ta.value = ''; toast(n + ' correo' + (n === 1 ? '' : 's') + ' añadido' + (n === 1 ? '' : 's')); } }, icon('plus'), 'Añadir')));
  },
  render() {
    const el = this.el; el.textContent = '';
    el.append(h('h2', { class: 'cap' }, 'Centro'));
    // criterio
    el.append(h('div', { class: 'card' }, h('h3', null, 'Cómo reparte la app las sustituciones'),
      h('p', { class: 'muted small' }, 'Se cuenta cuántos profesores faltan ese día (aunque sea en horas distintas) y se cubre con estas fuentes, en este orden:'),
      h('ol', { class: 'steps' },
        h('li', null, h('b', null, '1 ausente: '), 'hora libre, coordinación (COO) y equipo directivo. No se quitan apoyos.'),
        h('li', null, h('b', null, '2 ausentes: '), 'hora libre, coordinación, apoyos (y speaking) y equipo directivo.'),
        h('li', null, h('b', null, '3 o más: '), 'hora libre, coordinación, apoyos (y speaking), PT y AL y, por último, equipo directivo.'),
        h('li', null, h('b', null, 'Plan de apoyo de matemáticas (Belén): '), 'se la trata como una profesora más y se respeta su horario. Solo sustituye en sus horas libres o, en una hora de apoyo, si el grupo al que apoya se queda sin su profesor.'),
        h('li', null, h('b', null, 'Excursiones: '), 'si el grupo de un tutor se va de excursión, los especialistas que ese día daban clase a ese grupo quedan libres y son los primeros en cubrir ausencias que no sean de excursión.'),
        h('li', null, h('b', null, 'Infantil: '), 'si falta un profesor de infantil lo cubre la profesora de apoyo de infantil. Si faltan 2 o más a la vez, entran PT y AL, mejor quien en esa franja ya esté dando clase en infantil (pon “Infantil” o “4 años” en el grupo de su horario).'),
        h('li', null, h('b', null, 'Equipo directivo: '), 'siempre el último nivel, hasta ' + (S.school.maxDir || 2) + ' sustituciones al día cada uno; si no queda nadie más, cubre aunque lo supere. El equipo directivo no cubre el patio. Entre ellos se elige a quien tenga menos carga ese día (clases propias + sustituciones), para que la carga lectiva quede equilibrada.')),
      h('p', { class: 'muted small' }, 'Huelga: cuando una ausencia se marca como huelga, solo la pueden cubrir los profesores marcados como servicios mínimos ese día, con el mismo orden de criterios. El motivo solo lo ves tú.'),
      h('p', { class: 'muted small' }, 'Si en ninguno de los niveles permitidos queda nadie, el equipo directivo la cubre siempre, aunque supere el máximo diario (se marca como “criterio ampliado”). Entre el resto, elige a quien menos ha sustituido en el pasado en proporción a sus huecos y apoyos semanales, así el profesorado de primaria, que tiene más, sustituye más de forma natural y los especialistas (inglés, música, educación física) no quedan cargados. Los recreos se cubren con quien no tenga turno de patio ese día.')));
    // ajustes
    const max = h('input', { type: 'number', id: 'max-dir', min: 0, max: 9, value: S.school.maxDir || 2, onchange: (e) => { const v = Math.max(0, Math.min(9, parseInt(e.target.value, 10) || 0)); saveSchool((s) => { s.maxDir = v; }); } });
    const times = h('div', { class: 'times' }, SLOT_ORDER.map((s) => h('label', { class: 'field' }, h('span', null, slotLabel(s)),
      h('input', { type: 'text', value: sessTime(s), 'aria-label': 'Horario ' + slotLabel(s), onchange: (e) => saveSchool((x) => { x.sessions = x.sessions || {}; x.sessions[s] = e.target.value.trim(); }) }))));
    const mkNum = (id, lbl, val, f) => h('label', { class: 'field short' }, h('span', null, lbl), h('input', { type: 'number', id, min: 0, max: 20, value: val, onchange: (e) => { const v = Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0)); saveSchool((x) => { x[f] = v; }); } }));
    if (window.accessApi) el.append(this.accessCard());
    el.append(h('div', { class: 'card' }, h('h3', null, 'Patios'), h('div', { class: 'row-wrap' }, mkNum('patio-prim', 'Profesores por día en el patio de primaria', S.school.patioPrim || 6, 'patioPrim'), mkNum('patio-inf', 'Profesores por día en el patio de infantil', S.school.patioInf || 5, 'patioInf'))));
    el.append(h('div', { class: 'card' }, h('h3', null, 'Horario de sesiones'), times,
      h('label', { class: 'field short' }, h('span', null, 'Máximo de sustituciones por día de cada miembro del equipo directivo'), max)));
    // compartir
    el.append(h('div', { class: 'card' }, h('h3', null, 'Que el profesorado entre'),
      h('p', null, 'Usa el botón Compartir de esta página e invita a cada profesor/a con permiso de colaborador. Con ese permiso pueden ver sus avisos y escribir en el chat, pero no cambiar horarios ni ausencias. Al entrar por primera vez eligen su nombre en “Mis sustituciones”.')));
    // datos
    const ex = h('button', { class: 'btn', onclick: () => this.loadExample() }, 'Cargar datos de ejemplo');
    const wipe = h('button', { class: 'btn danger', onclick: () => {
      if (wipe.dataset.armed) return this.wipe();
      wipe.dataset.armed = '1'; wipe.textContent = 'Seguro. Pulsa otra vez para borrarlo todo';
      setTimeout(() => { wipe.dataset.armed = ''; wipe.textContent = 'Borrar todos los datos'; }, 4000);
    } }, 'Borrar todos los datos');
    el.append(h('div', { class: 'card' }, h('h3', null, 'Datos'), h('p', { class: 'muted small' }, 'Para probar la app sin tocar los datos reales, carga el ejemplo y bórralo cuando termines.'), h('div', { class: 'row-wrap' }, ex, wipe)));
  },
  loadExample() {
    const E = buildExample(), month = todayStr().slice(0, 7);
    saveSchool((s) => { s.teachers = E.teachers; s.example = true; });
    savePatio(month, (p) => { p.turns = E.turns; p.turnsInf = E.turnsInf; });
    toast('Datos de ejemplo cargados. Prueba a registrar ausencias en Hoy.');
  },
  wipe() {
    enqueue(async () => {
      const db = S.db;
      for (const d of Object.keys(S.days)) {
        try { const m = await db.collection('chats/' + d + '/msgs').get(); for (const x of m.docs) await db.doc('chats/' + d + '/msgs/' + x.id).delete(); } catch (e) {}
        await db.doc('days/' + d).delete();
      }
      for (const m of Object.keys(S.patios)) await db.doc('patios/' + m).delete();
      for (const w of Object.keys(S.sm)) await db.doc('sm/' + w).delete();
      for (const p of Object.keys(S.priv)) await db.doc('private/' + p).delete();
      const all = await db.collection('notifs').get();
      for (const x of all.docs) await db.doc('notifs/' + x.id).delete();
      S.school = DEFAULT_SCHOOL(); S.days = {}; S.patios = {}; S.selT = null; S.chatDate = null;
      await db.doc('school/main').set(S.school);
      renderAll();
      toast('Todos los datos se han borrado.');
    });
  }
};
views.centro = Centro;

/* =====================================================  ARRANQUE  */
async function boot() {
  const main = $('#main');
  const claude = window.claude;
  S.db = claude && claude.use ? await claude.use('db') : null;
  S.user = claude && claude.use ? await claude.use('user') : null;
  if (!S.db) {
    main.append(empty('Entra desde Claude con tu sesión iniciada', 'Esta página guarda los horarios y las sustituciones del centro, y solo funciona abierta desde el enlace compartido con tu cuenta.', null, 'lock'));
    return;
  }
  S.skel = h('div', { id: 'skel' }, skeleton()); main.append(S.skel);
  S.uid = S.user ? await S.user.id() : null;
  S.admin = S.user ? await S.user.canEdit() : false;
  S.canWrite = S.user ? await S.user.can('data.write') : null;
  S.myTid = S.user && S.user.tid ? await S.user.tid() : null;
  // con cuentas propias (Firebase), el profesorado queda ligado a su ficha y no puede elegir otra
  S.locked = !!window.accessApi && !S.admin;
  pingPresence();
  if (S.locked || S.myTid) S.me = S.myTid || null;
  else { try { S.me = localStorage.getItem(LS_ME) || null; } catch (e) {} }
  renderAll();

  const timer = setTimeout(() => { if (!S.loaded.school) toast('Los datos tardan en llegar. Comprueba tu conexión.', true); }, 10000);
  S.db.doc('school/main').onSnapshot((snap) => {
    clearTimeout(timer);
    S.school = snap.exists ? { ...DEFAULT_SCHOOL(), ...snap.data() } : DEFAULT_SCHOOL();
    S.school.sessions = { ...DEFAULT_SESSIONS, ...(S.school.sessions || {}) };
    S.loaded.school = true; renderAll();
  }, () => { S.loaded.school = true; renderAll(); });
  S.db.collection('days').onSnapshot((snap) => {
    S.days = {}; snap.docs.forEach((d) => { S.days[d.id] = d.data(); });
    S.loaded.days = true; renderAll();
    if (S.admin) fixPlanEspecifico();
    if (views.chat.built) refresh(views.chat);
    if (views.panel.built) refresh(views.panel);
  }, () => {});
  S.db.collection('patios').onSnapshot((snap) => {
    S.patios = {}; snap.docs.forEach((d) => { S.patios[d.id] = d.data(); });
    S.loaded.patios = true; renderAll();
  }, () => {});
  S.db.collection('sm').onSnapshot((snap) => {
    S.sm = {}; snap.docs.forEach((d) => { S.sm[d.id] = d.data(); });
    renderAll();
  }, () => {});
  if (S.admin) {
    S.db.collection('private').onSnapshot((snap) => {
      S.priv = {}; snap.docs.forEach((d) => { S.priv[d.id] = d.data(); });
      renderAll();
    }, () => {});
  }
  if (S.uid) {
    S.db.doc('data/users/' + S.uid + '/profile').onSnapshot((snap) => {
      if (!S.locked && !S.myTid && snap.exists && snap.data().tid && snap.data().tid !== S.me) { S.me = snap.data().tid; subscribeNotifs(); renderAll(); }
    }, () => {});
  }
  if (window.accessApi && S.admin) window.accessApi.subscribe((l) => { S.access = l; if (views.centro.built) refresh(views.centro); });
  if (window.presenceApi && S.admin) window.presenceApi.subscribe((o) => { S.presence = o; if (views.centro.built) refresh(views.centro); });
  subscribeNotifs();
}
boot();
