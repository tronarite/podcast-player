'use strict';
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const phone = matchMedia('(max-width: 760px)');
const SVG = 'http://www.w3.org/2000/svg';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------- Utilidades ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento no disponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter((x) => x != null && x !== false && x !== ''));
  return e;
}
function icon(name, fill) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', 'ic' + (fill ? ' fill' : ''));
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const fmt = (s) => {
  if (!isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
// Duración legible: "45 min", "1 h 5 min".
const dur = (s) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const hue = (name) => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (name) => name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const audioUrl = (id) => '/audio/' + id.split('/').map(encodeURIComponent).join('/');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function coverEl(s) {
  const c = h('div', { class: 'cover' }, h('span', { text: initials(s.title) }));
  c.style.setProperty('--h', hue(s.name));
  if (s.cover) {
    const img = h('img', { src: s.cover, alt: '', loading: 'lazy', decoding: 'async' });
    img.onerror = () => img.remove();
    c.append(img);
  }
  return c;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sesión caducada'); }
  return r;
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- Estado ----------
let library = [], seriesIdx = -1, current = null, filter = '';
let newestFirst = store.get('newestFirst', false);
let show = store.get('show', 'all');  // all | new | started | stars
let progress = {};          // id -> { t, d, done, u }
let pending = {};           // cambios de progreso aún no enviados
let listened = {};          // día -> segundos escuchados aún no enviados
let ud = { queue: [], stars: [], bookmarks: {}, series: {}, settings: { back: 15, fwd: 30, autoplay: true } };
let stats = { secs: 0, days: {} };
let chapters = [], chapterIdx = -1;
let sleepEnd = 0, sleepIv = 0, lastTrack = 0, lastTick = 0;
const epIndex = new Map();  // id -> { ep, si }
const rows = new Map();     // id -> [filas visibles de ese episodio]

const findEpisode = (id) => epIndex.get(id) || null;
const seriesOf = (id) => library[epIndex.get(id)?.si];
const isDone = (id) => !!progress[id]?.done;
const inProgress = (id) => { const p = progress[id]; return !!p && !p.done && p.t > 5; };
const started = (id) => isDone(id) || inProgress(id);
const starred = (id) => ud.stars.includes(id);
const inQueue = (id) => ud.queue.includes(id);
const prefsOf = (s) => ud.series[s?.name] || { speed: 0, intro: 0, outro: 0 };

// ---------- Progreso y estadísticas (sincronizados con el servidor) ----------
async function flushProgress(keepalive = false) {
  const entries = pending, heard = listened;
  if (!Object.keys(entries).length && !Object.keys(heard).length) return;
  pending = {}; listened = {};
  try {
    await fetch('/api/progress', { method: 'PUT', keepalive, headers: JSON_HEADERS, body: JSON.stringify({ entries, listened: heard }) });
  } catch {
    pending = { ...entries, ...pending };
    for (const [d, v] of Object.entries(heard)) listened[d] = (listened[d] || 0) + v;
  }
}
setInterval(flushProgress, 5000);

function setProgress(id, entry) {
  progress[id] = pending[id] = { ...entry, u: Date.now() };
  paintRow(id);
}

function track(force) {
  if (!current?.ready || !isFinite(audio.duration)) return;
  const now = Date.now();
  if (!force && now - lastTrack < 3000) return;
  lastTrack = now;
  const t = audio.currentTime, d = audio.duration;
  setProgress(current.id, { t, d, done: d - t < 20 });
}

// Tiempo real escuchado (no posición): suma mientras suena.
function countListening() {
  const now = performance.now();
  if (!audio.paused && lastTick) {
    const dt = (now - lastTick) / 1000;
    if (dt > 0 && dt < 2) {
      const d = dayKey();
      listened[d] = (listened[d] || 0) + dt;
      stats.days[d] = (stats.days[d] || 0) + dt;
      stats.secs += dt;
    }
  }
  lastTick = audio.paused ? 0 : now;
}

// ---------- Cola, favoritos, marcadores y ajustes (sincronizados) ----------
let udDirty = false, udTimer = 0;
function saveUd() { udDirty = true; clearTimeout(udTimer); udTimer = setTimeout(flushUd, 600); }
async function flushUd(keepalive = false) {
  if (!udDirty) return;
  udDirty = false;
  try { await fetch('/api/userdata', { method: 'PUT', keepalive, headers: JSON_HEADERS, body: JSON.stringify(ud) }); }
  catch { udDirty = true; }
}

function saveAll() { track(true); flushProgress(true); flushUd(true); }
addEventListener('pagehide', saveAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveAll(); });

// Vuelve a pintar lo que depende de cola/favoritos/marcadores.
function refresh(id) {
  if (id) paintRow(id);
  if (seriesIdx < 0) renderMain();
  else if (show === 'stars') drawEpisodes();
  if (!$('panel').hidden) renderPanel();
}

function enqueue(id, front) {
  ud.queue = ud.queue.filter((x) => x !== id);
  front ? ud.queue.unshift(id) : ud.queue.push(id);
  saveUd(); refresh(id);
  toast(front ? 'Sonará a continuación' : 'Añadido a la cola');
}
function dequeue(id, quiet) {
  if (!inQueue(id)) return;
  ud.queue = ud.queue.filter((x) => x !== id);
  saveUd(); refresh(id);
  if (!quiet) toast('Quitado de la cola');
}
function moveInQueue(id, delta) {
  const i = ud.queue.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ud.queue.length) return;
  [ud.queue[i], ud.queue[j]] = [ud.queue[j], ud.queue[i]];
  saveUd(); refresh();
}
function toggleStar(id) {
  const on = !starred(id);
  ud.stars = on ? [id, ...ud.stars] : ud.stars.filter((x) => x !== id);
  saveUd(); refresh(id);
  toast(on ? 'Añadido a favoritos' : 'Quitado de favoritos');
}
function markPlayed(ids, done) {
  for (const id of ids) {
    const d = progress[id]?.d || 0;
    setProgress(id, done ? { t: d, d, done: true } : { t: 0, d, done: false });
  }
  toast(done ? (ids.length > 1 ? `${ids.length} episodios marcados como escuchados` : 'Marcado como escuchado') : (ids.length > 1 ? `${ids.length} episodios marcados como no escuchados` : 'Marcado como no escuchado'));
  renderRail(); renderMain();
}

function addBookmark() {
  if (!current?.ready) return;
  const list = (ud.bookmarks[current.id] ||= []);
  const t = Math.floor(audio.currentTime);
  if (!list.some((m) => m.t === t)) list.push({ t, note: '' });
  list.sort((a, b) => a.t - b.t);
  saveUd(); paintRow(current.id);
  openPanel();
  toast(`Marcador en ${fmt(t)}`);
  $('panelBody').querySelector(`[data-mark="${t}"]`)?.focus();
}
function removeBookmark(id, t) {
  const list = (ud.bookmarks[id] || []).filter((m) => m.t !== t);
  if (list.length) ud.bookmarks[id] = list; else delete ud.bookmarks[id];
  saveUd(); refresh(id);
}
function jumpTo(id, t) {
  if (current?.id === id && current.ready) { audio.currentTime = t; audio.play().catch(() => {}); return; }
  const f = findEpisode(id);
  if (f) play(f.ep, true, t);
}

async function share(id, t = 0) {
  const params = new URLSearchParams({ e: id });
  if (t > 0) params.set('t', Math.floor(t));
  const url = `${location.origin}/#${params}`;
  try { await navigator.clipboard.writeText(url); toast(t > 0 ? `Enlace copiado (en ${fmt(t)})` : 'Enlace copiado'); }
  catch { prompt('Copia el enlace:', url); }
}

// ---------- Menú contextual ----------
let menuEl = null;
function closeMenu(refocus) {
  if (!menuEl) return;
  const a = menuEl.anchor;
  a.setAttribute('aria-expanded', 'false');
  menuEl.backdrop?.remove();
  menuEl.remove(); menuEl = null;
  if (refocus) a.focus();
}
function openMenu(anchor, items, head) {
  const same = menuEl?.anchor === anchor;
  closeMenu();
  if (same) return;
  const sheet = phone.matches;
  const m = h('div', { class: 'menu' + (sheet ? ' sheet' : ''), role: 'menu' });
  if (sheet && head) m.append(h('div', { class: 'menu-head' }, coverEl(head.series), h('span', {}, h('b', { text: head.title }), h('small', { text: head.sub }))));
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    const b = h('button', { type: 'button', role: 'menuitem' }, icon(it.icon || 'more', it.fill), it.label);
    b.onclick = () => { closeMenu(true); it.run(); };
    m.append(b);
  }
  if (sheet) {
    m.backdrop = h('div', { class: 'menu-backdrop' });
    m.backdrop.onclick = () => closeMenu();
    document.body.append(m.backdrop, m);
  } else {
    document.body.append(m);
    const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
    m.style.top = (r.bottom + 4 + mh > innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  }
  m.anchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuEl = m;
  m.querySelector('button')?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target) && !menuEl.anchor.contains(e.target)) closeMenu(); });
addEventListener('resize', () => closeMenu());
addEventListener('scroll', () => { if (!menuEl?.backdrop) closeMenu(); }, { passive: true });

function episodeMenu(anchor, e, ctx) {
  const id = e.id, s = seriesOf(id), eps = s.episodes, i = eps.findIndex((x) => x.id === id);
  const qi = ud.queue.indexOf(id);
  const head = { series: s, title: e.title, sub: [s.title, e.season].filter(Boolean).join(' · ') };
  openMenu(anchor, [
    { icon: 'play', fill: true, label: current?.id === id ? 'Seguir escuchando' : 'Reproducir', run: () => play(e) },
    current?.id !== id && { icon: 'list', label: 'Reproducir a continuación', run: () => enqueue(id, true) },
    inQueue(id) ? { icon: 'x', label: 'Quitar de la cola', run: () => dequeue(id) }
      : current?.id !== id && { icon: 'list', label: 'Añadir al final de la cola', run: () => enqueue(id) },
    ctx === 'queue' && qi > 0 && { icon: 'up', label: 'Subir en la cola', run: () => moveInQueue(id, -1) },
    '-',
    isDone(id) ? { icon: 'back', label: 'Marcar como no escuchado', run: () => markPlayed([id], false) }
      : { icon: 'check', label: 'Marcar como escuchado', run: () => markPlayed([id], true) },
    i > 0 && eps.slice(0, i).some((x) => !isDone(x.id)) && { icon: 'check', label: 'Marcar anteriores como escuchados', run: () => markPlayed(eps.slice(0, i).filter((x) => !isDone(x.id)).map((x) => x.id), true) },
    { icon: 'star', fill: starred(id), label: starred(id) ? 'Quitar de favoritos' : 'Añadir a favoritos', run: () => toggleStar(id) },
    '-',
    { icon: 'link', label: 'Copiar enlace', run: () => share(id) },
    current?.id === id && current.ready && { icon: 'link', label: `Copiar enlace en ${fmt(audio.currentTime)}`, run: () => share(id, audio.currentTime) },
    ctx === 'player' && { icon: 'list', label: `Ir a ${s.title}`, run: revealCurrent },
  ], head);
}

// ---------- Diálogo ----------
function openDialog(title, body, onSave) {
  const dlg = $('dlg');
  const form = h('form', { method: 'dialog' },
    h('h2', { text: title }), body,
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', value: 'cancel', type: 'submit', text: 'Cancelar' }),
      h('button', { class: 'btn primary', value: 'ok', type: 'submit', text: 'Guardar' })));
  dlg.replaceChildren(form);
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'ok') onSave(); };
  dlg.showModal();
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { text: label }), input, hint && h('small', { text: hint }));
function selectEl(options, value) {
  const sel = h('select');
  for (const [v, label] of options) sel.append(h('option', { value: v, text: label, selected: String(v) === String(value) }));
  return sel;
}
const SPEEDS = [...$('speed').options].map((o) => [o.value, o.text]);

function seriesSettings(s) {
  const p = prefsOf(s);
  const speed = selectEl([['0', 'Usar la velocidad general'], ...SPEEDS], p.speed || 0);
  const intro = h('input', { type: 'number', min: 0, max: 900, step: 1, value: p.intro || 0, inputmode: 'numeric' });
  const outro = h('input', { type: 'number', min: 0, max: 900, step: 1, value: p.outro || 0, inputmode: 'numeric' });
  openDialog(`Ajustes de ${s.title}`, h('div', {},
    field('Velocidad de esta serie', speed),
    field('Saltar la intro (segundos)', intro, 'Empieza cada episodio nuevo a partir de este punto.'),
    field('Saltar el final (segundos)', outro, 'Pasa al siguiente episodio cuando queden estos segundos.')), () => {
    const clamp = (v) => Math.min(900, Math.max(0, Math.round(Number(v) || 0)));
    const next = { speed: Number(speed.value), intro: clamp(intro.value), outro: clamp(outro.value) };
    if (!next.speed && !next.intro && !next.outro) delete ud.series[s.name]; else ud.series[s.name] = next;
    saveUd();
    if (current?.series.name === s.name) applySpeed();
    toast('Ajustes de la serie guardados');
  });
}

function globalSettings() {
  const st = ud.settings;
  const back = selectEl([5, 10, 15, 30, 45, 60].map((n) => [n, `${n} segundos`]), st.back);
  const fwd = selectEl([10, 15, 30, 45, 60, 90].map((n) => [n, `${n} segundos`]), st.fwd);
  const auto = h('input', { type: 'checkbox', checked: st.autoplay });
  const days = Object.values(stats.days);
  openDialog('Ajustes', h('div', {},
    field('Botón retroceder', back),
    field('Botón adelantar', fwd),
    h('label', { class: 'check' }, auto, h('span', { text: 'Al terminar un episodio, reproducir el siguiente de la serie' })),
    h('p', { class: 'dlg-note', text: 'La cola «A continuación» siempre tiene prioridad sobre el siguiente de la serie.' }),
    h('h3', { text: 'Atajos de teclado' }),
    h('dl', { class: 'keys' }, ...[
      ['Espacio', 'Reproducir / pausar'], ['← →', 'Retroceder / adelantar'], ['N / P', 'Episodio siguiente / anterior'],
      ['[ ]', 'Bajar / subir velocidad'], ['B', 'Añadir marcador'], ['Q', 'Capítulos, marcadores y cola'],
    ].flatMap(([k, v]) => [h('dt', {}, h('kbd', { text: k })), h('dd', { text: v })])),
    days.length ? h('p', { class: 'dlg-note', text: `Llevas ${dur(stats.secs)} escuchados en ${days.length} días.` }) : null), () => {
    ud.settings = { back: Number(back.value), fwd: Number(fwd.value), autoplay: auto.checked };
    saveUd(); applySkipLabels();
    toast('Ajustes guardados');
  });
}

// ---------- Filas de episodios ----------
function paintRow(id) {
  const list = rows.get(id);
  if (!list) return;
  const p = progress[id];
  const pct = p && p.d && !p.done ? Math.min(100, (p.t / p.d) * 100) : 0;
  const text = p?.done ? 'Escuchado' : p?.d && p.t > 5 ? `Quedan ${dur(p.d - p.t)}` : p?.d ? dur(p.d) : '';
  const marks = ud.bookmarks[id]?.length || 0;
  const done = !!p?.done, queued = inQueue(id);
  for (const r of list) {
    r.btn.classList.toggle('done', done);
    r.bar.style.setProperty('--w', pct + '%');
    r.bar.hidden = pct <= 0;
    r.state.textContent = text;
    r.badges.replaceChildren(...[
      starred(id) && h('span', { class: 'badge star', title: 'Favorito' }, icon('star', true)),
      marks && h('span', { class: 'badge', title: `${marks} marcador${marks > 1 ? 'es' : ''}` }, icon('mark'), String(marks)),
    ].filter(Boolean));
    r.doneBtn.classList.toggle('on', done);
    r.doneBtn.setAttribute('aria-pressed', String(done));
    r.doneBtn.title = done ? 'Marcar como no escuchado' : 'Marcar como escuchado';
    r.doneBtn.setAttribute('aria-label', r.doneBtn.title);
    r.queueBtn.classList.toggle('on', queued);
    r.queueBtn.querySelector('use').setAttribute('href', queued ? '#i-queued' : '#i-plus-c');
    r.queueBtn.title = queued ? 'Quitar de la cola' : 'Añadir a la cola';
    r.queueBtn.setAttribute('aria-label', r.queueBtn.title);
  }
}

function epRow(e, ctx) {
  const s = seriesOf(e.id);
  const bar = h('div', { class: 'ep-prog', hidden: true }, h('i'));
  const state = h('span', { class: 'ep-state' }), badges = h('span', { class: 'ep-badges' });
  const num = h('span', { text: e.n }), eq = h('span', { class: 'eq', 'aria-hidden': 'true', hidden: true }, h('i'), h('i'), h('i'));
  const btn = h('button', { class: 'ep', type: 'button' },
    h('span', { class: 'ep-n' }, num, eq),
    h('span', { class: 'ep-body' },
      ctx && h('div', { class: 'ep-series', text: [s.title, e.season].filter(Boolean).join(' · ') }),
      h('div', { class: 'ep-title', text: e.title }),
      e.description && h('div', { class: 'ep-desc', text: e.description })));
  btn.onclick = () => play(e);

  const queueBtn = h('button', { class: 'icon act', type: 'button' }, icon('plus-c'));
  queueBtn.onclick = () => (inQueue(e.id) ? dequeue(e.id) : enqueue(e.id));
  const doneBtn = h('button', { class: 'icon act', type: 'button' }, icon('check-c'));
  doneBtn.onclick = () => markPlayed([e.id], !isDone(e.id));
  const more = h('button', { class: 'icon act', type: 'button', title: 'Más opciones', 'aria-label': `Más opciones de ${e.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
  more.onclick = () => episodeMenu(more, e, ctx);
  const playBtn = h('button', { class: 'icon act-play', type: 'button', 'aria-label': `Reproducir ${e.title}` }, icon('play', true));
  playBtn.onclick = () => (current?.id === e.id && !audio.paused ? audio.pause() : play(e));

  const actions = h('div', { class: 'ep-actions' },
    h('div', { class: 'ep-meta' }, h('div', { class: 'ep-meta-line' }, state, badges), bar),
    queueBtn, doneBtn, more, playBtn);
  const row = { btn, bar, state, badges, num, eq, queueBtn, doneBtn, playBtn };
  if (!rows.has(e.id)) rows.set(e.id, []);
  rows.get(e.id).push(row);
  paintRow(e.id);
  return h('li', { class: 'ep-li' }, btn, actions);
}

// El número del episodio se sustituye por el ecualizador mientras suena.
function syncPlayingRow() {
  for (const [id, list] of rows) {
    const on = current?.id === id;
    for (const r of list) {
      r.btn.classList.toggle('playing', on);
      r.btn.classList.toggle('running', on && !audio.paused);
      r.eq.hidden = !on; r.num.hidden = on;
      r.playBtn.querySelector('use').setAttribute('href', on && !audio.paused ? '#i-pause' : '#i-play');
      r.playBtn.classList.toggle('on', on);
    }
  }
}

// ---------- Vista: barra lateral ----------
function go(i) {
  seriesIdx = i; filter = '';
  store.set('view', i >= 0 ? library[i].name : '');
  renderRail(); renderMain(); scrollTo(0, 0);
}

function renderRail() {
  const nav = $('series');
  const home = h('button', { class: 'series-btn home-btn', type: 'button', title: 'Inicio', 'aria-current': seriesIdx < 0 && 'true' },
    h('div', { class: 'cover home-cover' }, icon('home')),
    h('span', {}, h('div', { class: 'name', text: 'Inicio' }), h('div', { class: 'count', text: 'Continuar, cola y favoritos' })));
  home.onclick = () => go(-1);
  nav.replaceChildren(home, ...library.map((s, i) => {
    const left = s.episodes.filter((e) => !isDone(e.id)).length;
    const anyStarted = s.episodes.some((e) => started(e.id));
    const seasons = new Set(s.episodes.map((e) => e.season).filter(Boolean)).size;
    const count = anyStarted ? (left ? `${left} por escuchar` : 'Todo escuchado') : seasons > 1 ? `${seasons} temporadas · ${s.episodes.length} ep.` : `${s.episodes.length} episodios`;
    const b = h('button', { class: 'series-btn', type: 'button', title: s.title, 'aria-current': i === seriesIdx && 'true' },
      coverEl(s), h('span', {}, h('div', { class: 'name', text: s.title }), h('div', { class: 'count', text: count })));
    b.onclick = () => go(i);
    return b;
  }));
}

function renderMain() {
  closeMenu();
  if (seriesIdx < 0 || !library[seriesIdx]) return renderHome();
  const s = library[seriesIdx], main = $('main');
  rows.clear();

  // Continuar: el último episodio empezado (o el siguiente si ya lo terminaste).
  const lastIdx = s.episodes.findLastIndex((e) => started(e.id));
  const resumeTarget = lastIdx < 0 ? s.episodes[0]
    : isDone(s.episodes[lastIdx].id) ? s.episodes.slice(lastIdx + 1).find((e) => !isDone(e.id)) || s.episodes.find((e) => !isDone(e.id)) || s.episodes[0]
    : s.episodes[lastIdx];
  const resume = h('button', { class: 'btn primary', type: 'button' }, icon('play', true),
    h('span', { class: 'btn-label', text: lastIdx >= 0 ? `Continuar · ${resumeTarget.title}` : 'Empezar a escuchar' }));
  resume.onclick = () => play(resumeTarget);

  const actions = h('div', { class: 'actions' }, resume);
  const filterSel = selectEl([['all', 'Todos'], ['new', 'Sin escuchar'], ['started', 'En curso'], ['stars', 'Favoritos']], show);
  filterSel.className = 'filter'; filterSel.setAttribute('aria-label', 'Mostrar');
  filterSel.onchange = () => { show = filterSel.value; store.set('show', show); drawEpisodes(); };
  actions.append(filterSel);
  if (s.episodes.length > 1) {
    const sort = h('button', { class: 'btn sort', type: 'button', 'aria-pressed': String(newestFirst), title: newestFirst ? 'Más recientes primero' : 'Orden de emisión', 'aria-label': 'Orden' }, icon('sort'), h('span', { class: 'btn-label', text: newestFirst ? 'Recientes' : 'En orden' }));
    sort.onclick = () => { newestFirst = !newestFirst; store.set('newestFirst', newestFirst); renderMain(); };
    actions.append(sort);
  }
  const seriesMore = h('button', { class: 'btn icon-btn', type: 'button', 'aria-label': 'Más opciones de la serie', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
  seriesMore.onclick = () => {
    const unplayed = s.episodes.filter((e) => !isDone(e.id));
    openMenu(seriesMore, [
      { icon: 'gear', label: 'Ajustes de la serie…', run: () => seriesSettings(s) },
      '-',
      unplayed.length && { icon: 'list', label: `Añadir ${Math.min(unplayed.length, 50)} sin escuchar a la cola`, run: () => {
        for (const e of unplayed.slice(0, 50)) if (!inQueue(e.id)) ud.queue.push(e.id);
        saveUd(); refresh(); drawEpisodes(); toast('Añadidos a la cola');
      } },
      unplayed.length && { icon: 'check', label: 'Marcar todo como escuchado', run: () => markPlayed(unplayed.map((e) => e.id), true) },
      s.episodes.some((e) => started(e.id)) && { icon: 'back', label: 'Marcar todo como no escuchado', run: () => markPlayed(s.episodes.filter((e) => started(e.id)).map((e) => e.id), false) },
    ]);
  };
  actions.append(seriesMore);
  if (s.episodes.length > 12) {
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Buscar episodio', 'aria-label': 'Buscar episodio', value: filter });
    search.oninput = () => { filter = search.value; drawEpisodes(); };
    actions.append(search);
  }

  const desc = s.description ? h('p', { class: 'desc clamp', text: s.description }) : null;
  const more = h('button', { class: 'more', type: 'button', hidden: true, text: 'Leer más' });
  more.onclick = () => { const open = desc.classList.toggle('clamp'); more.textContent = open ? 'Leer más' : 'Leer menos'; };

  const done = s.episodes.filter((e) => isDone(e.id)).length;
  const p = prefsOf(s);
  const eyebrow = [s.kind, s.year].filter(Boolean).join(' · ');
  const facts = [
    done ? `${done} de ${s.episodes.length} escuchados` : `${s.episodes.length} episodios`,
    p.speed && `${p.speed}×`, p.intro && `salta ${p.intro} s de intro`, p.outro && `salta ${p.outro} s del final`,
  ].filter(Boolean).join(' · ');
  const hero = h('header', { class: 'hero' },
    coverEl(s),
    h('div', { class: 'hero-meta' },
      eyebrow && h('p', { class: 'eyebrow', text: eyebrow }),
      h('h1', { text: s.title }),
      s.author && h('p', { class: 'byline', text: s.author })),
    h('div', { class: 'hero-body' }, desc, desc && more, s.credits && h('p', { class: 'credits', text: s.credits }),
      h('p', { class: 'facts', text: facts }), actions));

  // Temporadas: pestañas si la serie tiene más de una.
  const seasons = [...new Set(s.episodes.map((e) => e.season).filter(Boolean))];
  let tabs = null;
  if (seasons.length > 1) {
    const key = 'season:' + s.name;
    let sel = store.get(key, null);
    if (sel !== '*' && !seasons.includes(sel)) sel = resumeTarget.season || seasons[0];
    tabs = h('div', { class: 'seasons', role: 'tablist', 'aria-label': 'Temporadas' });
    const paintTabs = () => {
      tabs.replaceChildren(...[...seasons, '*'].map((name) => {
        const eps = name === '*' ? s.episodes : s.episodes.filter((e) => e.season === name);
        const left = eps.filter((e) => !isDone(e.id)).length;
        const b = h('button', { class: 'season', type: 'button', role: 'tab', 'aria-selected': String(name === sel) },
          name === '*' ? 'Todas' : name, h('small', { text: left && left < eps.length ? `${left}/${eps.length}` : String(eps.length) }));
        b.onclick = () => { sel = name; store.set(key, name); paintTabs(); drawEpisodes(); };
        return b;
      }));
    };
    paintTabs();
    tabs.selected = () => sel;
  }

  const list = h('ol', { class: 'eps', id: 'eps' });
  list.tabs = tabs;
  main.replaceChildren(hero, tabs, list);
  drawEpisodes();
  if (desc) requestAnimationFrame(() => { more.hidden = desc.scrollHeight <= desc.clientHeight + 1; });
}

function drawEpisodes() {
  const s = library[seriesIdx], list = $('eps');
  if (!s || !list) return;
  rows.clear();
  const q = filter.toLowerCase();
  const season = list.tabs && !q ? list.tabs.selected() : '*';
  const keep = { all: () => true, new: (e) => !isDone(e.id), started: (e) => inProgress(e.id), stars: (e) => starred(e.id) }[show] || (() => true);
  let eps = s.episodes.filter((e) => (season === '*' || e.season === season) && keep(e) &&
    (!q || e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)));
  if (newestFirst) eps = [...eps].reverse();
  if (!eps.length) {
    const msg = q ? 'Ningún episodio coincide con la búsqueda.' : { new: 'Ya lo has escuchado todo aquí.', started: 'No tienes episodios a medias.', stars: 'Aún no hay favoritos. Márcalos desde el menú ⋯ de cada episodio.' }[show] || 'No hay episodios.';
    list.replaceChildren(h('li', { class: 'empty', text: msg }));
    return;
  }
  // Con «Todas» se muestran encabezados de temporada.
  const showHeads = list.tabs && season === '*' && !newestFirst;
  let last = null;
  const items = [];
  for (const e of eps) {
    if (showHeads && e.season !== last) { last = e.season; items.push(h('li', { class: 'season-head', text: e.season })); }
    items.push(epRow(e));
  }
  list.replaceChildren(...items);
  syncPlayingRow();
}

// ---------- Vista: inicio ----------
function card(e) {
  const s = seriesOf(e.id), p = progress[e.id];
  const pct = p && p.d && !p.done ? Math.min(100, (p.t / p.d) * 100) : 0;
  const bar = pct > 0 && h('div', { class: 'ep-prog' }, h('i'));
  if (bar) bar.style.setProperty('--w', pct + '%');
  const b = h('button', { class: 'card', type: 'button' },
    coverEl(s),
    h('span', { class: 'card-text' },
      h('small', { text: [s.title, e.season].filter(Boolean).join(' · ') }),
      h('b', { text: e.title }),
      h('span', { class: 'card-meta' }, p && p.t > 5 && !p.done ? `Quedan ${dur(p.d - p.t)}` : p?.d ? dur(p.d) : 'Siguiente episodio'),
      bar));
  b.onclick = () => play(e);
  return b;
}

function streak() {
  let n = 0;
  const d = new Date();
  if (!(stats.days[dayKey(d)] >= 60)) d.setDate(d.getDate() - 1);
  while (stats.days[dayKey(d)] >= 60) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderHome() {
  const main = $('main');
  rows.clear();
  const section = (title, extra, ...kids) => h('section', { class: 'home-sec' }, h('div', { class: 'sec-head' }, h('h2', { text: title }), extra), ...kids);

  const cont = Object.entries(progress).filter(([id, p]) => epIndex.has(id) && !p.done && p.t > 5)
    .sort((a, b) => (b[1].u || 0) - (a[1].u || 0)).slice(0, 8).map(([id]) => epIndex.get(id).ep);
  // Siguiente de cada serie empezada cuyo último episodio está terminado.
  const nextUp = [];
  for (const s of library) {
    const lastIdx = s.episodes.findLastIndex((e) => started(e.id));
    if (lastIdx < 0 || !isDone(s.episodes[lastIdx].id)) continue;
    const nx = s.episodes.slice(lastIdx + 1).find((e) => !isDone(e.id));
    if (nx && !cont.includes(nx)) nextUp.push(nx);
  }

  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return stats.days[dayKey(d)] || 0; })
    .reduce((a, b) => a + b, 0);
  const finished = Object.entries(progress).filter(([id, p]) => p.done && epIndex.has(id)).length;
  const tiles = h('div', { class: 'tiles' }, ...[
    ['Escuchado en total', stats.secs >= 60 ? dur(stats.secs) : '—'],
    ['Últimos 7 días', week >= 60 ? dur(week) : '—'],
    ['Episodios terminados', String(finished)],
    ['Racha', streak() ? `${streak()} día${streak() > 1 ? 's' : ''}` : '—'],
  ].map(([k, v]) => h('div', { class: 'tile' }, h('b', { text: v }), h('small', { text: k }))));

  const queue = ud.queue.filter((id) => epIndex.has(id));
  const clearQ = queue.length > 1 && h('button', { class: 'link-btn', type: 'button', text: 'Vaciar' });
  if (clearQ) clearQ.onclick = () => { ud.queue = []; saveUd(); refresh(); toast('Cola vaciada'); };
  const stars = ud.stars.filter((id) => epIndex.has(id));
  const marks = Object.entries(ud.bookmarks).filter(([id]) => epIndex.has(id));

  const greeting = (() => { const hr = new Date().getHours(); return hr < 6 ? 'Buenas noches' : hr < 14 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches'; })();
  main.replaceChildren(...[
    h('header', { class: 'home-head' }, h('p', { class: 'eyebrow', text: greeting }), h('h1', { text: 'Inicio' })),
    cont.length || nextUp.length
      ? section('Continuar escuchando', null, h('div', { class: 'cards' }, ...cont.map(card), ...nextUp.slice(0, 8).map(card)))
      : section('Empieza por aquí', null, h('div', { class: 'cards' }, ...library.slice(0, 8).map((s) => card(s.episodes[0])))),
    section('A continuación', clearQ, queue.length
      ? h('ol', { class: 'eps' }, ...queue.map((id) => epRow(epIndex.get(id).ep, 'queue')))
      : h('p', { class: 'hint', text: 'Tu cola está vacía. Usa el menú ⋯ de cualquier episodio para añadirlo.' })),
    stars.length ? section('Favoritos', null, h('ol', { class: 'eps' }, ...stars.map((id) => epRow(epIndex.get(id).ep, 'stars')))) : null,
    marks.length ? section('Marcadores', null, h('ul', { class: 'marks' }, ...marks.flatMap(([id, list]) => {
      const { ep } = epIndex.get(id), s = seriesOf(id);
      return list.map((m) => {
        const b = h('button', { class: 'mark-row', type: 'button' }, h('span', { class: 'mark-t', text: fmt(m.t) }),
          h('span', {}, h('b', { text: m.note || ep.title }), h('small', { text: m.note ? `${ep.title} · ${s.title}` : s.title })));
        b.onclick = () => jumpTo(id, m.t);
        return h('li', {}, b);
      });
    }))) : null,
    section('Tus estadísticas', null, tiles),
  ].filter(Boolean));
  syncPlayingRow();
}

// ---------- Panel: capítulos, marcadores y cola ----------
function openPanel() {
  if (!current) return;
  $('panel').hidden = false;
  $('panelBtn').setAttribute('aria-expanded', 'true');
  document.body.classList.add('panel-open');
  renderPanel();
}
function closePanel() {
  $('panel').hidden = true;
  $('panelBtn').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('panel-open');
}

function renderPanel() {
  const body = $('panelBody');
  if (!current) return body.replaceChildren();
  const id = current.id, parts = [];
  const sec = (title, ...kids) => h('section', { class: 'pn-sec' }, h('h3', { text: title }), ...kids);

  if (chapters.length) {
    parts.push(sec('Capítulos', h('ol', { class: 'chapters' }, ...chapters.map((c, i) => {
      const b = h('button', { type: 'button', class: 'chap' + (i === chapterIdx ? ' on' : ''), 'data-chap': i },
        h('span', { class: 'mark-t', text: fmt(c.start) }), h('span', { text: c.title }));
      b.onclick = () => { audio.currentTime = c.start + 0.01; audio.play().catch(() => {}); };
      return h('li', {}, b);
    }))));
  }

  const list = ud.bookmarks[id] || [];
  const addBtn = h('button', { class: 'btn small', type: 'button' }, icon('mark'), `Añadir en ${fmt(audio.currentTime)}`);
  addBtn.onclick = addBookmark;
  const shareBtn = h('button', { class: 'btn small', type: 'button' }, icon('link'), 'Copiar enlace a este momento');
  shareBtn.onclick = () => share(id, audio.currentTime);
  parts.push(sec('Marcadores',
    list.length ? h('ul', { class: 'pn-marks' }, ...list.map((m) => {
      const jump = h('button', { class: 'mark-t', type: 'button', text: fmt(m.t), 'aria-label': `Ir a ${fmt(m.t)}` });
      jump.onclick = () => jumpTo(id, m.t);
      const note = h('input', { type: 'text', maxlength: 200, placeholder: 'Añade una nota', value: m.note, 'data-mark': m.t, 'aria-label': `Nota del marcador en ${fmt(m.t)}` });
      note.onchange = () => { m.note = note.value.trim(); saveUd(); };
      note.onkeydown = (e) => { if (e.key === 'Enter') note.blur(); };
      const del = h('button', { class: 'icon', type: 'button', 'aria-label': 'Borrar marcador' }, icon('x'));
      del.onclick = () => removeBookmark(id, m.t);
      return h('li', {}, jump, note, del);
    })) : h('p', { class: 'hint', text: 'Guarda momentos para volver a ellos (tecla B).' }),
    h('div', { class: 'pn-actions' }, addBtn, shareBtn)));

  const queue = ud.queue.filter((x) => epIndex.has(x) && x !== id);
  const after = queue.length ? null : nextInSeries();
  parts.push(sec('A continuación',
    queue.length ? h('ol', { class: 'pn-queue' }, ...queue.map((qid, i) => {
      const { ep } = epIndex.get(qid), s = seriesOf(qid);
      const b = h('button', { class: 'pn-q', type: 'button' }, h('b', { text: ep.title }), h('small', { text: s.title }));
      b.onclick = () => play(ep);
      const up = i > 0 && h('button', { class: 'icon', type: 'button', 'aria-label': 'Subir' }, icon('up'));
      if (up) up.onclick = () => moveInQueue(qid, -1);
      const del = h('button', { class: 'icon', type: 'button', 'aria-label': 'Quitar de la cola' }, icon('x'));
      del.onclick = () => dequeue(qid, true);
      return h('li', {}, b, up || h('span'), del);
    }))
      : h('p', { class: 'hint', text: after && ud.settings.autoplay ? `Después sonará «${after.title}».` : 'La cola está vacía.' })));
  body.replaceChildren(...parts);
}

// ---------- Capítulos ----------
function updateChapter(force) {
  let i = -1;
  for (let k = 0; k < chapters.length; k++) if (chapters[k].start <= audio.currentTime + 0.5) i = k;
  if (i === chapterIdx && !force) return;
  chapterIdx = i;
  $('pChapter').hidden = i < 0;
  $('pChapter').textContent = i >= 0 ? chapters[i].title : '';
  for (const b of $('panelBody').querySelectorAll('[data-chap]')) b.classList.toggle('on', Number(b.dataset.chap) === i);
}

// ---------- Reproducción ----------
function applySpeed() {
  const p = prefsOf(current?.series);
  const speed = p.speed || Number(store.get('speed', '1'));
  audio.playbackRate = speed;
  $('speed').value = String(speed);
  syncPosition();
}

function syncPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !isFinite(audio.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); }
  catch { /* posición no soportada */ }
}

function play(ep, autoplay = true, at = null) {
  const found = findEpisode(ep.id);
  if (!found) return;
  const s = library[found.si];
  if (current?.id === ep.id && current.ready && at == null) { if (autoplay) audio.play().catch(() => {}); return; }
  track(true); // guarda el punto del episodio que se deja
  dequeue(ep.id, true);
  current = { ...ep, si: found.si, series: s, ready: false, finished: false };
  const saved = progress[ep.id], p = prefsOf(s);
  let startAt = at ?? (saved && !saved.done ? saved.t : 0);
  if (at == null && p.intro && startAt < p.intro) startAt = p.intro;
  audio.src = audioUrl(ep.id);
  audio.addEventListener('loadedmetadata', () => {
    if (startAt) audio.currentTime = Math.min(startAt, Math.max(0, audio.duration - 1));
    current.ready = true;
    $('dur').textContent = fmt(audio.duration);
    syncPosition();
  }, { once: true });
  applySpeed();
  if (autoplay) audio.play().catch(() => {});

  chapters = []; chapterIdx = -1; updateChapter(true);
  if (ep.ch) {
    api('/api/chapters?id=' + encodeURIComponent(ep.id)).then((r) => r.json()).then((c) => {
      if (current?.id !== ep.id || !Array.isArray(c)) return;
      chapters = c; updateChapter(true);
      if (!$('panel').hidden) renderPanel();
    }).catch(() => {});
  }

  $('player').hidden = false;
  document.body.classList.add('has-player');
  $('pCover').replaceWith(Object.assign(coverEl(s), { id: 'pCover' }));
  $('pTitle').textContent = ep.title;
  $('pSeries').textContent = [s.title, ep.season].filter(Boolean).join(' · ');
  $('pDesc').textContent = ep.description;
  document.title = `${ep.title} · ${s.title}`;
  store.set('last', ep.id);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title, artist: s.author || s.title, album: s.title,
      artwork: s.cover ? [{ src: s.cover, sizes: '512x512' }] : [],
    });
  }
  syncPlayingRow();
  if (!$('panel').hidden) renderPanel();
}

function nextInSeries() {
  if (!current) return null;
  const eps = library[current.si].episodes;
  return eps[eps.findIndex((e) => e.id === current.id) + 1] || null;
}
function nextEpisode() {
  const q = ud.queue.find((id) => id !== current?.id && epIndex.has(id));
  if (q) return epIndex.get(q).ep;
  return ud.settings.autoplay ? nextInSeries() : null;
}

function step(delta) {
  if (!current) return;
  if (delta > 0) { const n = ud.queue.find((id) => id !== current.id && epIndex.has(id)); if (n) return play(epIndex.get(n).ep); }
  const eps = library[current.si].episodes;
  const target = eps[eps.findIndex((e) => e.id === current.id) + delta];
  if (target) play(target);
}

// Fin del episodio (real o por «saltar el final»): marca, respeta el temporizador y sigue.
function finish() {
  if (!current || current.finished) return;
  current.finished = true;
  const d = audio.duration || 0;
  setProgress(current.id, { t: d, d, done: true });
  if ($('sleep').value === 'end') { stopSleep(); audio.pause(); toast('Temporizador: fin del episodio'); return; }
  const next = nextEpisode();
  if (next) play(next); else audio.pause();
}

function setPlayIcon(playing) {
  for (const id of ['play', 'miniPlay']) {
    const b = $(id);
    b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    b.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  }
}

audio.addEventListener('timeupdate', () => {
  $('cur').textContent = fmt(audio.currentTime);
  if (isFinite(audio.duration) && audio.duration > 0) {
    const pct = (audio.currentTime / audio.duration) * 100;
    $('seek').value = pct * 10;
    $('seek').style.setProperty('--p', pct + '%');
    $('pBar').style.setProperty('--w', pct + '%');
    const outro = prefsOf(current?.series).outro;
    if (outro && current?.ready && !audio.paused && audio.duration > outro + 60 && audio.duration - audio.currentTime <= outro) finish();
  }
  countListening();
  if (chapters.length) updateChapter();
  track();
});
audio.addEventListener('durationchange', () => { $('dur').textContent = fmt(audio.duration); });
audio.addEventListener('play', () => { lastTick = performance.now(); setPlayIcon(true); syncPlayingRow(); syncPosition(); });
audio.addEventListener('pause', () => { countListening(); lastTick = 0; setPlayIcon(false); track(true); syncPlayingRow(); });
audio.addEventListener('seeked', syncPosition);
audio.addEventListener('ratechange', syncPosition);
audio.addEventListener('ended', finish);
audio.addEventListener('error', async () => {
  const me = await fetch('/api/me').catch(() => null);
  if (me && me.status === 401) return location.replace('/login.html');
  $('pSeries').textContent = 'No se pudo reproducir este archivo';
});

// ---------- Temporizador de apagado (con fundido final) ----------
const baseVolume = () => Number($('vol').value);
function stopSleep() {
  clearInterval(sleepIv); sleepEnd = 0;
  $('sleep').value = '0';
  $('sleepLeft').hidden = true;
  audio.volume = baseVolume();
}
function tickSleep() {
  const left = (sleepEnd - Date.now()) / 1000;
  if (left <= 0) { audio.pause(); stopSleep(); toast('Temporizador: reproducción en pausa'); return; }
  $('sleepLeft').textContent = fmt(left);
  $('sleepLeft').hidden = false;
  audio.volume = baseVolume() * Math.min(1, left / 15);
}
$('sleep').onchange = (e) => {
  const v = e.target.value;
  clearInterval(sleepIv); sleepEnd = 0; audio.volume = baseVolume();
  $('sleepLeft').hidden = v !== 'end';
  $('sleepLeft').textContent = v === 'end' ? 'fin del ep.' : '';
  const mins = Number(v);
  if (mins > 0) { sleepEnd = Date.now() + mins * 60000; sleepIv = setInterval(tickSleep, 1000); tickSleep(); }
};

// ---------- Controles ----------
function applySkipLabels() {
  const { back, fwd } = ud.settings;
  $('back').querySelector('.num').textContent = back;
  $('fwd').querySelector('.num').textContent = fwd;
  $('back').title = `Retroceder ${back} s (←)`; $('back').setAttribute('aria-label', `Retroceder ${back} segundos`);
  $('fwd').title = `Adelantar ${fwd} s (→)`; $('fwd').setAttribute('aria-label', `Adelantar ${fwd} segundos`);
}
const toggle = () => { if (current) audio.paused ? audio.play() : audio.pause(); };
$('play').onclick = $('miniPlay').onclick = toggle;
$('prev').onclick = () => (audio.currentTime > 5 ? (audio.currentTime = 0) : step(-1));
$('next').onclick = () => step(1);
$('back').onclick = () => (audio.currentTime = Math.max(0, audio.currentTime - ud.settings.back));
$('fwd').onclick = () => (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + ud.settings.fwd));
$('seek').oninput = (e) => {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = (e.target.value / 1000) * audio.duration;
  e.target.style.setProperty('--p', e.target.value / 10 + '%');
};
// Si la serie tiene velocidad propia, el selector cambia la de la serie; si no, la general.
function setSpeed(v) {
  const s = current?.series;
  if (s && ud.series[s.name]?.speed) { ud.series[s.name].speed = Number(v); saveUd(); }
  else store.set('speed', String(v));
  applySpeed();
}
$('speed').onchange = (e) => setSpeed(e.target.value);
function nudgeSpeed(dir) {
  const opts = SPEEDS.map(([v]) => Number(v));
  const i = opts.indexOf(audio.playbackRate);
  const next = opts[Math.min(opts.length - 1, Math.max(0, (i < 0 ? opts.indexOf(1) : i) + dir))];
  setSpeed(next);
  toast(`Velocidad ${next}×`);
}
$('vol').oninput = (e) => {
  audio.volume = Number(e.target.value);
  e.target.style.setProperty('--p', e.target.value * 100 + '%');
  store.set('vol', e.target.value);
};
$('mark').onclick = addBookmark;
$('pMore').onclick = () => { if (current) episodeMenu($('pMore'), current, 'player'); };
$('panelBtn').onclick = () => ($('panel').hidden ? openPanel() : closePanel());
$('panelClose').onclick = closePanel;
$('settings').onclick = globalSettings;
$('logout').onclick = async () => {
  audio.pause(); track(true); await Promise.all([flushProgress(), flushUd()]);
  await fetch('/api/logout', { method: 'POST', headers: JSON_HEADERS, body: '{}' }).catch(() => {});
  location.replace('/login.html');
};

// En móvil el mini reproductor se abre a pantalla completa; en escritorio lleva al episodio.
function setSheet(open) {
  $('player').classList.toggle('expanded', open);
  document.body.classList.toggle('sheet-open', open);
}
// Abre la serie del episodio en curso y lo muestra en la lista.
function revealCurrent() {
  if (!current) return;
  setSheet(false);
  if (seriesIdx !== current.si) go(current.si);
  if (!rows.has(current.id) && current.season) { store.set('season:' + current.series.name, current.season); renderMain(); }
  rows.get(current.id)?.[0]?.btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
$('pToggle').onclick = () => {
  if (!current) return;
  if (phone.matches) return setSheet(true);
  revealCurrent();
};
$('pClose').onclick = () => setSheet(false);
phone.addEventListener('change', () => setSheet(false));

if ('mediaSession' in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* acción no soportada */ } };
  on('play', () => audio.play()); on('pause', () => audio.pause());
  on('previoustrack', () => step(-1)); on('nexttrack', () => step(1));
  on('seekbackward', () => $('back').click()); on('seekforward', () => $('fwd').click());
  on('seekto', (d) => { if (d.seekTime != null) { audio.currentTime = d.seekTime; syncPosition(); } });
}

document.addEventListener('keydown', (e) => {
  if (menuEl) {
    const items = [...menuEl.querySelectorAll('button')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); return closeMenu(true); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return; }
    if (e.key === 'Tab') closeMenu();
  }
  if (e.key === 'Escape') {
    if ($('dlg').open) return;
    if (!$('panel').hidden) return closePanel();
    return setSheet(false);
  }
  const t = e.target;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'range') return;
  if (t.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;
  if (e.metaKey || e.ctrlKey || e.altKey || $('dlg').open) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowLeft' && t.type !== 'range') { e.preventDefault(); $('back').click(); }
  else if (e.key === 'ArrowRight' && t.type !== 'range') { e.preventDefault(); $('fwd').click(); }
  else if (k === 'n') $('next').click();
  else if (k === 'p') $('prev').click();
  else if (k === 'b') addBookmark();
  else if (k === 'q') $('panelBtn').click();
  else if (e.key === '[') nudgeSpeed(-1);
  else if (e.key === ']') nudgeSpeed(1);
});

// ---------- Arranque ----------
(async function init() {
  fetch('/api/me').then((r) => r.json()).then((m) => { $('logout').hidden = !m.auth; }).catch(() => {});
  $('speed').value = store.get('speed', '1');
  const vol = store.get('vol', '1');
  $('vol').value = vol; audio.volume = Number(vol); $('vol').style.setProperty('--p', vol * 100 + '%');
  try {
    const [lib, prog, user] = await Promise.all([api('/api/library'), api('/api/progress'), api('/api/userdata')]);
    const data = await lib.json();
    if (!lib.ok) throw new Error(data.error);
    library = data;
    progress = await prog.json();
    if (user.ok) {
      const { stats: st, ...rest } = await user.json();
      ud = rest; stats = st || stats;
    }
  } catch (e) {
    if (e.message !== 'Sesión caducada') $('main').replaceChildren(h('p', { class: 'empty', text: 'Error: ' + e.message }));
    return;
  }
  library.forEach((s, si) => s.episodes.forEach((ep) => epIndex.set(ep.id, { ep, si })));
  applySkipLabels();

  // Una sola vez: pasar al servidor el progreso que guardaba la versión anterior en este navegador.
  const legacy = store.get('progress', null);
  if (legacy) {
    for (const [id, p] of Object.entries(legacy)) if (!progress[id]) progress[id] = pending[id] = p;
    store.del('progress');
    flushProgress();
  }

  const view = store.get('view', '');
  seriesIdx = view ? library.findIndex((s) => s.name === view) : -1;

  // Enlace compartido: #e=<episodio>&t=<segundos>
  const hash = new URLSearchParams(location.hash.slice(1));
  const shared = findEpisode(hash.get('e') || '');
  if (shared) {
    history.replaceState(null, '', location.pathname);
    seriesIdx = shared.si;
    if (shared.ep.season) store.set('season:' + library[shared.si].name, shared.ep.season);
    renderRail(); renderMain();
    play(shared.ep, false, Number(hash.get('t')) || 0);
    toast('Pulsa reproducir para escuchar desde el enlace');
    return;
  }
  renderRail(); renderMain();
  const last = findEpisode(store.get('last', ''));
  if (last) play(last.ep, false);
})();
