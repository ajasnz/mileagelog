/* MileageLog – SPA */
'use strict';

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  user:     null,
  vehicles: [],
  trips:    [],
  page:     'dashboard',
  filters:  { vehicle_id: '', from: '', to: '', trip_type: '' },
  lastVehicleId: null,
};
let authStatus = { registrations_open: true };

// ── On-device cache (instant render of previously-seen data) ─────────────────
function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem('ml_' + key)); } catch (_) { return null; }
}
function cacheSet(key, val) {
  try { localStorage.setItem('ml_' + key, JSON.stringify(val)); } catch (_) {}
}

// ── API helper ────────────────────────────────────────────────────────────────
const API = 'api.php';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(API + '/' + path, opts);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  } catch (e) {
    if (!res.ok) throw new Error(text.slice(0, 200) || 'Request failed');
    throw e;
  }
}

// ── Offline queue (IndexedDB) ─────────────────────────────────────────────────
let idbPromise;
function getIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((res, rej) => {
    const req = indexedDB.open('mileagelog', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e);
  });
  return idbPromise;
}
async function queueTrip(trip) {
  const db = await getIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({ trip, ts: Date.now() });
    tx.oncomplete = res; tx.onerror = rej;
  });
}
async function flushQueue() {
  const db    = await getIdb();
  const items = await new Promise((res, rej) => {
    const tx  = db.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = rej;
  });
  for (const item of items) {
    try {
      await api('POST', 'trips', item.trip);
      await new Promise((res, rej) => {
        const tx = db.transaction('queue', 'readwrite');
        tx.objectStore('queue').delete(item.id);
        tx.oncomplete = res; tx.onerror = rej;
      });
    } catch (_) {}
  }
}
window.addEventListener('online', () => flushQueue().then(() => state.page === 'trips' && loadTrips()));

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success', duration = 2800) {
  const c = document.getElementById('toasts') || (() => {
    const el = document.createElement('div');
    el.id = 'toasts'; el.className = 'toast-container';
    document.body.appendChild(el); return el;
  })();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'error' ? '✕' : '✓'}</span><span>${escHtml(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
const icon  = (d, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const iconHome     = () => icon('<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>');
const iconList     = () => icon('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>');
const iconCar      = () => icon('<path d="M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v9a2 2 0 01-2 2h-1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>');
const iconChart    = () => icon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>');
const iconPlus     = () => icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>');
const iconEdit     = () => icon('<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>');
const iconTrash    = () => icon('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>');
const iconBack     = () => icon('<polyline points="15 18 9 12 15 6"/>');
const iconClock    = () => icon('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>');
const iconDownload = () => icon('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
const iconUser     = () => icon('<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>');
const iconLogout   = () => icon('<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>');
const iconShield   = () => icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>');
const iconDollar   = () => icon('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>');
const iconBriefcase= () => icon('<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>');
const iconSettings = () => icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>');

// ── Render helpers ────────────────────────────────────────────────────────────
function setHtml(html) { document.getElementById('app').innerHTML = html; }
function fmt(km) {
  const n = parseFloat(km);
  return isNaN(n) ? '—' : (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)) + ' km';
}
function fmtCur(v) { return '$' + parseFloat(v || 0).toFixed(2); }
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${parseInt(day)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]} ${y}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s ?? '').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const FUEL_LABELS = { petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Hybrid', ev: 'EV' };

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  historyInit();
  try {
    const { user } = await api('GET', 'auth/me');
    if (user) {
      state.user = user;
      // Hydrate instantly from on-device cache so the UI isn't blank while we fetch
      const cv = cacheGet('vehicles'), ct = cacheGet('trips_default'), cd = cacheGet('dash'), cr = cacheGet('report_default');
      if (cv) state.vehicles = cv;
      if (ct) state.trips = ct;
      if (cd) dashData = cd;
      if (cr) reportData = cr;
      if (cv || cd) renderApp();
      await Promise.all([loadVehicles(), loadDashboardData(), loadReport()]);
      renderApp();
      handleShortcut();
    } else {
      await loadAuthStatus();
      renderAuth();
    }
  } catch (_) {
    await loadAuthStatus();
    renderAuth();
  }
}

// ── Home-screen shortcuts (long-press the app icon) ───────────────────────────
function handleShortcut() {
  const shortcut = new URLSearchParams(location.search).get('shortcut');
  if (!shortcut) return;
  history.replaceState(history.state, '', location.pathname);

  if (shortcut === 'start-trip') {
    openStartTrip();
  } else if (shortcut === 'end-trip') {
    const pending = state.trips.filter(t => t.status === 'pending');
    if (pending.length === 1) {
      openEndTrip(pending[0].id);
    } else {
      navigate('trips');
      if (pending.length === 0) toast('No trip in progress to end', 'error');
    }
  }
}

async function loadAuthStatus() {
  try { authStatus = await api('GET', 'auth/status'); } catch (_) {}
}

async function loadVehicles() {
  try {
    state.vehicles = await api('GET', 'vehicles');
    cacheSet('vehicles', state.vehicles);
  } catch (_) { if (!state.vehicles.length) state.vehicles = []; }
}
async function loadTrips() {
  const isDefault = !state.filters.vehicle_id && !state.filters.from && !state.filters.to && !state.filters.trip_type;
  const p = new URLSearchParams({ limit: 100, ...state.filters });
  try {
    state.trips = await api('GET', 'trips?' + p);
    if (isDefault) cacheSet('trips_default', state.trips);
  } catch (_) { if (!state.trips.length) state.trips = []; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function renderAuth(tab = 'login') {
  const canRegister = authStatus.registrations_open !== false;
  if (tab === 'register' && !canRegister) tab = 'login';
  setHtml(`
    <div class="auth-screen">
      <div class="auth-logo">
        <svg viewBox="0 0 64 64" width="72" height="72"><circle cx="32" cy="32" r="30" fill="rgba(255,255,255,.15)"/><path d="M20 40 L32 16 L44 40 Z" fill="white" opacity=".9"/><rect x="28" y="33" width="8" height="9" rx="1" fill="rgba(0,0,0,.3)"/></svg>
        <h1>MileageLog</h1>
      </div>
      <div class="auth-card">
        ${canRegister ? `
        <div class="auth-tabs">
          <button class="auth-tab ${tab==='login'?'active':''}" onclick="renderAuth('login')">Sign In</button>
          <button class="auth-tab ${tab==='register'?'active':''}" onclick="renderAuth('register')">Register</button>
        </div>
        ` : ''}
        ${tab === 'login' ? `
        <form onsubmit="doLogin(event)">
          <div class="field"><label>Username</label><input name="username" type="text" autocomplete="username" required autofocus></div>
          <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
          <p id="auth-err" class="text-sm" style="color:var(--red);margin-bottom:12px;display:none"></p>
          <button type="submit" class="btn btn-primary btn-full" id="auth-btn">Sign In</button>
        </form>
        ` : `
        <form onsubmit="doRegister(event)">
          <div class="field"><label>Username</label><input name="username" type="text" autocomplete="username" required autofocus minlength="2"></div>
          <div class="field"><label>Email <span class="text-muted">(optional)</span></label><input name="email" type="email" autocomplete="email"></div>
          <div class="field"><label>Password</label><input name="password" type="password" autocomplete="new-password" required minlength="6"></div>
          <p id="auth-err" class="text-sm" style="color:var(--red);margin-bottom:12px;display:none"></p>
          <button type="submit" class="btn btn-primary btn-full" id="auth-btn">Create Account</button>
        </form>
        `}
      </div>
    </div>
  `);
}

async function doLogin(e) {
  e.preventDefault();
  const f = e.target, btn = document.getElementById('auth-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('POST', 'auth/login', { username: f.username.value, password: f.password.value });
    const { user } = await api('GET', 'auth/me');
    state.user = user;
    await loadVehicles(); await loadDashboardData(); await loadReport();
    renderApp();
  } catch (err) {
    const el = document.getElementById('auth-err');
    el.textContent = err.message; el.style.display = '';
    btn.textContent = 'Sign In';
  }
}

async function doRegister(e) {
  e.preventDefault();
  const f = e.target, btn = document.getElementById('auth-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('POST', 'auth/register', { username: f.username.value, email: f.email.value, password: f.password.value });
    const { user } = await api('GET', 'auth/me');
    state.user = user;
    await loadVehicles(); await loadDashboardData(); await loadReport();
    renderApp();
    toast(user.is_admin ? 'Welcome! You are the admin.' : 'Welcome to MileageLog!');
  } catch (err) {
    const el = document.getElementById('auth-err');
    el.textContent = err.message; el.style.display = '';
    btn.textContent = 'Create Account';
  }
}

async function doLogout() {
  await api('POST', 'auth/logout');
  state.user = null; state.vehicles = []; state.trips = [];
  document.getElementById('user-modal')?.remove();
  await loadAuthStatus();
  renderAuth();
}

// ── App shell ─────────────────────────────────────────────────────────────────
function renderApp() {
  const pages = { dashboard: renderDashboard, trips: renderTrips, vehicles: renderVehicles, reports: renderReports, admin: renderAdmin };
  setHtml((pages[state.page] || renderDashboard)() + renderBottomNav());
}

function renderBottomNav() {
  const p = state.page;
  return `
    <nav class="bottomnav">
      <button class="nav-item ${p==='dashboard'?'active':''}" onclick="navigate('dashboard')">${iconHome()}<span>Home</span></button>
      <button class="nav-item ${p==='trips'?'active':''}" onclick="navigate('trips')">${iconList()}<span>Trips</span></button>
      <div class="nav-fab">
        <button class="nav-fab-btn" onclick="openAddTrip()" aria-label="Add trip">${iconPlus()}</button>
        <span>Log Trip</span>
      </div>
      <button class="nav-item ${p==='vehicles'?'active':''}" onclick="navigate('vehicles')">${iconCar()}<span>Vehicles</span></button>
      <button class="nav-item ${p==='reports'?'active':''}" onclick="navigate('reports')">${iconChart()}<span>Reports</span></button>
    </nav>
  `;
}

async function navigate(page, fromHistory = false) {
  state.page = page;
  if (!fromHistory) history.pushState({ page }, '');
  // Render instantly with whatever cached data we have, then refresh
  renderApp();
  if (page === 'trips')     await loadTrips();
  if (page === 'dashboard') await loadDashboardData();
  if (page === 'reports')   await loadReport();
  if (page === 'admin')     await loadAdminData();
  renderApp();
}

// ── History / Android back-gesture handling ───────────────────────────────────
// Modals push a history entry when opened so the hardware/gesture back button
// closes the modal instead of exiting the PWA. Closing a modal via the UI pops
// that same entry so the stack stays balanced.
let modalClosingViaHistory = false;

function showModalEl(el) {
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  history.pushState({ modal: true, page: state.page }, '');
}

function closeModal(id, fromHistory = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  setTimeout(() => el.remove(), 250);
  if (!fromHistory && history.state?.modal) {
    modalClosingViaHistory = true;
    history.back();
  }
}

let historyInitDone = false;
function historyInit() {
  if (historyInitDone) return;
  historyInitDone = true;
  history.replaceState({ page: state.page }, '');
  window.addEventListener('popstate', e => {
    if (modalClosingViaHistory) { modalClosingViaHistory = false; return; }
    const openModal = document.querySelector('.modal-backdrop.open');
    if (openModal) { closeModal(openModal.id, true); return; }
    const st = e.state || {};
    navigate(st.page || 'dashboard', true);
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
let dashData = null;

async function loadDashboardData() {
  const from = today().slice(0,7) + '-01', to = today();
  try {
    dashData = await api('GET', `reports/summary?from=${from}&to=${to}`);
    dashData.recent = await api('GET', 'trips?limit=5');
    cacheSet('dash', dashData);
  } catch (_) {}
}

function renderDashboard() {
  const d = dashData;
  const monthName = new Date().toLocaleString('default', { month: 'long' });
  return `
    <div class="topbar">
      <span class="topbar-title">MileageLog</span>
      ${state.user?.is_admin ? `<button class="btn btn-icon" style="color:white" onclick="navigate('admin')" title="Admin">${iconShield()}</button>` : ''}
      <button class="btn btn-icon" style="color:white" onclick="showUserMenu()" title="Account">${iconUser()}</button>
    </div>
    <div class="page" id="dash-page">
      ${d ? `
      <div class="section-hdr"><span class="section-title">${monthName} so far</span></div>
      <div class="stats-grid">
        <div class="stat-card accent"><div class="stat-label">Business km</div><div class="stat-value">${parseFloat(d.business_km||0).toFixed(0)}<span class="stat-unit"> km</span></div></div>
        <div class="stat-card"><div class="stat-label">Total km</div><div class="stat-value">${parseFloat(d.total_km||0).toFixed(0)}<span class="stat-unit"> km</span></div></div>
        <div class="stat-card"><div class="stat-label">Business use</div><div class="stat-value">${d.business_pct}<span class="stat-unit">%</span></div></div>
        <div class="stat-card" style="background:#f0fdf4"><div class="stat-label">Est. deduction</div><div class="stat-value" style="font-size:1.3rem;color:var(--green)">${fmtCur(d.total_deduction)}</div></div>
      </div>
      ` : `<div class="card" style="text-align:center;padding:32px"><p class="text-muted">Loading…</p></div>`}

      ${state.vehicles.length > 0 ? `
      <button class="btn btn-secondary btn-full mt-8" style="margin-bottom:12px" onclick="openStartTrip()">${iconClock()} Start Trip</button>
      ` : ''}

      ${state.vehicles.length === 0 ? `
      <div class="card" style="border:2px dashed var(--border);background:transparent;text-align:center;padding:28px">
        <p style="font-size:2rem;margin-bottom:8px">🚗</p>
        <p style="font-weight:700;margin-bottom:6px">Add your first vehicle</p>
        <p class="text-muted text-sm" style="margin-bottom:16px">Required before logging trips.</p>
        <button class="btn btn-primary" onclick="navigate('vehicles')">Add Vehicle</button>
      </div>
      ` : ''}

      <div class="section-hdr mt-16">
        <span class="section-title">Recent Trips</span>
        <button class="btn btn-sm btn-secondary" onclick="navigate('trips')">View all</button>
      </div>
      ${d?.recent?.length > 0 ? d.recent.map(tripCard).join('') : `
        <div class="empty-state" style="padding:32px 0">
          ${iconList()}
          <h3>No trips yet</h3>
          <p>Tap + to log your first trip.</p>
        </div>`}

      <div style="height:8px"></div>
    </div>
  `;
}

function tripCard(t) {
  const pending  = t.status === 'pending';
  const billable = t.billable ? `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:.65rem">Billable</span>` : '';
  const pendingBadge = pending ? `<span class="badge" style="background:#fff3cd;color:#856404;font-size:.65rem">In Progress</span>` : '';
  const client   = t.client_name ? `<span class="text-muted"> · ${escHtml(t.client_name)}</span>` : '';
  const inBtn    = (!pending && t.trip_type === 'business')
    ? `<button class="btn btn-sm btn-secondary" style="margin-top:6px;font-size:.72rem" onclick="event.stopPropagation();openInExpenseModal(${t.id})">⚡ Send to Invoice Ninja</button>`
    : '';
  const endBtn   = pending
    ? `<button class="btn btn-sm btn-primary" style="margin-top:6px;font-size:.72rem" onclick="event.stopPropagation();openEndTrip(${t.id})">End Trip</button>`
    : '';
  return `
    <div class="trip-item" onclick="${pending ? `openEndTrip(${t.id})` : `openEditTrip(${t.id})`}">
      <div class="trip-type-dot ${t.trip_type}"></div>
      <div class="trip-info">
        <div class="trip-purpose">${escHtml(t.purpose || 'Private trip')} ${billable}${pendingBadge}</div>
        <div class="trip-meta">${fmtDate(t.date)} · ${escHtml(t.vehicle_name||'')}${client}</div>
        ${t.start_location||t.end_location ? `<div class="trip-meta" style="font-size:.72rem">${escHtml(t.start_location||'')}${t.start_location&&t.end_location?' → ':''}${escHtml(t.end_location||'')}</div>` : ''}
        ${inBtn}${endBtn}
      </div>
      <div class="trip-dist">${pending ? '—' : fmt(t.distance)}</div>
    </div>
  `;
}

// ── Trips page ────────────────────────────────────────────────────────────────
function renderTrips() {
  const f = state.filters;
  return `
    <div class="topbar">
      <span class="topbar-title">Trip Log</span>
      <button class="btn btn-icon" style="color:white" onclick="openStartTrip()" title="Start Trip">${iconClock()}</button>
      <button class="btn btn-icon" style="color:white" onclick="openAddTrip()" title="Add">${iconPlus()}</button>
    </div>
    <div class="filter-bar">
      <button class="filter-chip ${!f.trip_type?'active':''}" onclick="setTripFilter('trip_type','')">All</button>
      <button class="filter-chip ${f.trip_type==='business'?'active':''}" onclick="setTripFilter('trip_type','business')">Business</button>
      <button class="filter-chip ${f.trip_type==='private'?'active':''}" onclick="setTripFilter('trip_type','private')">Private</button>
      ${state.vehicles.map(v => `<button class="filter-chip ${f.vehicle_id==v.id?'active':''}" onclick="setTripFilter('vehicle_id','${v.id}')">${escHtml(v.name)}</button>`).join('')}
    </div>
    <div class="page" style="padding-top:12px">
      ${state.trips.length === 0 ? `<div class="empty-state">${iconList()}<h3>No trips found</h3><p>Tap + to log a new trip.</p></div>` : state.trips.map(tripCard).join('')}
    </div>
  `;
}

async function setTripFilter(key, val) {
  state.filters[key] = val;
  await loadTrips();
  renderApp();
}

// ── Trip modal ────────────────────────────────────────────────────────────────
const PURPOSES = ['Client visit','Site inspection','Supplier / trade','Staff meeting','Training / course','Conference','Medical appointment','Personal'];

function openAddTrip(prefill = {}) {
  if (state.vehicles.length === 0) { toast('Add a vehicle first', 'error'); navigate('vehicles'); return; }
  showTripModal(null, prefill);
}
async function openEditTrip(id) {
  try { showTripModal(id, await api('GET', `trips/${id}`)); } catch (e) { toast(e.message, 'error'); }
}

function showTripModal(id, data = {}) {
  const isEdit    = id !== null;
  const selV      = data.vehicle_id || state.lastVehicleId || state.vehicles[0]?.id || '';
  const selType   = data.trip_type || 'business';
  const isBiz     = selType === 'business';

  document.getElementById('trip-modal')?.remove();
  const el = document.createElement('div');
  el.id = 'trip-modal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">${isEdit ? 'Edit Trip' : 'Log Trip'}</div>
      <form id="trip-form" onsubmit="saveTrip(event,${id})">

        <div class="field">
          <label>Vehicle</label>
          <select name="vehicle_id" required>
            ${state.vehicles.map(v => `<option value="${v.id}" ${v.id==selV?'selected':''}>${escHtml(v.name)}${v.registration?' ('+escHtml(v.registration)+')':''}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label>Date</label>
          <input name="date" type="date" value="${data.date || today()}" required max="${today()}">
        </div>

        <div class="field">
          <label>Trip Type</label>
          <div class="type-toggle">
            <button type="button" class="type-btn business ${isBiz?'active':''}" onclick="setTripType('business')">Business</button>
            <button type="button" class="type-btn private ${!isBiz?'active':''}" onclick="setTripType('private')">Private</button>
          </div>
          <input type="hidden" name="trip_type" value="${selType}" id="trip-type-hidden">
        </div>

        <div class="field">
          <label>Purpose <span id="purpose-req" class="text-sm text-muted">${isBiz?'*':'(optional)'}</span></label>
          <input name="purpose" type="text" value="${escAttr(data.purpose||'')}" placeholder="e.g. Client visit" ${isBiz?'required':''} autocomplete="off" list="purpose-suggestions" oninput="filterSuggestions(this.value)">
          <datalist id="purpose-suggestions"></datalist>
          <div class="suggestions" id="suggestions">
            ${PURPOSES.map(p => `<button type="button" class="suggest-chip" onclick="selectPurpose('${escAttr(p)}')">${escHtml(p)}</button>`).join('')}
          </div>
        </div>

        <div id="biz-fields" ${!isBiz?'style="display:none"':''}>
          <div class="field-row">
            <div class="field">
              <label>Client Name</label>
              <input name="client_name" type="text" value="${escAttr(data.client_name||'')}" placeholder="e.g. Acme Ltd" list="client-suggestions" autocomplete="off">
              <datalist id="client-suggestions"></datalist>
            </div>
            <div class="field" style="flex:0 0 auto;min-width:110px">
              <label>&nbsp;</label>
              <label class="checkbox-label" style="margin-top:12px">
                <input type="checkbox" name="billable" id="billable-cb" ${data.billable?'checked':''}>
                <span>Billable</span>
              </label>
            </div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label>From</label>
            <input name="start_location" type="text" value="${escAttr(data.start_location||'')}" placeholder="Start location">
          </div>
          <div class="field">
            <label>To</label>
            <input name="end_location" type="text" value="${escAttr(data.end_location||'')}" placeholder="End location">
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label>Start Odo <span class="text-muted text-sm">(km)</span></label>
            <input name="start_odometer" type="number" step="0.1" min="0" value="${data.start_odometer||''}" placeholder="45230" oninput="autoCalcDist()">
          </div>
          <div class="field">
            <label>End Odo <span class="text-muted text-sm">(km)</span></label>
            <input name="end_odometer" type="number" step="0.1" min="0" value="${data.end_odometer||''}" placeholder="45295" oninput="autoCalcDist()">
          </div>
        </div>

        <div class="field">
          <label>Distance (km) *</label>
          <input name="distance" type="number" step="0.1" min="0.1" value="${data.distance||''}" required placeholder="e.g. 65.0" id="dist-input">
        </div>

        <div class="field">
          <label>Notes <span class="text-muted text-sm">(optional)</span></label>
          <textarea name="notes" rows="2" placeholder="Additional details…">${escHtml(data.notes||'')}</textarea>
        </div>

        <button type="submit" class="btn btn-primary btn-full" id="save-trip-btn">${isEdit ? 'Save Changes' : 'Log Trip'}</button>
        ${isEdit ? `<button type="button" class="btn btn-danger btn-full mt-8" onclick="deleteTrip(${id})">Delete Trip</button>` : ''}
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('trip-modal'); });
  showModalEl(el);

  // Populate client/purpose autocomplete instantly from cache, then refresh from server
  populateDatalist('client-suggestions', cacheGet('known_clients') || []);
  populateDatalist('purpose-suggestions', cacheGet('known_purposes') || []);
  api('GET', 'trips/clients').then(names => {
    cacheSet('known_clients', names);
    populateDatalist('client-suggestions', names);
  }).catch(() => {});
  api('GET', 'trips/purposes').then(names => {
    cacheSet('known_purposes', names);
    populateDatalist('purpose-suggestions', names);
  }).catch(() => {});
}

function populateDatalist(id, names) {
  const dl = document.getElementById(id);
  if (!dl) return;
  dl.innerHTML = names.map(n => `<option value="${escAttr(n)}">`).join('');
}

function setTripType(type) {
  document.getElementById('trip-type-hidden').value = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.classList.contains(type)));
  const isBiz = type === 'business';
  const p = document.querySelector('[name=purpose]');
  document.getElementById('purpose-req').textContent = isBiz ? '*' : '(optional)';
  if (p) p.required = isBiz;
  const bizFields = document.getElementById('biz-fields');
  if (bizFields) bizFields.style.display = isBiz ? '' : 'none';
}

function autoCalcDist() {
  const s = parseFloat(document.querySelector('[name=start_odometer]')?.value);
  const e = parseFloat(document.querySelector('[name=end_odometer]')?.value);
  if (!isNaN(s) && !isNaN(e) && e > s) {
    const di = document.getElementById('dist-input');
    if (di) di.value = (e - s).toFixed(1);
  }
}
function filterSuggestions(val) {
  const lo = val.toLowerCase();
  document.querySelectorAll('.suggest-chip').forEach(c => { c.style.display = !val || c.textContent.toLowerCase().includes(lo) ? '' : 'none'; });
}
function selectPurpose(p) {
  const i = document.querySelector('[name=purpose]');
  if (i) { i.value = p; filterSuggestions(p); }
}

async function saveTrip(e, id) {
  e.preventDefault();
  const f   = e.target;
  const btn = document.getElementById('save-trip-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  const body = {
    vehicle_id:     parseInt(f.vehicle_id.value),
    date:           f.date.value,
    trip_type:      f.trip_type.value,
    purpose:        f.purpose.value,
    client_name:    f.client_name?.value || null,
    billable:       f.billable?.checked ? 1 : 0,
    start_location: f.start_location?.value || null,
    end_location:   f.end_location?.value || null,
    distance:       parseFloat(f.distance.value),
    start_odometer: f.start_odometer.value ? parseFloat(f.start_odometer.value) : null,
    end_odometer:   f.end_odometer.value   ? parseFloat(f.end_odometer.value)   : null,
    notes:          f.notes.value || null,
  };
  try {
    if (id) { await api('PUT', `trips/${id}`, body); }
    else if (navigator.onLine) { await api('POST', 'trips', body); }
    else { await queueTrip(body); toast('Saved offline — will sync when connected', 'success', 4000); }
    state.lastVehicleId = body.vehicle_id;
    closeModal('trip-modal');
    toast(id ? 'Trip updated' : 'Trip logged!');
    await loadTrips();
    if (state.page === 'dashboard') await loadDashboardData();
    renderApp();
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = id ? 'Save Changes' : 'Log Trip';
  }
}

async function deleteTrip(id) {
  if (!confirm('Delete this trip?')) return;
  try {
    await api('DELETE', `trips/${id}`);
    closeModal('trip-modal');
    toast('Trip deleted');
    await loadTrips();
    renderApp();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Start Trip / End Trip (log the start now, finish later) ──────────────────
function openStartTrip() {
  if (state.vehicles.length === 0) { toast('Add a vehicle first', 'error'); navigate('vehicles'); return; }
  const selV = state.lastVehicleId || state.vehicles[0]?.id || '';
  const el = document.createElement('div');
  el.id = 'start-trip-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">Start Trip</div>
      <p class="text-sm text-muted" style="margin-bottom:16px">Log what you know now — you'll fill in the end odometer and finish up when you're back.</p>
      <form onsubmit="saveStartTrip(event)">
        <div class="field">
          <label>Vehicle</label>
          <select name="vehicle_id" required>
            ${state.vehicles.map(v => `<option value="${v.id}" ${v.id==selV?'selected':''}>${escHtml(v.name)}${v.registration?' ('+escHtml(v.registration)+')':''}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Date</label>
          <input name="date" type="date" value="${today()}" required max="${today()}">
        </div>
        <div class="field">
          <label>Trip Name / Purpose</label>
          <input name="purpose" type="text" placeholder="e.g. Client visit" list="purpose-suggestions" autocomplete="off">
          <datalist id="purpose-suggestions">${(cacheGet('known_purposes')||[]).map(n => `<option value="${escAttr(n)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label>Client Name</label>
          <input name="client_name" type="text" placeholder="e.g. Acme Ltd" list="client-suggestions" autocomplete="off">
          <datalist id="client-suggestions">${(cacheGet('known_clients')||[]).map(n => `<option value="${escAttr(n)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label>Start Odo <span class="text-muted text-sm">(km)</span></label>
          <input name="start_odometer" type="number" step="0.1" min="0" placeholder="45230">
        </div>
        <div class="field">
          <label>Start Location</label>
          <input name="start_location" type="text" id="start-trip-location" placeholder="Detecting…">
        </div>
        <button type="submit" class="btn btn-primary btn-full" id="start-trip-btn">Start Trip</button>
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('start-trip-modal'); });
  showModalEl(el);

  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const i = document.getElementById('start-trip-location');
        if (i && !i.value) i.value = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
      },
      () => { const i = document.getElementById('start-trip-location'); if (i) i.placeholder = 'e.g. Home office'; },
      { timeout: 8000 }
    );
  }
}

async function saveStartTrip(e) {
  e.preventDefault();
  const f   = e.target;
  const btn = document.getElementById('start-trip-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  const body = {
    vehicle_id:     parseInt(f.vehicle_id.value),
    date:           f.date.value,
    trip_type:      'business',
    purpose:        f.purpose.value || '',
    client_name:    f.client_name.value || null,
    start_location: f.start_location.value || null,
    start_odometer: f.start_odometer.value ? parseFloat(f.start_odometer.value) : null,
    distance:       0,
    status:         'pending',
  };
  try {
    await api('POST', 'trips', body);
    state.lastVehicleId = body.vehicle_id;
    closeModal('start-trip-modal');
    toast('Trip started — end it when you\'re back');
    await loadTrips();
    if (state.page === 'dashboard') await loadDashboardData();
    renderApp();
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = 'Start Trip';
  }
}

async function openEndTrip(id) {
  let trip;
  try { trip = await api('GET', `trips/${id}`); } catch (e) { toast(e.message, 'error'); return; }

  const el = document.createElement('div');
  el.id = 'end-trip-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">End Trip</div>
      <div class="card" style="background:var(--green-lt);border:1.5px solid var(--border);margin-bottom:16px">
        <div style="font-weight:700">${escHtml(trip.purpose || 'Trip')}</div>
        <div class="text-sm text-muted">${fmtDate(trip.date)} · ${escHtml(trip.vehicle_name||'')}${trip.client_name ? ' · '+escHtml(trip.client_name) : ''}</div>
        ${trip.start_location ? `<div class="text-sm text-muted">From: ${escHtml(trip.start_location)}</div>` : ''}
        ${trip.start_odometer != null ? `<div class="text-sm text-muted">Start odo: ${trip.start_odometer} km</div>` : ''}
      </div>
      <form onsubmit="saveEndTrip(event,${id})">
        <div class="field">
          <label>End Odo <span class="text-muted text-sm">(km)</span></label>
          <input name="end_odometer" type="number" step="0.1" min="0" placeholder="45295" oninput="autoCalcEndDist(${trip.start_odometer||0})">
        </div>
        <div class="field">
          <label>Distance (km) *</label>
          <input name="distance" type="number" step="0.1" min="0.1" required placeholder="e.g. 65.0" id="end-dist-input">
        </div>
        <div class="field">
          <label>End Location</label>
          <input name="end_location" type="text" placeholder="End location">
        </div>
        <div class="field">
          <label>Notes <span class="text-muted text-sm">(optional)</span></label>
          <textarea name="notes" rows="2">${escHtml(trip.notes||'')}</textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-full" id="end-trip-btn">Finish Trip</button>
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('end-trip-modal'); });
  showModalEl(el);
}

function autoCalcEndDist(startOdo) {
  const e  = parseFloat(document.querySelector('#end-trip-modal [name=end_odometer]')?.value);
  const di = document.getElementById('end-dist-input');
  if (!isNaN(e) && startOdo && e > startOdo && di) di.value = (e - startOdo).toFixed(1);
}

async function saveEndTrip(e, id) {
  e.preventDefault();
  const f   = e.target;
  const btn = document.getElementById('end-trip-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const trip = await api('GET', `trips/${id}`);
    const body = {
      vehicle_id:     trip.vehicle_id,
      date:           trip.date,
      trip_type:      trip.trip_type,
      purpose:        trip.purpose,
      client_name:    trip.client_name,
      billable:       trip.billable,
      start_location: trip.start_location,
      end_location:   f.end_location.value || null,
      start_odometer: trip.start_odometer,
      end_odometer:   f.end_odometer.value ? parseFloat(f.end_odometer.value) : null,
      distance:       parseFloat(f.distance.value),
      notes:          f.notes.value || null,
      status:         'completed',
    };
    await api('PUT', `trips/${id}`, body);
    closeModal('end-trip-modal');
    toast('Trip completed');
    await loadTrips();
    if (state.page === 'dashboard') await loadDashboardData();
    renderApp();
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = 'Finish Trip';
  }
}

// ── Vehicles page ─────────────────────────────────────────────────────────────
function renderVehicles() {
  return `
    <div class="topbar">
      <span class="topbar-title">My Vehicles</span>
      <button class="btn btn-icon" style="color:white" onclick="openAddVehicle()">${iconPlus()}</button>
    </div>
    <div class="page">
      ${state.vehicles.length === 0
        ? `<div class="empty-state">${iconCar()}<h3>No vehicles yet</h3><p>Add your car, van or motorcycle.</p><button class="btn btn-primary mt-16" onclick="openAddVehicle()">Add Vehicle</button></div>`
        : state.vehicles.map(vehicleCard).join('')}
    </div>
  `;
}

function vehicleCard(v) {
  const fuelBadge = `<span class="badge badge-business" style="font-size:.65rem">${escHtml(FUEL_LABELS[v.fuel_type] || v.fuel_type)}</span>`;
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${escHtml(v.name)} ${fuelBadge}</div>
          <div class="card-subtitle">${[v.year, v.make, v.model].filter(Boolean).join(' ')}${v.registration ? ' · ' + escHtml(v.registration) : ''}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-secondary" onclick="openEditVehicle(${v.id})">${iconEdit()}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">${iconTrash()}</button>
        </div>
      </div>
    </div>
  `;
}

function openAddVehicle() { showVehicleModal(null); }
async function openEditVehicle(id) {
  const v = state.vehicles.find(x => x.id === id);
  if (v) showVehicleModal(id, v);
}

function showVehicleModal(id, data = {}) {
  const isEdit = id !== null;
  const ft     = data.fuel_type || 'petrol';
  document.getElementById('vehicle-modal')?.remove();
  const el = document.createElement('div');
  el.id = 'vehicle-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">${isEdit ? 'Edit Vehicle' : 'Add Vehicle'}</div>
      <form id="vehicle-form" onsubmit="saveVehicle(event,${id})">
        <div class="field"><label>Name *</label><input name="name" required value="${escAttr(data.name||'')}" placeholder="e.g. Work Ute" autofocus></div>
        <div class="field">
          <label>Fuel Type</label>
          <select name="fuel_type">
            ${Object.entries(FUEL_LABELS).map(([k,v]) => `<option value="${k}" ${k===ft?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>Make</label><input name="make" value="${escAttr(data.make||'')}" placeholder="Toyota"></div>
          <div class="field"><label>Model</label><input name="model" value="${escAttr(data.model||'')}" placeholder="HiLux"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Year</label><input name="year" type="number" min="1980" max="${new Date().getFullYear()+1}" value="${data.year||''}"></div>
          <div class="field"><label>Registration</label><input name="registration" value="${escAttr(data.registration||'')}" placeholder="ABC123" style="text-transform:uppercase"></div>
        </div>
        <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Save Changes' : 'Add Vehicle'}</button>
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('vehicle-modal'); });
  showModalEl(el);
}

async function saveVehicle(e, id) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name:         f.name.value,
    fuel_type:    f.fuel_type.value,
    make:         f.make.value || null,
    model:        f.model.value || null,
    year:         f.year.value ? parseInt(f.year.value) : null,
    registration: (f.registration.value || '').toUpperCase() || null,
  };
  try {
    if (id) await api('PUT', `vehicles/${id}`, body);
    else    await api('POST', 'vehicles', body);
    closeModal('vehicle-modal');
    toast(id ? 'Vehicle updated' : 'Vehicle added');
    await loadVehicles(); renderApp();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteVehicle(id) {
  if (!confirm('Remove this vehicle? Its trips are kept.')) return;
  try {
    await api('DELETE', `vehicles/${id}`);
    toast('Vehicle removed'); await loadVehicles(); renderApp();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Reports page ──────────────────────────────────────────────────────────────
let reportData    = null;
let reportFrom    = (() => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() + '-04-01' : (d.getFullYear()-1) + '-04-01'; })();
let reportTo      = today();
let reportVehicle = '';

async function loadReport() {
  const isDefault = !reportVehicle;
  const p = new URLSearchParams({ from: reportFrom, to: reportTo });
  if (reportVehicle) p.set('vehicle_id', reportVehicle);
  try {
    reportData = await api('GET', 'reports/summary?' + p);
    if (isDefault) cacheSet('report_default', reportData);
  } catch (_) {}
}

function renderReports() {
  const d = reportData;
  const days = d ? daysBetween(d.from, d.to) : 0;
  return `
    <div class="topbar">
      <span class="topbar-title">Reports</span>
      ${d ? `<button class="btn btn-icon" style="color:white" onclick="exportCsv()" title="Export">${iconDownload()}</button>` : ''}
    </div>
    <div class="page">
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Date Range</div>
        <div class="field-row">
          <div class="field"><label>From</label><input type="date" id="rpt-from" value="${reportFrom}" onchange="updateReport()"></div>
          <div class="field"><label>To</label><input type="date" id="rpt-to" value="${reportTo}" max="${today()}" onchange="updateReport()"></div>
        </div>
        ${state.vehicles.length > 1 ? `
        <div class="field"><label>Vehicle</label>
          <select id="rpt-vehicle" onchange="updateReport()">
            <option value="">All vehicles</option>
            ${state.vehicles.map(v => `<option value="${v.id}" ${v.id==reportVehicle?'selected':''}>${escHtml(v.name)}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>

      ${!d ? `<div class="card" style="text-align:center;padding:32px"><p class="text-muted">Loading…</p></div>` : `

      <div class="card">
        <div class="card-title">IRD Logbook Summary</div>
        <div class="card-subtitle">${fmtDate(d.from)} – ${fmtDate(d.to)} · ${days} days
          ${days >= 90 ? ' <span style="color:var(--green)">✓ 90-day requirement met</span>' : ` <span style="color:var(--accent)">⚠ ${90-days} more days needed for 90-day period</span>`}
        </div>
        <div class="stats-grid mt-16">
          <div class="stat-card"><div class="stat-label">Total km</div><div class="stat-value">${parseFloat(d.total_km).toFixed(0)}</div></div>
          <div class="stat-card"><div class="stat-label">Trips</div><div class="stat-value">${d.trip_count}</div></div>
          <div class="stat-card accent"><div class="stat-label">Business km</div><div class="stat-value">${parseFloat(d.business_km).toFixed(0)}</div></div>
          <div class="stat-card" style="background:#fff3cd"><div class="stat-label">Private km</div><div class="stat-value" style="color:#856404">${parseFloat(d.private_km).toFixed(0)}</div></div>
        </div>
        <div class="mt-16">
          <div style="display:flex;justify-content:space-between;font-size:.85rem;font-weight:700;margin-bottom:4px">
            <span class="text-green">Business ${d.business_pct}%</span>
            <span style="color:#856404">Private ${(100-d.business_pct).toFixed(1)}%</span>
          </div>
          <div class="pct-bar"><div class="pct-fill" style="width:${d.business_pct}%"></div></div>
        </div>
      </div>

      ${d.business_km > 0 && d.deductions?.length === 0 ? `
      <div class="card" style="background:#fff3cd;border:1.5px solid #f0a500">
        <div style="font-weight:700;margin-bottom:4px">⚠ No IRD rates configured for this period</div>
        <p class="text-sm" style="color:var(--text-2);margin-bottom:10px">
          Deductions can't be calculated. IRD rates change each tax year — an admin needs to add rates for the applicable year(s) at <strong>ird.govt.nz</strong>.
        </p>
        ${state.user?.is_admin ? `<button class="btn btn-sm btn-primary" onclick="navigate('admin')">Go to Admin → IRD Rates</button>` : '<span class="text-sm">Ask your admin to add the rates.</span>'}
      </div>
      ` : ''}

      ${d.deductions?.length > 0 ? `
      <div class="card">
        <div class="card-title" style="margin-bottom:4px">IRD Claimable Deductions</div>
        <div class="card-subtitle" style="margin-bottom:14px">Based on vehicle fuel type and applicable km rates</div>
        ${d.deductions.map(row => {
          const vName = state.vehicles.find(v => v.id == row.vehicle_id)?.name || 'Vehicle';
          const tierNote = row.tier === 'mixed'
            ? `${fmtCur(row.rate_standard)}/km (first 14,000) · ${fmtCur(row.rate_over14k)}/km (over)`
            : `${fmtCur(row.rate_standard)}/km (Tier 1)`;
          return `
          <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div style="font-weight:700">${escHtml(vName)}</div>
                <div class="text-sm text-muted">Tax year ending ${row.tax_year} · ${escHtml(FUEL_LABELS[row.fuel_type]||row.fuel_type)}</div>
                <div class="text-sm text-muted">${row.period_business_km} business km in period · ${tierNote}</div>
              </div>
              <div style="font-size:1.3rem;font-weight:800;color:var(--green)">${fmtCur(row.deduction)}</div>
            </div>
          </div>`;
        }).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px 0;border-top:2px solid var(--border);margin-top:4px">
          <span style="font-weight:700">Total estimated deduction</span>
          <span style="font-size:1.4rem;font-weight:900;color:var(--green)">${fmtCur(d.total_deduction)}</span>
        </div>
        <p class="text-sm text-muted mt-8">Rates from your IRD rates table. Verify at ird.govt.nz. For accurate Tier 2 calculation, report the full tax year (1 Apr – 31 Mar).</p>
      </div>
      ` : ''}

      ${d.monthly?.length > 0 ? `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Monthly Breakdown</div>
        ${monthlyChart(d.monthly)}
        <table style="width:100%;font-size:.85rem;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:6px 4px;color:var(--text-2);font-weight:600">Month</th>
            <th style="text-align:right;padding:6px 4px;color:var(--text-2);font-weight:600">Total</th>
            <th style="text-align:right;padding:6px 4px;color:var(--text-2);font-weight:600">Business</th>
            <th style="text-align:right;padding:6px 4px;color:var(--text-2);font-weight:600">%</th>
          </tr></thead>
          <tbody>
          ${d.monthly.map(m => {
            const pct = m.total_km > 0 ? Math.round(m.business_km / m.total_km * 100) : 0;
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 4px">${m.month}</td>
              <td style="text-align:right;padding:8px 4px">${parseFloat(m.total_km).toFixed(0)}</td>
              <td style="text-align:right;padding:8px 4px;color:var(--green)">${parseFloat(m.business_km).toFixed(0)}</td>
              <td style="text-align:right;padding:8px 4px;font-weight:700">${pct}%</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}

      <div class="card" style="background:var(--green-lt);border:1.5px solid var(--border)">
        <div class="card-title" style="color:var(--green);margin-bottom:6px">Export for IRD</div>
        <p class="text-sm text-muted" style="margin-bottom:12px">CSV with all required logbook columns.</p>
        <button class="btn btn-primary" onclick="exportCsv()">${iconDownload()} Download CSV</button>
      </div>
      `}
    </div>
  `;
}

function monthlyChart(monthly) {
  if (!monthly.length) return '';
  const maxKm = Math.max(...monthly.map(m => m.total_km));
  return `
    <div class="month-bars">
      ${monthly.map(m => `
        <div class="month-bar-wrap">
          <div class="month-bar" style="height:${Math.max(4, m.total_km/maxKm*72)}px" title="${parseFloat(m.total_km).toFixed(0)} km"></div>
          <span class="month-label">${m.month.slice(5)}</span>
        </div>`).join('')}
    </div>`;
}
function daysBetween(from, to) { return Math.round((new Date(to) - new Date(from)) / 86400000) + 1; }
async function updateReport() {
  const f = document.getElementById('rpt-from');
  const t = document.getElementById('rpt-to');
  const v = document.getElementById('rpt-vehicle');
  if (f) reportFrom = f.value;
  if (t) reportTo   = t.value;
  if (v) reportVehicle = v.value;
  await loadReport(); renderApp();
}
function exportCsv() {
  const p = new URLSearchParams({ from: reportFrom, to: reportTo });
  if (reportVehicle) p.set('vehicle_id', reportVehicle);
  window.location.href = 'api.php/reports/export?' + p;
}

// ── Admin panel ───────────────────────────────────────────────────────────────
let adminData = null;

async function loadAdminData() {
  try {
    const [settings, rates] = await Promise.all([
      api('GET', 'settings'),
      api('GET', 'ird_rates'),
    ]);
    adminData = { settings, rates };
  } catch (_) {}
}

function currentNZTaxYear() {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
}

function renderAdmin() {
  if (!state.user?.is_admin) { navigate('dashboard'); return ''; }
  const d = adminData;
  const regsOpen = d?.settings?.registrations_open === '1';
  const rates    = d?.rates || [];

  const FUEL_TYPES = ['petrol','diesel','hybrid','ev'];

  const thisYear     = currentNZTaxYear();
  const yearsInTable = new Set(rates.map(r => r.tax_year));
  const missingYear  = !yearsInTable.has(thisYear);

  return `
    <div class="topbar">
      <button class="topbar-back" onclick="navigate('dashboard')">${iconBack()}</button>
      <span class="topbar-title">Admin</span>
    </div>
    <div class="page">

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">${iconShield()} Registrations</div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:600">Allow new registrations</div>
            <div class="text-sm text-muted">${regsOpen ? 'Anyone can register' : 'Registration is closed'}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="reg-toggle" ${regsOpen?'checked':''} onchange="toggleRegistrations(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${iconDollar()} IRD km Rates</div>
          <button class="btn btn-sm btn-primary" onclick="openRateModal(null)">+ Add Rate</button>
        </div>
        ${missingYear ? `
        <div style="background:#fff3cd;border:1.5px solid #f0a500;border-radius:8px;padding:12px;margin-bottom:12px;font-size:.88rem">
          <strong>⚠ No rates for tax year ${thisYear}</strong> (April ${thisYear-1} – March ${thisYear})<br>
          IRD rates change each year. Add rates for ${thisYear} now, then verify the amounts at <strong>ird.govt.nz</strong>.
          <br><button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="openRateModal(null)">+ Add ${thisYear} Rates</button>
        </div>` : ''}
        <p class="text-sm text-muted" style="margin-bottom:12px">NZ tax year = April 1 to March 31 (year shown is year ending). Verify rates at ird.govt.nz each April.</p>
        ${rates.length === 0 ? '<p class="text-muted text-sm">No rates configured.</p>' : `
        <table style="width:100%;font-size:.82rem;border-collapse:collapse">
          <thead><tr style="border-bottom:2px solid var(--border)">
            <th style="text-align:left;padding:6px 4px">Year</th>
            <th style="text-align:left;padding:6px 4px">Fuel</th>
            <th style="text-align:right;padding:6px 4px">≤14k km</th>
            <th style="text-align:right;padding:6px 4px">&gt;14k km</th>
            <th></th>
          </tr></thead>
          <tbody>
          ${rates.map(r => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 4px;font-weight:600">${r.tax_year}</td>
            <td style="padding:8px 4px">${escHtml(FUEL_LABELS[r.fuel_type]||r.fuel_type)}</td>
            <td style="text-align:right;padding:8px 4px">${fmtCur(r.rate_standard)}</td>
            <td style="text-align:right;padding:8px 4px">${fmtCur(r.rate_over14k)}</td>
            <td style="padding:8px 4px 8px 8px;display:flex;gap:4px">
              <button class="btn btn-sm btn-secondary" onclick="openRateModal(${r.id})">${iconEdit()}</button>
              <button class="btn btn-sm btn-danger" onclick="deleteRate(${r.id})">${iconTrash()}</button>
            </td>
          </tr>`).join('')}
          </tbody>
        </table>`}
      </div>

    </div>
  `;
}

async function toggleRegistrations(open) {
  try {
    await api('PUT', 'settings', { registrations_open: open ? '1' : '0' });
    toast(open ? 'Registrations opened' : 'Registrations closed');
    await loadAdminData(); renderApp();
  } catch (e) { toast(e.message, 'error'); }
}

function openRateModal(id) {
  const rate  = adminData?.rates?.find(r => r.id === id) || {};
  const isNew = id === null;
  const FUEL_TYPES = ['petrol','diesel','hybrid','ev'];
  const el = document.createElement('div');
  el.id = 'rate-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">${isNew ? 'Add IRD Rate' : 'Edit IRD Rate'}</div>
      <form onsubmit="saveRate(event,${id})">
        <div class="field-row">
          <div class="field">
            <label>Tax Year (ending)</label>
            <input name="tax_year" type="number" min="2020" max="2040" value="${rate.tax_year || new Date().getFullYear()}" required>
          </div>
          <div class="field">
            <label>Fuel Type</label>
            <select name="fuel_type">
              ${FUEL_TYPES.map(ft => `<option value="${ft}" ${ft===rate.fuel_type?'selected':''}>${FUEL_LABELS[ft]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Rate ≤14,000 km ($/km)</label>
            <input name="rate_standard" type="number" step="0.01" min="0" value="${rate.rate_standard||''}" required placeholder="0.88">
          </div>
          <div class="field">
            <label>Rate &gt;14,000 km ($/km)</label>
            <input name="rate_over14k" type="number" step="0.01" min="0" value="${rate.rate_over14k||''}" required placeholder="0.31">
          </div>
        </div>
        <div class="field">
          <label>Notes <span class="text-muted text-sm">(optional)</span></label>
          <input name="notes" type="text" value="${escAttr(rate.notes||'')}" placeholder="e.g. Source: ird.govt.nz">
        </div>
        <button type="submit" class="btn btn-primary btn-full">${isNew ? 'Add Rate' : 'Save Changes'}</button>
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('rate-modal'); });
  document.getElementById('rate-modal')?.remove();
  showModalEl(el);
}

async function saveRate(e, id) {
  e.preventDefault();
  const f    = e.target;
  const body = {
    tax_year:     parseInt(f.tax_year.value),
    fuel_type:    f.fuel_type.value,
    rate_standard: parseFloat(f.rate_standard.value),
    rate_over14k:  parseFloat(f.rate_over14k.value),
    notes:        f.notes.value || null,
  };
  try {
    if (id) await api('PUT', `ird_rates/${id}`, body);
    else    await api('POST', 'ird_rates', body);
    closeModal('rate-modal');
    toast(id ? 'Rate updated' : 'Rate added');
    await loadAdminData(); renderApp();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteRate(id) {
  if (!confirm('Delete this rate?')) return;
  try {
    await api('DELETE', `ird_rates/${id}`);
    toast('Rate deleted');
    await loadAdminData(); renderApp();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Invoice Ninja ─────────────────────────────────────────────────────────────

async function showInSettings() {
  closeModal('user-modal');
  let cfg = {};
  try { cfg = await api('GET', 'user_settings'); } catch (_) {}

  const el = document.createElement('div');
  el.id = 'in-settings-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">Invoice Ninja</div>
      <p class="text-sm text-muted" style="margin-bottom:16px">
        Connect your Invoice Ninja account to send billable trips as expenses with one tap.
        Your API token is stored encrypted on the server and never returned in full.
      </p>
      <form onsubmit="saveInSettings(event)">
        <div class="field">
          <label>Invoice Ninja URL</label>
          <input name="in_url" type="url" value="${escAttr(cfg.in_url||'')}" placeholder="https://app.invoiceninja.com" autocomplete="off">
          <p class="text-sm text-muted" style="margin-top:4px">Use your self-hosted URL or <code>https://app.invoiceninja.com</code> for the cloud.</p>
        </div>
        <div class="field">
          <label>API Token</label>
          <input name="in_token" type="password" value="${escAttr(cfg.in_token||'')}" placeholder="${cfg.in_token ? 'Token saved (masked)' : 'Paste your API token'}" autocomplete="new-password">
          <p class="text-sm text-muted" style="margin-top:4px">Settings → API Tokens in Invoice Ninja.</p>
        </div>
        <div class="field">
          <label>Currency ID <span class="text-muted">(optional)</span></label>
          <input name="in_currency_id" type="number" value="${escAttr(cfg.in_currency_id||'')}" placeholder="e.g. 12 for NZD">
          <p class="text-sm text-muted" style="margin-top:4px">Leave blank to use your IN account default. NZD = 12.</p>
        </div>
        <button type="submit" class="btn btn-primary btn-full" id="in-save-btn">Save</button>
        ${cfg.in_url ? `
        <button type="button" class="btn btn-secondary btn-full mt-8" onclick="testInConnection()">Test Connection</button>
        ` : ''}
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('in-settings-modal'); });
  showModalEl(el);
}

async function saveInSettings(e) {
  e.preventDefault();
  const f   = e.target;
  const btn = document.getElementById('in-save-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('PUT', 'user_settings', {
      in_url:         f.in_url.value.trim(),
      in_token:       f.in_token.value,
      in_currency_id: f.in_currency_id.value || '',
    });
    closeModal('in-settings-modal');
    toast('Invoice Ninja settings saved');
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = 'Save';
  }
}

async function testInConnection() {
  const btn = document.querySelector('#in-settings-modal .btn-secondary');
  if (btn) btn.innerHTML = '<span class="spinner"></span>';
  try {
    const clients = await api('GET', 'invoiceninja/clients');
    cacheKnownClients(clients.map(c => c.name).filter(Boolean));
    toast(`Connected — ${clients.length} client(s) found`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Test Connection';
  }
}

function cacheKnownClients(names) {
  const existing = cacheGet('known_clients') || [];
  const merged = Array.from(new Set([...existing, ...names])).sort();
  cacheSet('known_clients', merged);
  populateDatalist('client-suggestions', merged);
}

async function openInExpenseModal(tripId) {
  const [trip, inClients] = await Promise.all([
    api('GET', `trips/${tripId}`),
    api('GET', 'invoiceninja/clients').catch(() => []),
  ]);
  cacheKnownClients(inClients.map(c => c.name).filter(Boolean));

  // Try to find a matching IN client by name
  const matched = inClients.find(c => c.name?.toLowerCase() === (trip.client_name||'').toLowerCase());

  const el = document.createElement('div');
  el.id = 'in-expense-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-title">Send to Invoice Ninja</div>

      <div class="card" style="background:var(--green-lt);border:1.5px solid var(--border);margin-bottom:16px">
        <div style="font-weight:700">${escHtml(trip.purpose)}</div>
        <div class="text-sm text-muted">${fmtDate(trip.date)} · ${fmt(trip.distance)} · ${escHtml(trip.vehicle_name||'')}</div>
        ${trip.client_name ? `<div class="text-sm" style="margin-top:4px">Client: <strong>${escHtml(trip.client_name)}</strong></div>` : ''}
      </div>

      <form onsubmit="sendInExpense(event,${tripId})">
        <div class="field">
          <label>Amount (NZD)</label>
          <input name="amount" type="number" step="0.01" min="0" id="in-amount" required
            value="${await calcTripDeduction(trip)}"
            placeholder="0.00">
          <p class="text-sm text-muted" style="margin-top:4px">Based on IRD rate × distance. Adjust if needed.</p>
        </div>

        ${inClients.length > 0 ? `
        <div class="field">
          <label>Invoice Ninja Client</label>
          <select name="client_id">
            <option value="">— No client —</option>
            ${inClients.map(c => `<option value="${escAttr(c.id)}" ${c.id===matched?.id?'selected':''}>${escHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        ` : `<input type="hidden" name="client_id" value="">`}

        <div class="field">
          <label>Notes</label>
          <textarea name="notes" rows="3">${escHtml([
            trip.purpose,
            trip.start_location && trip.end_location ? trip.start_location + ' → ' + trip.end_location : (trip.start_location || trip.end_location || ''),
            parseFloat(trip.distance).toFixed(1) + ' km',
            trip.notes || '',
          ].filter(Boolean).join('\n'))}</textarea>
        </div>

        <button type="submit" class="btn btn-primary btn-full" id="in-send-btn">
          Create Expense in Invoice Ninja
        </button>
      </form>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('in-expense-modal'); });
  document.getElementById('in-expense-modal')?.remove();
  showModalEl(el);
}

async function calcTripDeduction(trip) {
  // Look up IRD rate for this trip's fuel type and tax year
  try {
    const rates = await api('GET', 'ird_rates');
    const d = new Date(trip.date);
    const taxYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
    const ft = trip.fuel_type || 'petrol';
    const rate = rates.find(r => r.tax_year == taxYear && r.fuel_type === ft);
    if (rate) return (parseFloat(trip.distance) * parseFloat(rate.rate_standard)).toFixed(2);
  } catch (_) {}
  return '';
}

async function sendInExpense(e, tripId) {
  e.preventDefault();
  const f   = e.target;
  const btn = document.getElementById('in-send-btn');
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await api('POST', 'invoiceninja/expense', {
      trip_id:   tripId,
      amount:    parseFloat(f.amount.value),
      client_id: f.client_id?.value || null,
      notes:     f.notes.value,
    });
    closeModal('in-expense-modal');
    toast(`Expense created in Invoice Ninja${res.expense_id ? ' (#' + res.expense_id + ')' : ''}`);
  } catch (err) {
    toast(err.message, 'error');
    btn.textContent = 'Create Expense in Invoice Ninja';
  }
}

// ── User menu ─────────────────────────────────────────────────────────────────
function showUserMenu() {
  document.getElementById('user-modal')?.remove();
  const el = document.createElement('div');
  el.id = 'user-modal'; el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-height:60vh">
      <div class="modal-handle"></div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:44px;height:44px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:1.2rem">${(state.user?.username||'?')[0].toUpperCase()}</div>
        <div>
          <div style="font-weight:700">${escHtml(state.user?.username||'')}${state.user?.is_admin?' <span class="badge badge-business" style="font-size:.65rem">Admin</span>':''}</div>
          <div class="text-sm text-muted">${escHtml(state.user?.email||'')}</div>
        </div>
      </div>
      ${state.user?.is_admin ? `<button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="closeModal('user-modal');navigate('admin')">${iconShield()} Admin Panel</button>` : ''}
      <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="showInSettings()">⚡ Invoice Ninja</button>
      <button class="btn btn-danger btn-full" onclick="doLogout()">${iconLogout()} Sign Out</button>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeModal('user-modal'); });
  showModalEl(el);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
