// Comidas de amor — lógica de la app
import { auth, db } from './firebase.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, signOut, reload
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  ref, onValue, get, set, update, push, remove,
  query, orderByKey, startAt, endAt, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

/* ═════════ CONSTANTES ═════════ */
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_FULL = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const DAYS_SHORT = ['Lu','Ma','Mi','Ju','Vi','Sá','Do'];
const TYPES = ['comida','cena','ambos'];
const TYPE_LABEL = { comida: 'Comida', cena: 'Cena', ambos: 'Ambos' };
const TYPE_SHORT = { comida: 'C', cena: 'N', ambos: 'C/N' };
const FILTER_LABEL = { todos: 'Todos', comida: 'Comidas', cena: 'Cenas', ambos: 'Ambos' };
const MAX = { cal: 60, dish: 80, acc: 60 };
const DAY_MS = 864e5;

// Platos iniciales para calendarios NUEVOS (el vuestro llega por migración)
const DEFAULT_DISHES = [
  ['Ensalada de pasta','comida'], ['Fajipizza','cena'], ['Ensaladilla','comida'], ['Tortilla francesa','cena'],
  ['Merluza','comida',['Patatas','Boniato','Arroz']], ['Hamburguesa','ambos',['Patatas de bolsa','Boniato']],
  ['Pasta a la carbonara','comida'], ['Lomo adobado','ambos',['Patatas de bolsa','Nachos con guacamole']],
  ['Lentejas','comida'], ['Potaje de garbanzos','comida'], ['Wrap de pollo','cena'], ['Arroz con pollo','comida'],
  ['Arroz a la cubana','comida',['Salchichas','Huevo frito','Tomate frito']], ['Macarrones con tomate','comida'],
  ['Sándwich','cena',['Tomate aliñado']], ['Fajitas de pollo','ambos'], ['Fuera','ambos',['Tapeo']],
  ['Pizza','cena'], ['Sopa','ambos',['Gyozas','Croquetas']], ['Tortilla de patatas','ambos'],
  ['Lasaña','ambos'], ['Albóndigas','comida',['Tortilla']], ['Bocadillo','ambos']
];

/* ═════════ ESTADO ═════════ */
const S = {
  user: null, calId: null,
  cal: { name: '', ownerId: null, members: {}, invites: {} },
  dishes: {}, menu: {}, menuRange: '',
  weekOffset: 0, monthOffset: 0, dishFilter: 'todos', tab: 'semanal',
  pending: null, pendingDish: null, selectedAccs: [], accOpen: new Set(), modalQuery: ''
};
let calUnsubs = [];
let menuUnsub = null;
let homeLoadId = 0;
const overlayStack = [];

/* ═════════ UTILIDADES ═════════ */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // hora LOCAL
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const getMonday = d => { const r = new Date(d); r.setHours(0, 0, 0, 0); const day = r.getDay(); r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day)); return r; };
const emailKey = e => String(e).trim().toLowerCase().replace(/\./g, ',');
const isValidEmail = e => /^[^\s@#$\[\]\/]+@[^\s@#$\[\]\/]+\.[^\s@#$\[\]\/]+$/.test(e);
const isValidId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const toArr = v => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [])).filter(x => typeof x === 'string' && x.trim());
const byName = (a, b) => a.name.localeCompare(b.name, 'es');
const isOwner = () => !!S.user && S.cal.ownerId === S.user.uid;
const fval = (form, name) => (form.elements.namedItem(name)?.value ?? '').trim();
const isPermissionError = e => /permission/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
const errMsg = e => isPermissionError(e) ? 'No tienes permiso para hacer eso.' : 'Ha ocurrido un error. Inténtalo de nuevo.';

function dishList() {
  return Object.entries(S.dishes || {})
    .filter(([, d]) => d && typeof d.name === 'string')
    .map(([id, d]) => ({ id, name: d.name, type: TYPES.includes(d.type) ? d.type : 'ambos', accompaniments: toArr(d.accompaniments) }));
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}

function setSync(state) {
  const d = $('sync-dot'), t = $('sync-text');
  d.className = 'sync-dot' + (state === 'offline' ? ' offline' : state === 'syncing' ? ' syncing' : '');
  t.textContent = state === 'online' ? 'Sincronizado' : state === 'syncing' ? 'Conectando…' : 'Sin conexión';
}

async function withBusy(btn, label, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await fn(); }
  finally { if (btn?.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

// Re-render conservando lo que el usuario está escribiendo
function rerender(el, html) {
  const keyOf = i => { const f = i.closest('form'); return `${f?.dataset.form ?? ''}:${f?.dataset.id ?? ''}:${i.name}`; };
  const vals = {};
  el.querySelectorAll('input[name]').forEach(i => { if (i.value) vals[keyOf(i)] = i.value; });
  const act = document.activeElement;
  const focusKey = el.contains(act) && act.name ? keyOf(act) : null;
  el.innerHTML = html;
  el.querySelectorAll('input[name]').forEach(i => {
    const k = keyOf(i);
    if (k in vals) i.value = vals[k];
    if (k === focusKey) i.focus();
  });
}

/* ═════════ OVERLAYS ═════════ */
function openOverlay(id) {
  $(id).hidden = false;
  if (!overlayStack.includes(id)) overlayStack.push(id);
}
function closeOverlay(id) {
  const el = $(id); if (!el) return;
  el.hidden = true;
  const i = overlayStack.indexOf(id); if (i >= 0) overlayStack.splice(i, 1);
  if ((id === 'modal' || id === 'acc-modal') && !overlayStack.includes('modal') && !overlayStack.includes('acc-modal')) {
    S.pending = null; S.pendingDish = null; S.selectedAccs = [];
  }
}
const closeAllOverlays = () => [...overlayStack].forEach(closeOverlay);

/* ═════════ AUTH ═════════ */
const AUTH_ERRORS = {
  'auth/invalid-email': 'El email no es válido.',
  'auth/invalid-credential': 'Email o contraseña incorrectos.',
  'auth/user-not-found': 'Email o contraseña incorrectos.',
  'auth/wrong-password': 'Email o contraseña incorrectos.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese email.',
  'auth/weak-password': 'La contraseña es demasiado débil.',
  'auth/password-does-not-meet-requirements': 'La contraseña no cumple los requisitos de seguridad.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet.'
};
const authMsg = e => AUTH_ERRORS[e?.code] || 'Ha ocurrido un error. Inténtalo de nuevo.';
const setAuthError = msg => { $('login-error').textContent = msg; };

// Guardar ?join= para que sobreviva al login y a la verificación
{
  const join = new URLSearchParams(location.search).get('join');
  if (join) { sessionStorage.setItem('pendingJoin', join); history.replaceState(null, '', location.pathname); }
}

onAuthStateChanged(auth, user => {
  teardownCalendar();
  closeAllOverlays();
  S.user = user;
  if (!user) { showLoginTab('login'); showScreen('screen-login'); return; }
  if (!user.emailVerified) { showVerify(); return; }
  showHome();
});

function showLoginTab(tab) {
  document.querySelectorAll('.login-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('login-form').hidden = tab !== 'login';
  $('register-form').hidden = tab !== 'register';
  setAuthError('');
}

function showVerify() {
  $('verify-email').textContent = S.user.email;
  showScreen('screen-verify');
  const flag = 'verifSent_' + S.user.uid;
  if (!sessionStorage.getItem(flag)) {
    sessionStorage.setItem(flag, '1');
    sendEmailVerification(S.user).catch(() => {});
  }
}

/* ═════════ HOME ═════════ */
async function showHome() {
  teardownCalendar();
  $('home-avatar').textContent = (S.user.email || '?')[0].toUpperCase();
  showScreen('screen-home');
  const pj = sessionStorage.getItem('pendingJoin');
  if (pj) {
    sessionStorage.removeItem('pendingJoin');
    if (isValidId(pj)) { await joinCalendar(pj); return; }
    toast('Enlace de invitación no válido');
  }
  loadCalendars();
}

async function loadCalendars() {
  const myLoad = ++homeLoadId;
  const list = $('cal-list');
  list.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const uid = S.user.uid;
    const snap = await get(ref(db, `userCalendars/${uid}`));
    const ids = Object.keys(snap.val() || {}).filter(isValidId);
    const results = await Promise.allSettled(ids.map(async id => {
      const [n, o, m] = await Promise.all(['name', 'ownerId', 'members'].map(k => get(ref(db, `calendars/${id}/${k}`))));
      return { id, name: n.val(), ownerId: o.val(), members: m.val() || {} };
    }));
    if (myLoad !== homeLoadId) return;
    const cals = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.name) cals.push(r.value);
      else if (r.status === 'rejected' && isPermissionError(r.reason)) {
        // Calendario borrado o te han quitado: limpiamos tu índice
        remove(ref(db, `userCalendars/${uid}/${ids[i]}`)).catch(() => {});
      }
    });
    renderCalList(cals.sort(byName));
  } catch (e) {
    console.error(e);
    if (myLoad !== homeLoadId) return;
    list.innerHTML = '<p class="muted">No se han podido cargar los calendarios.</p><button type="button" class="btn-secondary" data-action="reload-home">Reintentar</button>';
  }
}

function renderCalList(cals) {
  const list = $('cal-list');
  if (!cals.length) {
    list.innerHTML = '<div class="empty-state"><div class="e-icon">📅</div><p>Aún no tienes ningún calendario</p><small>Crea uno nuevo o únete con un enlace de invitación</small></div>';
    return;
  }
  list.innerHTML = cals.map(c => {
    const n = Object.keys(c.members).length || 1;
    const owner = c.ownerId === S.user.uid;
    return `<button type="button" class="cal-card" data-action="open-cal" data-id="${esc(c.id)}">
      <span class="cal-icon">🍽️</span>
      <span class="cal-info"><span class="cal-name" style="display:block">${esc(c.name)}</span><span class="cal-meta">${n} miembro${n !== 1 ? 's' : ''}${owner ? ' · Creador' : ''}</span></span>
      <span class="cal-arrow">›</span></button>`;
  }).join('');
}

async function createCalendar(name) {
  name = name.trim().slice(0, MAX.cal);
  if (!name) { toast('Ponle un nombre al calendario'); return; }
  const uid = S.user.uid;
  const id = push(ref(db, 'calendars')).key;
  const dishes = {};
  DEFAULT_DISHES.forEach(([n, type, acc]) => {
    dishes[push(ref(db, `calendars/${id}/dishes`)).key] = acc?.length ? { name: n, type, accompaniments: acc } : { name: n, type };
  });
  // Escritura atómica: calendario + índice del usuario
  await update(ref(db), {
    [`calendars/${id}`]: {
      name, ownerId: uid, createdAt: serverTimestamp(),
      members: { [uid]: { email: S.user.email, role: 'owner' } },
      dishes
    },
    [`userCalendars/${uid}/${id}`]: true
  });
  closeOverlay('newcal');
  openCalendar(id);
}

async function joinCalendar(calId) {
  const uid = S.user.uid;
  // ¿Ya eres miembro? Si puedes leerlo, sí.
  try {
    await get(ref(db, `calendars/${calId}/name`));
    await set(ref(db, `userCalendars/${uid}/${calId}`), true);
    openCalendar(calId);
    return;
  } catch (e) {
    if (!isPermissionError(e)) { toast('Sin conexión. Inténtalo de nuevo.'); loadCalendars(); return; }
  }
  try {
    await update(ref(db), {
      [`calendars/${calId}/members/${uid}`]: { email: S.user.email, role: 'member' },
      [`calendars/${calId}/invites/${emailKey(S.user.email)}`]: null,
      [`userCalendars/${uid}/${calId}`]: true
    });
    toast('¡Te has unido al calendario!');
    openCalendar(calId);
  } catch (e) {
    console.error(e);
    toast('No tienes invitación para este calendario o el enlace no es válido.');
    loadCalendars();
  }
}

/* ═════════ CALENDARIO ═════════ */
function listen(target, cb) {
  const unsub = onValue(target, cb, err => { console.error(err); onCalendarLost(); });
  calUnsubs.push(unsub);
}

function teardownCalendar() {
  calUnsubs.forEach(u => u());
  calUnsubs = [];
  if (menuUnsub) { menuUnsub(); menuUnsub = null; }
  S.calId = null;
  S.menuRange = '';
}

function onCalendarLost() {
  if (!S.calId) return;
  teardownCalendar();
  closeAllOverlays();
  toast('Ya no tienes acceso a este calendario');
  showHome();
}

function openCalendar(id) {
  teardownCalendar();
  closeAllOverlays();
  Object.assign(S, {
    calId: id, cal: { name: '', ownerId: null, members: {}, invites: {} },
    dishes: {}, menu: {}, menuRange: '', weekOffset: 0, monthOffset: 0, dishFilter: 'todos'
  });
  S.accOpen.clear();
  $('app-cal-name').textContent = '…';
  showScreen('screen-app');
  setSync('syncing');

  const base = `calendars/${id}`;
  let connectedOnce = false;
  calUnsubs.push(onValue(ref(db, '.info/connected'), s => {
    if (s.val()) { connectedOnce = true; setSync('online'); } else setSync(connectedOnce ? 'offline' : 'syncing');
  }));
  listen(ref(db, `${base}/name`), s => {
    S.cal.name = s.val() || '';
    $('app-cal-name').textContent = S.cal.name;
    if (S.tab === 'ajustes') renderSettings();
  });
  listen(ref(db, `${base}/ownerId`), s => { S.cal.ownerId = s.val(); if (S.tab === 'ajustes') renderSettings(); });
  listen(ref(db, `${base}/members`), s => {
    S.cal.members = s.val() || {};
    if (!S.cal.members[S.user.uid]) { onCalendarLost(); return; }
    if (S.tab === 'ajustes') renderSettings();
  });
  listen(ref(db, `${base}/invites`), s => { S.cal.invites = s.val() || {}; if (S.tab === 'ajustes') renderSettings(); });
  listen(ref(db, `${base}/dishes`), s => {
    S.dishes = s.val() || {};
    if (S.tab === 'platos') renderDishList();
    if (!$('modal').hidden) renderModalList();
  });
  switchTab('semanal');
}

// Solo descarga el rango de fechas visible
function watchMenu(start, end) {
  const key = `${start}|${end}`;
  if (S.menuRange === key || !S.calId) return;
  if (menuUnsub) menuUnsub();
  S.menuRange = key;
  S.menu = {};
  const calId = S.calId;
  menuUnsub = onValue(
    query(ref(db, `calendars/${calId}/menu`), orderByKey(), startAt(start), endAt(end)),
    s => {
      if (S.calId !== calId) return;
      S.menu = s.val() || {};
      if (S.tab === 'semanal') renderWeek(); else if (S.tab === 'mensual') renderMonth();
    },
    err => { console.error(err); onCalendarLost(); }
  );
}

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#screen-app .tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('#screen-app .section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  ({ semanal: renderWeek, mensual: renderMonth, platos: renderDishes, ajustes: renderSettings })[tab]?.();
}

/* ═════════ SEMANA ═════════ */
function renderWeek() {
  const today = startOfToday(), todayKey = dateKey(today);
  const monday = addDays(getMonday(today), S.weekOffset * 7);
  const sunday = addDays(monday, 6);
  watchMenu(dateKey(monday), dateKey(sunday));
  const fmt = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

  let html = `<div class="week-nav">
    <button type="button" data-action="week" data-dir="-1" aria-label="Semana anterior">&#8592;</button>
    <span class="week-label">${fmt(monday)} – ${fmt(sunday)}</span>
    <button type="button" data-action="week" data-dir="1" aria-label="Semana siguiente">&#8594;</button></div>`;
  if (S.weekOffset !== 0) html += '<button type="button" class="today-btn" data-action="week-today">Volver a esta semana</button>';

  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i), dk = dateKey(d);
    const isToday = dk === todayKey, wknd = i >= 5;
    html += `<div class="day-card${isToday ? ' today' : ''}${wknd ? ' weekend' : ''}">
      <div class="day-name">${DAYS_FULL[i]} ${d.getDate()}${isToday ? '<span class="today-dot"></span>' : ''}</div>
      <div class="meal-row">
        <div><div class="meal-label">Mediodía</div>${slotHtml(dk, 'comida')}</div>
        <div><div class="meal-label">Noche</div>${slotHtml(dk, 'cena')}</div>
      </div></div>`;
  }
  $('tab-semanal').innerHTML = html;
}

function slotHtml(dk, slot) {
  const v = S.menu[dk]?.[slot];
  if (v?.name) {
    const acc = toArr(v.acc);
    return `<div class="meal-slot filled">
      <button type="button" class="meal-main" data-action="pick-slot" data-date="${dk}" data-slot="${slot}">
        <span class="meal-name">${esc(v.name)}</span>${acc.length ? `<span class="meal-accompaniment">con ${esc(acc.join(', '))}</span>` : ''}
      </button>
      <button type="button" class="meal-clear" data-action="clear-slot" data-date="${dk}" data-slot="${slot}" aria-label="Quitar plato">&#10005;</button></div>`;
  }
  return `<button type="button" class="meal-slot" data-action="pick-slot" data-date="${dk}" data-slot="${slot}"><span class="meal-empty-text">+ Añadir</span></button>`;
}

/* ═════════ MES ═════════ */
function renderMonth() {
  const today = startOfToday(), todayKey = dateKey(today);
  const base = new Date(today.getFullYear(), today.getMonth() + S.monthOffset, 1);
  const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  watchMenu(dateKey(base), dateKey(new Date(base.getFullYear(), base.getMonth(), dim)));

  let cells = DAYS_SHORT.map((d, i) => `<div class="month-hdr${i >= 5 ? ' wknd' : ''}">${d}</div>`).join('');
  cells += '<div class="month-day blank"></div>'.repeat((base.getDay() + 6) % 7);
  for (let d = 1; d <= dim; d++) {
    const date = new Date(base.getFullYear(), base.getMonth(), d);
    const dk = dateKey(date), dow = date.getDay(), e = S.menu[dk] || {};
    cells += `<button type="button" class="month-day${dk === todayKey ? ' today' : ''}${dow === 0 || dow === 6 ? ' weekend' : ''}" data-action="goto-day" data-date="${dk}" aria-label="${d} de ${MONTHS[base.getMonth()]}">
      <span class="month-day-num">${d}</span>
      ${e.comida?.name ? `<span class="month-meal"><b>M </b>${esc(e.comida.name)}</span>` : ''}
      ${e.cena?.name ? `<span class="month-meal"><b>N </b>${esc(e.cena.name)}</span>` : ''}</button>`;
  }
  $('tab-mensual').innerHTML = `<div class="week-nav">
      <button type="button" data-action="month" data-dir="-1" aria-label="Mes anterior">&#8592;</button>
      <span class="week-label">${MONTHS[base.getMonth()]} ${base.getFullYear()}</span>
      <button type="button" data-action="month" data-dir="1" aria-label="Mes siguiente">&#8594;</button></div>
    ${S.monthOffset !== 0 ? '<button type="button" class="today-btn" data-action="month-today">Volver a este mes</button>' : ''}
    <div class="month-outer"><div class="month-grid">${cells}</div></div>
    <p class="hint">Toca un día para editar esa semana</p>`;
}

/* ═════════ PLATOS ═════════ */
function renderDishes() {
  $('tab-platos').innerHTML = `
    <form class="add-row" data-form="add-dish">
      <input type="text" name="name" maxlength="${MAX.dish}" placeholder="Nuevo plato..." aria-label="Nombre del plato" required/>
      <select name="type" aria-label="Tipo"><option value="comida">Comida</option><option value="cena">Cena</option><option value="ambos">Ambos</option></select>
      <button type="submit">+ Añadir</button>
    </form>
    <div class="list-controls">${Object.keys(FILTER_LABEL).map(f =>
      `<button type="button" class="filter-btn${S.dishFilter === f ? ' active' : ''}" data-action="dish-filter" data-filter="${f}">${FILTER_LABEL[f]}</button>`).join('')}</div>
    <div id="dish-list"></div>`;
  renderDishList();
}

function renderDishList() {
  const list = $('dish-list'); if (!list) return;
  const items = dishList().filter(d => S.dishFilter === 'todos' || d.type === S.dishFilter).sort(byName);
  if (!items.length) { list.innerHTML = '<p class="muted">No hay platos en esta categoría.</p>'; return; }
  rerender(list, items.map(d => {
    const open = S.accOpen.has(d.id);
    const tags = d.accompaniments.map(a =>
      `<span class="acc-tag">${esc(a)}<button type="button" data-action="remove-acc" data-id="${esc(d.id)}" data-acc="${esc(a)}" aria-label="Quitar ${esc(a)}">&#10005;</button></span>`).join('');
    return `<div class="dish-item">
      <div class="dish-info">
        <div class="dish-name-row"><span class="badge badge-${d.type}">${TYPE_LABEL[d.type]}</span>${esc(d.name)}</div>
        <div class="dish-acc-list">${tags}</div>
        ${open ? `<form class="acc-add-row" data-form="add-acc" data-id="${esc(d.id)}"><input type="text" name="acc" maxlength="${MAX.acc}" placeholder="Acompañamiento..." aria-label="Nuevo acompañamiento" required/><button type="submit">+</button></form>` : ''}
      </div>
      <div class="dish-actions">
        <button type="button" class="dish-del" data-action="delete-dish" data-id="${esc(d.id)}">Eliminar</button>
        <button type="button" class="acc-toggle" data-action="toggle-acc" data-id="${esc(d.id)}">${open ? 'Listo' : '+ Acomp.'}</button>
      </div></div>`;
  }).join(''));
}

/* ═════════ AJUSTES ═════════ */
const inviteLink = () => `${location.origin}${location.pathname}?join=${S.calId}`;

function renderSettings() {
  const sec = $('tab-ajustes'); if (!sec || !S.calId) return;
  const me = S.user.uid, owner = isOwner();
  const members = Object.entries(S.cal.members || {})
    .map(([uid, m]) => ({ uid, email: m?.email || '', role: m?.role }))
    .sort((a, b) => a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.email.localeCompare(b.email));
  const invites = Object.entries(S.cal.invites || {}).map(([key, v]) => ({ key, email: v?.email || key.replace(/,/g, '.') }));

  let html = '';
  if (owner) html += `<div class="settings-label">Nombre</div>
    <form class="invite-row" data-form="rename"><input type="text" name="name" maxlength="${MAX.cal}" value="${esc(S.cal.name)}" aria-label="Nombre del calendario" required/><button type="submit">Guardar</button></form>`;

  html += `<div class="settings-label">Miembros</div><div class="settings-card">${members.map(m => `
    <div class="settings-row"><div class="settings-row-info">
      <div class="settings-row-title">${esc(m.email)}${m.uid === me ? ' (tú)' : ''}</div>
      <div class="settings-row-sub">${m.role === 'owner' ? 'Creador' : 'Miembro'}</div></div>
      ${owner && m.uid !== me && m.role !== 'owner' ? `<button type="button" class="settings-row-action" data-action="remove-member" data-uid="${esc(m.uid)}">Quitar</button>` : ''}
    </div>`).join('')}</div>`;

  html += `<div class="settings-label">Invitar</div>
    <form class="invite-row" data-form="invite"><input type="email" name="email" placeholder="Email del invitado..." autocomplete="off" aria-label="Email del invitado" required/><button type="submit">Invitar</button></form>`;

  if (invites.length) html += `<div class="settings-label">Invitaciones pendientes</div><div class="settings-card">${invites.map(i => `
    <div class="settings-row"><div class="settings-row-info"><div class="settings-row-title">${esc(i.email)}</div></div>
    <button type="button" class="settings-row-action" data-action="revoke-invite" data-key="${esc(i.key)}">Revocar</button></div>`).join('')}</div>`;

  html += `<div class="settings-card"><div class="settings-row">
    <div class="settings-row-icon">🔗</div>
    <div class="settings-row-info"><div class="settings-row-title">Enlace de invitación</div><div class="settings-row-sub">Solo funciona con emails invitados y verificados</div></div>
    <button type="button" class="settings-row-action" data-action="copy-link">Copiar</button></div></div>`;

  html += owner
    ? '<div class="settings-label">Zona de peligro</div><button type="button" class="danger-btn" data-action="delete-cal">Eliminar este calendario</button>'
    : '<div class="settings-label">Zona de peligro</div><button type="button" class="danger-btn" data-action="leave-cal">Abandonar este calendario</button>';

  rerender(sec, html);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('¡Enlace copiado!'); }
  catch { window.prompt('Copia este enlace:', text); }
}

/* ═════════ SELECCIÓN DE PLATO ═════════ */
function openPicker(dk, slot) {
  S.pending = { dk, slot };
  S.modalQuery = '';
  const d = parseKey(dk);
  $('modal-title').textContent = slot === 'comida' ? '¿Qué coméis?' : '¿Qué cenáis?';
  $('modal-sub').textContent = `${DAYS_FULL[(d.getDay() + 6) % 7]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  $('modal-search').value = '';
  renderModalList();
  openOverlay('modal');
  $('modal-list').scrollTop = 0;
}

function renderModalList() {
  const p = S.pending; if (!p) return;
  const raw = S.modalQuery.trim(), q = norm(raw);
  const all = dishList();
  const current = S.menu[p.dk]?.[p.slot]?.name;
  const items = all.filter(d => (d.type === p.slot || d.type === 'ambos') && (!q || norm(d.name).includes(q))).sort(byName);
  let html = items.map(d => `
    <button type="button" class="modal-dish${d.name === current ? ' current' : ''}" data-action="choose-dish" data-id="${esc(d.id)}">
      <span class="badge badge-${d.type}">${TYPE_SHORT[d.type]}</span>
      <span class="modal-dish-name">${esc(d.name)}</span>
      ${d.accompaniments.length ? '<span class="modal-dish-extra">+ acomp.</span>' : ''}</button>`).join('');
  if (raw && !all.some(d => norm(d.name) === q)) {
    html += `<button type="button" class="modal-dish modal-dish-new" data-action="quick-add-dish">+ Añadir «${esc(raw.slice(0, MAX.dish))}» como plato nuevo</button>`;
  }
  $('modal-list').innerHTML = html || '<p class="muted">No hay platos para este tipo. Añádelos en la pestaña Platos.</p>';
}

function renderAccModal() {
  const d = S.pendingDish; if (!d) return;
  $('acc-modal-title').textContent = `Acompañamiento para ${d.name}`;
  $('acc-modal-list').innerHTML = d.accompaniments.map(a => {
    const on = S.selectedAccs.includes(a);
    return `<button type="button" class="acc-modal-item${on ? ' selected' : ''}" aria-pressed="${on}" data-action="toggle-acc-choice" data-acc="${esc(a)}">${esc(a)}</button>`;
  }).join('');
}

function commitDish(p, name, accs) {
  if (!p || !S.calId) return;
  const value = accs.length ? { name, acc: accs } : { name };
  set(ref(db, `calendars/${S.calId}/menu/${p.dk}/${p.slot}`), value).catch(e => toast(errMsg(e)));
}

/* ═════════ ACCIONES (delegación de eventos) ═════════ */
const ACTIONS = {
  // Login
  'login-tab': ds => showLoginTab(ds.tab),
  'reset-pass': async () => {
    const email = $('login-email').value.trim();
    if (!email) { setAuthError('Escribe tu email primero.'); return; }
    try { await sendPasswordResetEmail(auth, email); }
    catch (e) { if (['auth/invalid-email', 'auth/too-many-requests', 'auth/network-request-failed'].includes(e.code)) { setAuthError(authMsg(e)); return; } }
    setAuthError('');
    toast('Si existe una cuenta con ese email, recibirás un enlace para cambiar la contraseña.');
  },
  'verify-check': (ds, el) => withBusy(el, 'Comprobando…', async () => {
    await reload(auth.currentUser);
    if (auth.currentUser.emailVerified) {
      await auth.currentUser.getIdToken(true); // refresca el token para las reglas
      S.user = auth.currentUser;
      showHome();
    } else toast('Todavía no aparece verificado. Revisa tu correo (y el spam).');
  }),
  'verify-resend': (ds, el) => withBusy(el, 'Enviando…', async () => {
    try { await sendEmailVerification(auth.currentUser); toast('Email reenviado'); }
    catch (e) { toast(authMsg(e)); }
  }),
  'logout': () => { teardownCalendar(); closeAllOverlays(); return signOut(auth); },

  // Home
  'open-usermenu': () => { $('usermenu-email').textContent = S.user.email; openOverlay('usermenu'); },
  'new-cal': () => { openOverlay('newcal'); setTimeout(() => $('newcal-name').focus(), 50); },
  'open-cal': ds => { if (isValidId(ds.id)) openCalendar(ds.id); },
  'reload-home': () => loadCalendars(),
  'go-home': () => showHome(),

  // Navegación
  'tab': ds => switchTab(ds.tab),
  'week': ds => { S.weekOffset += Number(ds.dir); renderWeek(); },
  'week-today': () => { S.weekOffset = 0; renderWeek(); },
  'month': ds => { S.monthOffset += Number(ds.dir); renderMonth(); },
  'month-today': () => { S.monthOffset = 0; renderMonth(); },
  'goto-day': ds => {
    const target = getMonday(parseKey(ds.date)), cur = getMonday(startOfToday());
    S.weekOffset = Math.round((target - cur) / (7 * DAY_MS));
    switchTab('semanal');
  },

  // Casillas
  'pick-slot': ds => openPicker(ds.date, ds.slot),
  'clear-slot': ds => remove(ref(db, `calendars/${S.calId}/menu/${ds.date}/${ds.slot}`)),
  'choose-dish': ds => {
    const d = dishList().find(x => x.id === ds.id), p = S.pending;
    if (!d || !p) return;
    if (d.accompaniments.length) {
      const cur = S.menu[p.dk]?.[p.slot];
      S.pendingDish = d;
      S.selectedAccs = cur?.name === d.name ? toArr(cur.acc).filter(a => d.accompaniments.includes(a)) : [];
      renderAccModal();
      openOverlay('acc-modal');
      closeOverlay('modal');
    } else {
      closeOverlay('modal');
      commitDish(p, d.name, []);
    }
  },
  'quick-add-dish': () => {
    const p = S.pending, name = S.modalQuery.trim().slice(0, MAX.dish);
    if (!p || !name) return;
    if (!dishList().some(d => norm(d.name) === norm(name))) {
      push(ref(db, `calendars/${S.calId}/dishes`), { name, type: p.slot }).catch(e => toast(errMsg(e)));
    }
    closeOverlay('modal');
    commitDish(p, name, []);
  },
  'toggle-acc-choice': ds => {
    const a = ds.acc;
    S.selectedAccs = S.selectedAccs.includes(a) ? S.selectedAccs.filter(x => x !== a) : [...S.selectedAccs, a];
    renderAccModal();
  },
  'acc-none': () => { const p = S.pending, d = S.pendingDish; closeOverlay('acc-modal'); if (p && d) commitDish(p, d.name, []); },
  'acc-confirm': () => { const p = S.pending, d = S.pendingDish, accs = [...S.selectedAccs]; closeOverlay('acc-modal'); if (p && d) commitDish(p, d.name, accs); },
  'close': ds => closeOverlay(ds.target),

  // Platos
  'dish-filter': ds => { S.dishFilter = ds.filter; renderDishes(); },
  'delete-dish': ds => {
    const d = dishList().find(x => x.id === ds.id); if (!d) return;
    if (!confirm(`¿Eliminar "${d.name}"? Los días ya planificados no cambian.`)) return;
    S.accOpen.delete(d.id);
    return remove(ref(db, `calendars/${S.calId}/dishes/${d.id}`));
  },
  'toggle-acc': ds => { S.accOpen.has(ds.id) ? S.accOpen.delete(ds.id) : S.accOpen.add(ds.id); renderDishList(); },
  'remove-acc': ds => {
    const d = dishList().find(x => x.id === ds.id); if (!d) return;
    const next = d.accompaniments.filter(a => a !== ds.acc);
    return set(ref(db, `calendars/${S.calId}/dishes/${d.id}/accompaniments`), next.length ? next : null);
  },

  // Ajustes
  'copy-link': () => copyText(inviteLink()),
  'revoke-invite': ds => remove(ref(db, `calendars/${S.calId}/invites/${ds.key}`)).then(() => toast('Invitación revocada')),
  'remove-member': ds => {
    const m = S.cal.members[ds.uid]; if (!m) return;
    if (!confirm(`¿Quitar a ${m.email} del calendario?`)) return;
    return remove(ref(db, `calendars/${S.calId}/members/${ds.uid}`)).then(() => toast('Miembro eliminado'));
  },
  'delete-cal': async () => {
    if (!isOwner()) return;
    if (!confirm(`¿Eliminar "${S.cal.name}" y todo su contenido? No se puede deshacer.`)) return;
    const id = S.calId, uid = S.user.uid;
    teardownCalendar();
    try { await update(ref(db), { [`calendars/${id}`]: null, [`userCalendars/${uid}/${id}`]: null }); toast('Calendario eliminado'); }
    catch (e) { toast(errMsg(e)); }
    showHome();
  },
  'leave-cal': async () => {
    if (!confirm('¿Abandonar este calendario?')) return;
    const id = S.calId, uid = S.user.uid;
    teardownCalendar();
    try { await update(ref(db), { [`calendars/${id}/members/${uid}`]: null, [`userCalendars/${uid}/${id}`]: null }); }
    catch (e) { toast(errMsg(e)); }
    showHome();
  }
};

const FORMS = {
  'login': async f => {
    const email = fval(f, 'email'), pass = f.elements.namedItem('password').value;
    if (!email || !pass) { setAuthError('Rellena todos los campos.'); return; }
    setAuthError('');
    await withBusy(f.querySelector('[type=submit]'), 'Entrando…', () =>
      signInWithEmailAndPassword(auth, email, pass).catch(e => setAuthError(authMsg(e))));
  },
  'register': async f => {
    const email = fval(f, 'email'), pass = f.elements.namedItem('password').value;
    if (!email || !pass) { setAuthError('Rellena todos los campos.'); return; }
    if (pass.length < 8) { setAuthError('La contraseña debe tener al menos 8 caracteres.'); return; }
    setAuthError('');
    await withBusy(f.querySelector('[type=submit]'), 'Creando cuenta…', async () => {
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        sessionStorage.setItem('verifSent_' + cred.user.uid, '1');
        await sendEmailVerification(cred.user);
      } catch (e) { setAuthError(authMsg(e)); }
    });
  },
  'new-cal': f => withBusy(f.querySelector('[type=submit]'), 'Creando…', async () => {
    await createCalendar(fval(f, 'name'));
    f.reset();
  }),
  'add-dish': async f => {
    const name = fval(f, 'name').slice(0, MAX.dish), type = fval(f, 'type');
    if (!name || !TYPES.includes(type)) return;
    if (dishList().some(d => norm(d.name) === norm(name))) { toast('Ese plato ya existe'); return; }
    f.elements.namedItem('name').value = '';
    await push(ref(db, `calendars/${S.calId}/dishes`), { name, type });
    toast(`«${name}» añadido`);
  },
  'add-acc': async f => {
    const input = f.elements.namedItem('acc');
    const value = input.value.trim().slice(0, MAX.acc);
    const d = dishList().find(x => x.id === f.dataset.id);
    if (!value || !d) return;
    if (d.accompaniments.some(a => norm(a) === norm(value))) { toast('Ese acompañamiento ya existe'); return; }
    input.value = '';
    await set(ref(db, `calendars/${S.calId}/dishes/${d.id}/accompaniments`), [...d.accompaniments, value]);
  },
  'invite': async f => {
    const email = fval(f, 'email').toLowerCase();
    if (!isValidEmail(email)) { toast('Introduce un email válido'); return; }
    if (Object.values(S.cal.members || {}).some(m => (m?.email || '').toLowerCase() === email)) { toast('Esa persona ya es miembro'); return; }
    await set(ref(db, `calendars/${S.calId}/invites/${emailKey(email)}`), { email, by: S.user.uid, at: serverTimestamp() });
    f.reset();
    toast(`Invitación guardada. Envía el enlace a ${email}`);
  },
  'rename': async f => {
    const name = fval(f, 'name').slice(0, MAX.cal);
    if (!name) return;
    await set(ref(db, `calendars/${S.calId}/name`), name);
    toast('Nombre actualizado');
  }
};

function runSafe(fn, ...args) {
  try {
    const r = fn(...args);
    if (r && typeof r.then === 'function') r.catch(e => { console.error(e); toast(errMsg(e)); });
  } catch (e) { console.error(e); toast(errMsg(e)); }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const action = el.dataset.action;
  if (action === 'backdrop') { if (e.target === el) closeOverlay(el.id); return; }
  const fn = ACTIONS[action];
  if (fn) runSafe(fn, el.dataset, el);
});

document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const fn = FORMS[f.dataset.form];
  if (fn) runSafe(fn, f);
});

document.addEventListener('input', e => {
  if (e.target.id === 'modal-search') { S.modalQuery = e.target.value; renderModalList(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && overlayStack.length) closeOverlay(overlayStack[overlayStack.length - 1]);
});