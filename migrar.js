import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import { ref, push, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

const $ = id => document.getElementById(id);
const TYPES = ['comida', 'cena', 'ambos'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const LEGACY_KEY = /^(\d{4}-\d{2}-\d{2})_(comida|cena)(_acc)?$/;
let user = null, plan = null;

const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const toArr = v => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])).filter(x => typeof x === 'string' && x.trim());
const utc = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const shiftKey = (k, n) => { const d = utc(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const label = k => { const d = utc(k); return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; };
const log = msg => { $('log').textContent += msg + '\n'; };

onAuthStateChanged(auth, u => {
  user = u;
  const s = $('session');
  $('btn-analyze').disabled = !(u && u.emailVerified);
  if (!u) s.innerHTML = 'No has iniciado sesión. <a href="/">Abre la app</a>, entra con tu cuenta y vuelve a esta página.';
  else if (!u.emailVerified) s.textContent = `Sesión: ${u.email}. Verifica tu email en la app antes de migrar.`;
  else s.textContent = `Sesión iniciada como ${u.email}. El calendario migrado será tuyo.`;
});

function extract(json) {
  if (json?.dishes && json?.menu) return json;
  const cal = json?.calendars && Object.values(json.calendars).find(c => c?.menu && c?.dishes);
  if (cal) return cal;
  throw new Error('No encuentro "dishes" y "menu" en el JSON.');
}

function buildPlan(src, shift) {
  const dishes = [], seen = new Set();
  for (const d of (Array.isArray(src.dishes) ? src.dishes : Object.values(src.dishes || {}))) {
    const name = clean(d?.name, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const type = TYPES.includes(d.type) ? d.type : 'ambos';
    const acc = toArr(d.accompaniments).map(a => clean(a, 60)).filter(Boolean);
    dishes.push(acc.length ? { name, type, accompaniments: acc } : { name, type });
  }
  const menu = {}, skipped = [];
  for (const [k, v] of Object.entries(src.menu || {})) {
    const m = k.match(LEGACY_KEY);
    if (!m) { skipped.push(k); continue; }
    const date = shift ? shiftKey(m[1], 1) : m[1];
    menu[date] ??= {};
    menu[date][m[2]] ??= {};
    if (m[3]) {
      const acc = toArr(v).map(a => clean(a, 60)).filter(Boolean);
      if (acc.length) menu[date][m[2]].acc = acc;
    } else if (v?.name) menu[date][m[2]].name = clean(v.name, 80);
  }
  for (const d of Object.keys(menu)) {
    for (const s of Object.keys(menu[d])) if (!menu[d][s].name) delete menu[d][s];
    if (!Object.keys(menu[d]).length) delete menu[d];
  }
  return { dishes, menu, skipped };
}

$('btn-analyze').addEventListener('click', () => {
  $('log').textContent = ''; $('preview').hidden = true; plan = null;
  let json;
  try { json = JSON.parse($('json').value); } catch { log('❌ El texto no es un JSON válido.'); return; }
  try { plan = buildPlan(extract(json), $('shift').checked); } catch (e) { log('❌ ' + e.message); return; }
  const dates = Object.keys(plan.menu).sort();
  if (!dates.length) { log('❌ No hay entradas de menú válidas.'); return; }
  const slots = dates.reduce((n, d) => n + Object.keys(plan.menu[d]).length, 0);
  $('summary').textContent = `${plan.dishes.length} platos · ${dates.length} días · ${slots} comidas/cenas · del ${label(dates[0])} al ${label(dates.at(-1))}`;

  const table = $('sample');
  table.replaceChildren();
  const head = table.insertRow();
  ['Día', 'Mediodía', 'Noche'].forEach(t => { const th = document.createElement('th'); th.textContent = t; head.appendChild(th); });
  for (const d of dates.slice(-7)) {
    const row = table.insertRow();
    const fmt = s => s ? s.name + (s.acc ? ` (con ${s.acc.join(', ')})` : '') : '—';
    [label(d), fmt(plan.menu[d].comida), fmt(plan.menu[d].cena)].forEach(t => { row.insertCell().textContent = t; });
  }
  if (plan.skipped.length) log(`⚠️ ${plan.skipped.length} claves ignoradas: ${plan.skipped.slice(0, 5).join(', ')}`);
  $('preview').hidden = false;
});

$('btn-run').addEventListener('click', async () => {
  if (!plan || !user) return;
  if (localStorage.getItem('comidas-migrado') && !confirm('Ya ejecutaste la migración en este navegador. ¿Crear otro calendario igualmente?')) return;
  const btn = $('btn-run');
  btn.disabled = true; btn.textContent = 'Migrando…';
  try {
    await user.getIdToken(true); // token con email_verified actualizado
    const uid = user.uid;
    const id = push(ref(db, 'calendars')).key;
    const dishes = {};
    for (const d of plan.dishes) dishes[push(ref(db, `calendars/${id}/dishes`)).key] = d;
    const name = clean($('cal-name').value, 60) || 'Comidas de amor ❤️';
    await update(ref(db), {
      [`calendars/${id}`]: {
        name, ownerId: uid, createdAt: serverTimestamp(),
        members: { [uid]: { email: user.email, role: 'owner' } },
        dishes, menu: plan.menu
      },
      [`userCalendars/${uid}/${id}`]: true
    });
    localStorage.setItem('comidas-migrado', id);
    log(`✅ Calendario creado (${id}).`);
    btn.textContent = '✅ Completado';
    $('done').hidden = false;
  } catch (e) {
    console.error(e);
    log('❌ Error: ' + (e.message || e) + '\n¿Has publicado las reglas nuevas y verificado tu email?');
    btn.disabled = false; btn.textContent = 'Reintentar';
  }
});