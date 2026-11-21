'use strict';

const TYPE_ICON = {
  'góra': '⛰️', 'przełęcz': '🪨', 'schronisko': '🏠', 'miasto': '🏘️', 'polana': '🌾', 'inne': '📍',
};
// Słowa na początku nazwy, które można pominąć przy wpisywaniu
// („Kubalonka” zamiast „Przełęcz Kubalonka”, „Stare Wierchy” zamiast „Schronisko PTTK Stare Wierchy”).
const OPTIONAL_PREFIXES = ['przelecz', 'hala', 'schronisko', 'pttk', 'stacja', 'turystyczna', 'na'];
const DEFAULT_THRESHOLD = 80;
const THRESHOLD_KEY = 'gsb.threshold';
const TRAIL_KEY = 'gsb.trail';
const MODE_KEY = 'gsb.mode';
const TOKEN_KEY = 'gsb.token';
const ROLE_LABEL = { admin: 'Administrator', editor: 'Edytor', user: 'Użytkownik' };
const DIFFICULTIES = ['łatwy', 'średni', 'trudny'];
const TYPES = Object.keys(TYPE_ICON);

const $ = (id) => document.getElementById(id);

const state = {
  api: false,        // true = dane z API (szlaki.kj88.pl), false = pliki JSON (GitHub Pages)
  token: loadToken(),
  user: null,        // zalogowany użytkownik {id, login, role}
  editing: false,    // tryb edycji na liście punktów
  startedAt: 0,      // początek bieżącej sesji nauki (do zapisu wyniku)
  trails: [],        // lista szlaków
  trail: null,       // wybrany szlak
  reversed: false,   // false: kierunek jak w pliku (wg id), true: odwrotnie
  part: null,        // null = cały szlak
  points: [],        // punkty w bieżącej sesji (w kolejności nauki)
  index: 0,
  hintLevel: 0,
  mistakes: 0,
  revealed: 0,
  close: 0,          // zaliczone z literówką (zgodność < 100%)
  threshold: loadThreshold(),
  mode: loadMode(),  // 'type' – wpisywanie, 'order' – układanie klocków (tylko pasma), 'between' – pomiędzy
  level: loadLevel(), // poziom trudności nauki
  order: null,       // stan układanki
};

// --- ustawienia (localStorage może być niedostępny – wtedy domyślne) ----------

function loadThreshold() {
  try {
    const v = Number(localStorage.getItem(THRESHOLD_KEY));
    if (v >= 50 && v <= 100) return v;
  } catch {}
  return DEFAULT_THRESHOLD;
}

function saveThreshold(v) {
  try { localStorage.setItem(THRESHOLD_KEY, String(v)); } catch {}
}

function loadTrailId() {
  try { return localStorage.getItem(TRAIL_KEY); } catch { return null; }
}

function saveTrailId(id) {
  try { localStorage.setItem(TRAIL_KEY, id); } catch {}
}

function loadMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return ['order', 'between'].includes(m) ? m : 'type';
  } catch { return 'type'; }
}

// Poziom trudności nauki: łatwy = tylko łatwe punkty, średni = łatwe + średnie, trudny = wszystkie.
const LEVEL_KEY = 'gsb.level';
const LEVEL_RANK = { 'łatwy': 0, 'średni': 1, 'trudny': 2 };

function loadLevel() {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    if (v in LEVEL_RANK) return v;
  } catch {}
  return 'łatwy';
}

// Punkt bez poziomu (np. dane z plików JSON) traktujemy jak łatwy.
const inLevel = (p) => LEVEL_RANK[p.difficulty || 'łatwy'] <= LEVEL_RANK[state.level];

function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}

function loadToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

const canEdit = () => state.api && state.user && ['admin', 'editor'].includes(state.user.role);
const isAdmin = () => state.api && state.user && state.user.role === 'admin';

// --- porównywanie odpowiedzi ---------------------------------------------------

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Akceptowane warianty nazwy: pełna, bez dopisku w nawiasie, sam dopisek z nawiasu
// („Chatka Puchatka (Hasiakowa Skała)” → „Chatka Puchatka” / „Hasiakowa Skała”),
// oraz każdy z nich bez przedrostka typu „Przełęcz”.
function variants(label) {
  const paren = label.match(/\(([^)]*)\)/);
  const forms = [label, label.replace(/\s*\([^)]*\)/, '')];
  if (paren) forms.push(paren[1]);
  const out = new Set();
  for (const f of forms.map(normalize)) {
    const words = f.split(' ');
    out.add(f);
    // Zdejmujemy kolejne słowa z początku, dopóki są na liście (zostawiając co najmniej jedno).
    while (words.length > 1 && OPTIONAL_PREFIXES.includes(words[0])) {
      words.shift();
      out.add(words.join(' '));
    }
  }
  return out;
}

// Odległość Levenshteina: ile liter trzeba dodać / usunąć / zamienić.
function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// Zgodność odpowiedzi z nazwą w procentach (0–100), najlepsza z wariantów.
// Spacje są pomijane, więc „duzejaslo” = „Duże Jasło”.
function similarity(input, label) {
  const a = normalize(input).replace(/ /g, '');
  if (!a) return 0;
  let best = 0;
  for (const v of variants(label)) {
    const b = v.replace(/ /g, '');
    const score = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    best = Math.max(best, score);
  }
  return Math.round(best * 100);
}

function matches(input, label, threshold = 100) {
  return similarity(input, label) >= threshold;
}

// --- dane ------------------------------------------------------------------------

// Źródło danych: API (szlaki.kj88.pl – baza MySQL, logowanie, edycja, wyniki), a gdy go nie ma
// (GitHub Pages, wersja Docker) – pliki JSON w data/: trails.json i <szlak>.json.
const pointsCache = {};

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function api(route, { method = 'GET', body, query } = {}) {
  const qs = query ? `&${new URLSearchParams(query)}` : '';
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['X-Auth-Token'] = state.token;
  const res = await fetch(`api/?r=${route}${qs}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Błąd ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadTrails() {
  try {
    const trails = await api('trails');
    if (Array.isArray(trails) && trails.length) {
      state.trails = trails;
      state.api = true;
    }
  } catch {}
  if (!state.api) state.trails = await fetchJson('data/trails.json');
  const saved = state.trails.find((t) => t.id === loadTrailId());
  state.trail = saved || state.trails[0];
}

async function loadPoints(trail = state.trail) {
  if (!pointsCache[trail.id]) {
    const points = state.api
      ? await api('points', { query: { trail: trail.id } })
      : await fetchJson(`data/${trail.file}`);
    const key = (p) => (p.position !== undefined ? p.position : p.id);
    pointsCache[trail.id] = points.sort((a, b) => key(a) - key(b));
  }
  return pointsCache[trail.id];
}

// Punkty do nauki: z wybranego pasma (albo całego szlaku) i z wybranego poziomu trudności.
// all = true – wszystkie punkty bez filtra poziomu (lista „Przeglądaj punkty”, edycja).
async function getPoints(part, { all = false } = {}) {
  const points = await loadPoints();
  return points.filter((p) => (!part || p.name_mountain_part === part) && (all || inLevel(p)));
}

// Pasma w kolejności występowania na szlaku + liczba punktów na wybranym poziomie.
// Gdy pasmo pojawia się na szlaku dwa razy, liczymy je razem (pierwsza pozycja wyznacza kolejność).
async function getParts() {
  const parts = [];
  for (const p of await getPoints(null)) {
    const known = parts.find((x) => x.name === p.name_mountain_part);
    if (known) known.count++;
    else parts.push({ name: p.name_mountain_part, count: 1 });
  }
  return parts;
}

// --- układ na telefonie: wysokość widocznego obszaru (z klawiaturą) -----------------

function syncViewport() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
  if ($('screen-quiz').classList.contains('active')) window.scrollTo(0, 0);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport);
syncViewport();

function show(screen) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(`screen-${screen}`).classList.add('active');
  window.scrollTo(0, 0);
}

// --- ekran startowy ----------------------------------------------------------

// Wybór szlaku: przyciski, nagłówek z nazwą i kierunek wg pierwszego/ostatniego punktu.
function renderTrails() {
  const box = $('trails');
  box.innerHTML = '';
  for (const t of state.trails) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trail';
    btn.style.setProperty('--trail', t.color);
    btn.setAttribute('aria-pressed', String(t.id === state.trail.id));
    btn.innerHTML = '<span class="marker" aria-hidden="true"></span>';
    btn.append(t.short);
    btn.addEventListener('click', () => selectTrail(t));
    box.appendChild(btn);
  }
  document.documentElement.style.setProperty('--trail', state.trail.color);
  $('trail-short').textContent = state.trail.short;
  $('trail-name').textContent = `${state.trail.name} – wpisuj kolejne punkty trasy`;
  // Link do mapy szlaku – tylko adresy https z mapy.com (na telefonie otwiera aplikację Mapy.com, jeśli jest).
  const map = $('trail-map');
  const url = safeMapUrl(state.trail.map_url);
  map.hidden = !url;
  if (url) {
    map.href = url;
    map.setAttribute('aria-label', `Mapa szlaku ${state.trail.short} na mapy.com (otwiera się w nowej karcie)`);
  }
}

function safeMapUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /(^|\.)mapy\.(com|cz)$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

// Nazwa punktu + ikonka 🗺️ do mapy.com (tylko gdy punkt ma link). Kliknięcie ikonki nie otwiera
// edytora ani nie zaczyna przeciągania kafelka.
function labelWithMap(labelEl, p) {
  labelEl.textContent = p.label;
  const url = safeMapUrl(p.map_url);
  if (!url) return labelEl;
  const a = document.createElement('a');
  a.className = 'map-pin';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '🗺️';
  a.title = 'Pokaż na mapie (mapy.com)';
  a.setAttribute('aria-label', `${p.label} – pokaż na mapie mapy.com`);
  a.addEventListener('click', (e) => {
    // Zwykłe dotknięcie: okienko z mapą na tej stronie. Ctrl/środkowy przycisk: jak zwykły link.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    openMapDialog(p);
  });
  a.addEventListener('pointerdown', (e) => e.stopPropagation());
  labelEl.append(' ', a);
  return labelEl;
}

// --- okienko z mapą punktu: OpenStreetMap + szlaki piesze (Waymarked Trails) ----------------
// mapy.com nie pozwala osadzać swojej strony, więc pokazujemy własną mapę (Leaflet) w miejscu
// z linku mapy.com (parametry x = długość, y = szerokość, z = przybliżenie) i dajemy przycisk do mapy.com.

const LEAFLET_URL = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
let leafletLoading = null;
let pointMap = null;
let pointMarker = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${LEAFLET_URL}leaflet.min.css`;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = `${LEAFLET_URL}leaflet.min.js`;
      s.onload = resolve;
      s.onerror = () => {
        leafletLoading = null;
        reject(new Error('Nie udało się wczytać mapy.'));
      };
      document.head.appendChild(s);
    });
  }
  return leafletLoading;
}

function coordsFromMapUrl(url) {
  try {
    const q = new URL(url).searchParams;
    const lon = parseFloat(q.get('x'));
    const lat = parseFloat(q.get('y'));
    const z = parseFloat(q.get('z'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, zoom: Math.max(6, Math.min(17, Math.round(Number.isFinite(z) ? z : 15))) };
  } catch {
    return null;
  }
}

async function openMapDialog(p) {
  const url = safeMapUrl(p.map_url);
  if (!url) return;
  const dlg = $('map-dialog');
  const frame = $('map-frame');
  $('map-title').textContent = p.label;
  $('map-sub').textContent = [p.typ_punktu, p.height ? `${p.height} m` : null, p.name_mountain_part].filter(Boolean).join(' · ');
  $('map-open').href = url;

  // Krótki link z „Udostępnij → Osadź” (mapy.com/s/…) mapy.com pozwala osadzić: pokazujemy ich mapę z pinezką.
  if (isMapyEmbedLink(url)) {
    $('map-box').hidden = true;
    frame.hidden = false;
    if (frame.getAttribute('src') !== url) frame.setAttribute('src', url);
    $('map-status').textContent = '';
    if (!dlg.open) dlg.showModal();
    return;
  }
  frame.hidden = true;
  $('map-box').hidden = false;

  // Dokładne współrzędne punktu (jeśli wpisane) mają pierwszeństwo przed środkiem widoku z linku mapy.com.
  const view = coordsFromMapUrl(url);
  const exact = Number.isFinite(p.lat) && Number.isFinite(p.lon);
  const c = exact ? { lat: p.lat, lon: p.lon, zoom: view ? view.zoom : 15 } : view;
  if (!c) {
    // Link bez współrzędnych (np. krótki link) – od razu na mapy.com.
    window.open(url, '_blank', 'noopener');
    return;
  }
  $('map-status').textContent = 'Wczytywanie mapy…';
  if (!dlg.open) dlg.showModal();
  try {
    await loadLeaflet();
  } catch (err) {
    $('map-status').textContent = `✗ ${err.message} Otwórz punkt w mapy.com.`;
    return;
  }
  $('map-status').textContent = exact ? ''
    : 'Położenie przybliżone (środek widoku z linku mapy.com) – dokładne współrzędne można dodać w edytorze punktu.';
  if (!pointMap) {
    pointMap = L.map('map-box', { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(pointMap);
    L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'szlaki: <a href="https://hiking.waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a>',
    }).addTo(pointMap);
  }
  // Okienko jest już otwarte, więc mapa zna swój rozmiar: najpierw rozmiar, potem widok.
  pointMap.invalidateSize();
  pointMap.setView([c.lat, c.lon], c.zoom);
  if (pointMarker) pointMarker.remove();
  pointMarker = L.circleMarker([c.lat, c.lon], {
    radius: 9, color: '#fff', weight: 3, fillColor: '#c0392b', fillOpacity: 1,
  }).addTo(pointMap).bindTooltip(p.label, { permanent: true, direction: 'top', offset: [0, -10] });
  // Na wszelki wypadek jeszcze raz po ułożeniu okienka (np. po animacji otwierania).
  setTimeout(() => pointMap.invalidateSize(), 200);
}

function isMapyEmbedLink(url) {
  try {
    const u = new URL(url);
    return /(^|\.)mapy\.(com|cz)$/.test(u.hostname) && u.pathname.startsWith('/s/');
  } catch {
    return false;
  }
}

// Z wklejonego kodu <iframe> z mapy.com zostaje sam adres (to samo robi serwer).
function extractMapUrl(value) {
  const v = value.trim();
  if (!/<iframe/i.test(v)) return v;
  const m = v.match(/\ssrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, '&').trim() : v;
}

$('edit-map').addEventListener('change', (e) => { e.target.value = extractMapUrl(e.target.value); });

$('map-close').addEventListener('click', () => $('map-dialog').close());
// Po zamknięciu okienka zatrzymujemy osadzoną mapę mapy.com (nie mieli w tle).
$('map-dialog').addEventListener('close', () => {
  const frame = $('map-frame');
  if (frame.getAttribute('src')) frame.removeAttribute('src');
});
// Dotknięcie przyciemnionego tła zamyka okienko.
$('map-dialog').addEventListener('click', (e) => {
  const dlg = $('map-dialog');
  if (e.target !== dlg) return;
  const r = dlg.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) dlg.close();
});

// Nazwa punktu bez dopisku w nawiasie – do krótkich nagłówków („Bielsko-Biała (Straconka)” → „Bielsko-Biała”).
const shortLabel = (label) => label.replace(/\s*\([^)]*\)/, '');

async function renderDirection() {
  const all = await loadPoints();
  const ends = [shortLabel(all[0].label), shortLabel(all[all.length - 1].label)];
  if (state.reversed) ends.reverse();
  $('dir-toggle').textContent = `${ends[0]} → ${ends[1]}`;
}

async function selectTrail(trail) {
  state.trail = trail;
  state.reversed = false;
  saveTrailId(trail.id);
  renderTrails();
  await Promise.all([renderDirection(), renderParts()]);
}

async function renderParts() {
  const parts = await getParts();
  if (state.reversed) parts.reverse();
  const total = (await loadPoints()).length;
  const used = parts.reduce((n, p) => n + p.count, 0);
  const levelText = { 'łatwy': 'tylko łatwe punkty', 'średni': 'łatwe i średnie punkty', 'trudny': 'wszystkie punkty' };
  $('level-info').textContent = `${levelText[state.level]} – na tym szlaku ${used} z ${total}`;
  $('parts').innerHTML = '';
  if (!parts.length) {
    $('parts').innerHTML = '<li class="muted">Na tym poziomie nie ma jeszcze punktów – wybierz wyższy poziom.</li>';
  }
  for (const p of parts) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part';
    btn.innerHTML = `<span>${p.name}</span><small>${p.count} pkt</small>`;
    btn.addEventListener('click', () => startPart(p.name));
    li.appendChild(btn);
    $('parts').appendChild(li);
  }
}

function renderThreshold() {
  $('threshold').value = state.threshold;
  $('threshold-value').textContent = `${state.threshold}%`;
}

$('threshold').addEventListener('input', (e) => {
  state.threshold = Number(e.target.value);
  saveThreshold(state.threshold);
  renderThreshold();
});

$('dir-toggle').addEventListener('click', () => {
  state.reversed = !state.reversed;
  renderDirection();
  renderParts();
});

$('start-all').addEventListener('click', () => (state.mode === 'between' ? startBetween(null) : startQuiz(null)));

// --- tryb nauki i poziom trudności ---------------------------------------------------

function renderMode() {
  const order = state.mode === 'order';
  const between = state.mode === 'between';
  document.querySelectorAll('.mode').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  });
  // Układanie tylko dla pasm: chowamy „Cały szlak” i próg zgodności (nie dotyczy klocków).
  $('start-all').hidden = order;
  $('start-all').textContent = between ? '🎲 Losuj z całego szlaku' : 'Cały szlak od początku';
  $('threshold-setting').hidden = order;
  $('order-info').hidden = !order;
  $('between-info').hidden = !between;
  $('parts-heading').textContent = order ? 'Wybierz pasmo do ułożenia'
    : between ? '…albo losuj z pasma' : '…albo wybierz pasmo';
}

function renderLevel() {
  document.querySelectorAll('.level').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.level === state.level));
  });
}

document.querySelectorAll('.level').forEach((b) => {
  b.addEventListener('click', () => {
    state.level = b.dataset.level;
    try { localStorage.setItem(LEVEL_KEY, state.level); } catch {}
    renderLevel();
    renderParts();
  });
});

// Za mało punktów na wybranym poziomie, żeby zacząć naukę.
function tooFew(points, min) {
  if (points.length >= min) return false;
  alert(`Na poziomie „${state.level}” jest tu za mało punktów (${points.length}). Wybierz wyższy poziom trudności.`);
  return true;
}

document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    saveMode(state.mode);
    renderMode();
  });
});

function startPart(part) {
  if (state.mode === 'order') return startOrder(part);
  if (state.mode === 'between') return startBetween(part);
  return startQuiz(part);
}

// --- lista punktów -------------------------------------------------------------

async function showList({ keepScroll = false } = {}) {
  const scrollY = window.scrollY;
  const points = await getPoints(null, { all: true });
  if (state.reversed) points.reverse();
  const box = $('point-list');
  box.innerHTML = '';
  box.classList.toggle('editing', state.editing);
  $('list-edit').hidden = !canEdit();
  $('list-edit').setAttribute('aria-pressed', String(state.editing));
  $('list-edit').textContent = state.editing ? '✓ Gotowe' : '✏️ Edytuj';
  $('list-edit-tools').hidden = !state.editing;
  $('drag-hint').hidden = !state.editing;
  setOrderDirty(false);

  // Grupy = kolejne punkty z tego samego regionu (w wybranym kierunku).
  let group = null;
  points.forEach((p, i) => {
    if (!group || group.name !== p.name_mountain_part) {
      group = { name: p.name_mountain_part, el: document.createElement('section') };
      group.el.className = 'group';
      const head = document.createElement('div');
      head.className = 'group-head';
      const h = document.createElement('h3');
      h.textContent = p.name_mountain_part;
      const learn = document.createElement('button');
      learn.type = 'button';
      learn.className = 'pill small';
      learn.textContent = 'Ucz się →';
      const part = p.name_mountain_part;
      learn.addEventListener('click', () => startPart(part));
      head.append(h, learn);
      group.list = document.createElement('ol');
      group.el.append(head, group.list);
      box.appendChild(group.el);
    }
    const li = document.createElement('li');
    li.dataset.search = normalize(p.label);
    const nr = document.createElement('span');
    nr.className = 'nr';
    nr.textContent = i + 1;
    const ico = document.createElement('span');
    ico.textContent = TYPE_ICON[p.typ_punktu] || '•';
    const label = document.createElement('span');
    label.className = 'label';
    labelWithMap(label, p);
    // Punkt obok szlaku (nie na samej trasie) – widoczny znacznik przy nazwie.
    if (p.on_trail === false) {
      const off = document.createElement('span');
      off.className = 'off-trail';
      off.textContent = '↗ obok szlaku';
      label.append(' ', off);
      li.classList.add('is-off-trail');
    }
    const meta = document.createElement('small');
    meta.textContent = p.height ? `${p.typ_punktu} · ${p.height} m` : p.typ_punktu;
    li.append(nr, ico, label, meta);
    li.dataset.difficulty = p.difficulty || 'łatwy';
    if (p.difficulty) {
      const diff = document.createElement('span');
      diff.className = `diff diff-${normalize(p.difficulty)}`;
      diff.title = `Trudność: ${p.difficulty}`;
      diff.setAttribute('aria-label', `trudność ${p.difficulty}`);
      li.appendChild(diff);
    }
    li.dataset.id = p.id;
    if (!state.editing) {
      // Poza edycją dotknięcie punktu pokazuje szczegóły (szlaki, ciekawostki, mapa).
      li.tabIndex = 0;
      li.classList.add('has-info');
      li.addEventListener('click', () => openInfo(p));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openInfo(p); });
    }
    if (state.editing) {
      li.tabIndex = 0;
      li.addEventListener('click', () => {
        if (Date.now() - drag.endedAt < 400) return; // to był koniec przeciągania, nie kliknięcie
        if (state.orderDirty) {
          setListMessage('Najpierw zapisz albo anuluj nową kolejność.');
          return;
        }
        openEditor(p);
      });
      li.addEventListener('pointerdown', onDragDown);
      // ＋ na krawędzi pod kafelkiem: nowy punkt dokładnie w tym miejscu (między tym a następnym).
      const ins = document.createElement('button');
      ins.type = 'button';
      ins.className = 'insert-btn';
      ins.textContent = '＋';
      ins.title = 'Dodaj punkt tutaj';
      ins.setAttribute('aria-label', `Dodaj punkt po: ${p.label}`);
      ins.addEventListener('pointerdown', (e) => e.stopPropagation());
      ins.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.orderDirty) {
          setListMessage('Najpierw zapisz albo anuluj nową kolejność.');
          return;
        }
        addPointAfter(p);
      });
      li.appendChild(ins);
    }
    group.list.appendChild(li);
  });

  if (points.length) {
    const ends = [shortLabel(points[0].label), shortLabel(points[points.length - 1].label)];
    $('list-title').textContent = `${state.trail.short} · ${ends[0]} → ${ends[1]}`;
  }
  if (!keepScroll) $('list-search').value = '';
  filterList();
  show('list');
  if (keepScroll) window.scrollTo(0, scrollY);
}

// Poziomy trudności zaznaczone w filtrze listy (checkboxy „Pokaż: łatwe / średnie / trudne”).
const listLevels = () => new Set([...document.querySelectorAll('.diff-filter input:checked')].map((c) => c.dataset.level));
const listFiltered = () => Boolean($('list-search').value.trim()) || listLevels().size < DIFFICULTIES.length;

function filterList() {
  const q = normalize($('list-search').value);
  const levels = listLevels();
  let visible = 0;
  for (const g of $('point-list').querySelectorAll('.group')) {
    let inGroup = 0;
    for (const li of g.querySelectorAll('li[data-id]')) {
      const hit = (!q || li.dataset.search.includes(q)) && levels.has(li.dataset.difficulty);
      li.hidden = !hit;
      if (hit) inGroup++;
    }
    g.hidden = inGroup === 0;
    visible += inGroup;
  }
  const total = $('point-list').querySelectorAll('li[data-id]').length;
  $('list-count').textContent = listFiltered() ? `${visible} z ${total} punktów` : `${total} punktów`;
}

document.querySelectorAll('.diff-filter input').forEach((c) => c.addEventListener('change', filterList));

// --- szczegóły punktu (okienko z listy) ---------------------------------------------------

function openInfo(p) {
  $('info-title').textContent = p.label;
  $('info-sub').textContent = [p.typ_punktu, p.height ? `${p.height} m` : null, p.name_mountain_part]
    .filter(Boolean).join(' · ');
  const badges = $('info-badges');
  badges.replaceChildren();
  const badge = (text, cls) => {
    const b = document.createElement('span');
    b.className = `info-badge ${cls || ''}`;
    b.textContent = text;
    badges.appendChild(b);
  };
  badge(p.on_trail === false ? '↗ obok szlaku' : '✓ na szlaku', p.on_trail === false ? 'off' : 'on');
  if (p.difficulty) badge(`trudność: ${p.difficulty}`, `lvl-${normalize(p.difficulty)}`);
  $('info-trails').textContent = p.trails_info || '';
  $('info-trails-box').hidden = !p.trails_info;
  $('info-notes').textContent = p.notes || '';
  $('info-notes-box').hidden = !p.notes;
  $('info-empty').hidden = Boolean(p.trails_info || p.notes);
  const hasMap = Boolean(safeMapUrl(p.map_url));
  $('info-map').hidden = !hasMap;
  $('info-map').onclick = () => { $('info-dialog').close(); openMapDialog(p); };
  if (!$('info-dialog').open) $('info-dialog').showModal();
}

$('info-close').addEventListener('click', () => $('info-dialog').close());
$('info-dialog').addEventListener('click', (e) => {
  const dlg = $('info-dialog');
  if (e.target !== dlg) return;
  const r = dlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
});

$('browse').addEventListener('click', () => showList());
$('list-search').addEventListener('input', filterList);
const discardOrder = () => !state.orderDirty || confirm('Porzucić niezapisaną nową kolejność punktów?');

$('list-back').addEventListener('click', () => {
  if (!discardOrder()) return;
  setOrderDirty(false);
  state.editing = false;
  show('start');
});
$('list-edit').addEventListener('click', () => {
  if (!discardOrder()) return;
  state.editing = !state.editing;
  showList({ keepScroll: true });
});

// --- przeciąganie kafelków w trybie edycji ---------------------------------------------
// Myszka: wciśnij i przeciągnij. Telefon: przytrzymaj ~0,5 s (kafelek zmienia kolor), potem
// przesuń palcem. Zmiana kolejności jest tylko na ekranie, dopóki nie klikniesz „Zapisz kolejność”.

const LONG_PRESS_MS = 450;
const drag = {
  pending: null, li: null, ph: null, pointerId: null, type: '', timer: 0,
  startX: 0, startY: 0, lastY: 0, offsetY: 0, active: false, endedAt: 0, raf: 0,
};

function setOrderDirty(dirty) {
  state.orderDirty = dirty;
  $('order-bar').hidden = !dirty;
}

function onDragDown(e) {
  if (!state.editing || drag.active || drag.pending) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (listFiltered()) {
    setListMessage('Przy wyszukiwaniu albo filtrze trudności nie można przenosić punktów – pokaż wszystkie punkty.');
    return;
  }
  Object.assign(drag, {
    pending: e.currentTarget, pointerId: e.pointerId, type: e.pointerType,
    startX: e.clientX, startY: e.clientY, lastY: e.clientY,
  });
  if (e.pointerType !== 'mouse') {
    drag.pending.classList.add('pressing');
    drag.timer = setTimeout(() => beginDrag(drag.lastY), LONG_PRESS_MS);
  }
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (e.pointerId !== drag.pointerId) return;
  drag.lastY = e.clientY;
  if (!drag.active) {
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.type === 'mouse') {
      if (moved > 5) beginDrag(e.clientY);
    } else if (moved > 10) {
      resetDrag(); // palec ruszył przed czasem – to przewijanie listy, nie przenoszenie
    }
    return;
  }
  e.preventDefault();
  placeDragged(e.clientY);
}

function beginDrag(y) {
  const li = drag.pending;
  if (!li) return;
  const rect = li.getBoundingClientRect();
  const ph = document.createElement('li');
  ph.className = 'drop-placeholder';
  ph.style.height = `${rect.height}px`;
  drag.fromIndex = tileIndex(li);
  li.before(ph);
  li.classList.remove('pressing');
  li.classList.add('dragging');
  Object.assign(li.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  Object.assign(drag, { li, ph, active: true, offsetY: y - rect.top });
  document.body.classList.add('drag-active');
  if (navigator.vibrate) navigator.vibrate(25);
  autoScroll();
}

// Kafelek za palcem/kursorem; miejsce docelowe = przed pierwszym kafelkiem, którego środek jest niżej.
function placeDragged(y) {
  const { li, ph } = drag;
  li.style.top = `${y - drag.offsetY}px`;
  const items = [...$('point-list').querySelectorAll('li:not(.dragging):not(.drop-placeholder)')];
  const target = items.find((it) => {
    const r = it.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  if (target) {
    if (target.previousElementSibling !== ph) target.before(ph);
  } else if (items.length) {
    const last = items[items.length - 1];
    if (last.nextElementSibling !== ph) last.after(ph);
  }
}

// Przewijanie strony, gdy kafelek jest przy górnej lub dolnej krawędzi ekranu.
function autoScroll() {
  if (!drag.active) return;
  const top = document.querySelector('#screen-list .list-head').getBoundingClientRect().bottom;
  const y = drag.lastY;
  let dy = 0;
  if (y < top + 50) dy = -Math.ceil((top + 50 - y) / 5);
  else if (y > window.innerHeight - 60) dy = Math.ceil((y - (window.innerHeight - 60)) / 5);
  if (dy) {
    window.scrollBy(0, Math.max(-20, Math.min(20, dy)));
    placeDragged(y);
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function onDragEnd(e) {
  if (e.pointerId !== drag.pointerId) return;
  if (drag.active) {
    const { li, ph } = drag;
    ph.replaceWith(li);
    li.classList.remove('dragging');
    li.removeAttribute('style');
    drag.endedAt = Date.now();
    if (tileIndex(li) !== drag.fromIndex) {
      renumberList();
      setOrderDirty(true);
    }
  }
  resetDrag();
}

function resetDrag() {
  clearTimeout(drag.timer);
  cancelAnimationFrame(drag.raf);
  if (drag.pending) drag.pending.classList.remove('pressing');
  Object.assign(drag, { pending: null, li: null, ph: null, pointerId: null, active: false });
  document.body.classList.remove('drag-active');
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
}

// Podczas przeciągania palcem blokujemy przewijanie strony.
document.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
// Długie przytrzymanie nie otwiera menu kontekstowego na kafelku.
$('point-list').addEventListener('contextmenu', (e) => { if (state.editing) e.preventDefault(); });

const tileIndex = (li) => [...$('point-list').querySelectorAll('li[data-id]')].indexOf(li);

function renumberList() {
  $('point-list').querySelectorAll('li:not(.drop-placeholder) .nr').forEach((nr, i) => { nr.textContent = i + 1; });
}

$('order-cancel').addEventListener('click', () => showList({ keepScroll: true }));
$('order-save').addEventListener('click', async () => {
  const btn = $('order-save');
  btn.disabled = true;
  try {
    const ids = [...$('point-list').querySelectorAll('li[data-id]')].map((li) => Number(li.dataset.id));
    if (state.reversed) ids.reverse(); // w bazie kolejność zawsze od początku szlaku
    await api('points_reorder', { method: 'POST', body: { trail: state.trail.id, ids } });
    await afterEdit('✓ Zapisano nową kolejność');
  } catch (err) {
    setListMessage(`✗ ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
$('list-add-first').addEventListener('click', () => openEditor(null, { insertAt: 'start' }));

// --- edycja punktów (edytor, administrator) ------------------------------------------

// Punkt „po którym” wstawić nowy, w kolejności z bazy. Przy odwróconym kierunku
// „dodaj po tym” na ekranie oznacza „przed nim” w bazie.
function afterIdFor(point) {
  const all = pointsCache[state.trail.id];
  const idx = all.findIndex((p) => p.id === point.id);
  if (!state.reversed) return point.id;
  return idx > 0 ? all[idx - 1].id : null;
}

function fillSelect(select, values, current) {
  select.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (v === current) o.selected = true;
    select.appendChild(o);
  }
}

// point = istniejący punkt do edycji albo null (nowy). Dla nowego: afterId albo insertAt 'start'.
function openEditor(point, { afterId = null, insertAt = null, region = null } = {}) {
  const all = pointsCache[state.trail.id] || [];
  const regions = [...new Set(all.map((p) => p.name_mountain_part))];
  $('edit-regions').replaceChildren(...regions.map((r) => {
    const o = document.createElement('option');
    o.value = r;
    return o;
  }));

  state.edit = { point, afterId, insertAt };
  const isNew = !point;
  $('edit-title').textContent = isNew ? 'Nowy punkt' : 'Edycja punktu';
  $('edit-sub').textContent = isNew
    ? (insertAt === 'start' ? 'na początku szlaku' : `po: ${(all.find((p) => p.id === afterId) || {}).label || '—'}`)
    : `${state.trail.short} · ${point.name_mountain_part}`;
  $('edit-label').value = isNew ? '' : point.label;
  $('edit-region').value = isNew ? (region || (all.find((p) => p.id === afterId) || all[0] || {}).name_mountain_part || '') : point.name_mountain_part;
  fillSelect($('edit-type'), TYPES, isNew ? 'góra' : point.typ_punktu);
  $('edit-height').value = isNew || point.height == null ? '' : point.height;
  fillSelect($('edit-difficulty'), DIFFICULTIES, isNew ? 'łatwy' : (point.difficulty || 'łatwy'));
  $('edit-on-trail').checked = isNew || point.on_trail !== false;
  $('edit-trails').value = isNew ? '' : (point.trails_info || '');
  $('edit-notes').value = isNew ? '' : (point.notes || '');
  $('edit-map').value = isNew ? '' : (point.map_url || '');
  $('edit-coords').value = !isNew && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    ? `${point.lat}, ${point.lon}` : '';
  document.querySelectorAll('.edit-existing').forEach((el) => { el.hidden = isNew; });
  if (!isNew) loadPointHistory(point.id);
  setEditMessage('', '');
  show('edit');
  $('edit-label').focus({ preventScroll: true });
}

function setEditMessage(text, kind) {
  const el = $('edit-message');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

function editFormData() {
  return {
    label: $('edit-label').value,
    region: $('edit-region').value,
    type: $('edit-type').value,
    height: $('edit-height').value,
    difficulty: $('edit-difficulty').value,
    on_trail: $('edit-on-trail').checked,
    trails_info: $('edit-trails').value.trim(),
    notes: $('edit-notes').value.trim(),
    map_url: extractMapUrl($('edit-map').value),
    coords: $('edit-coords').value.trim(),
  };
}

// Po zmianie: odśwież dane szlaku i wróć do listy (dalej w trybie edycji).
async function afterEdit(message) {
  delete pointsCache[state.trail.id];
  await showList({ keepScroll: true });
  renderParts();
  renderDirection();
  if (message) setListMessage(message);
}

function setListMessage(text) {
  const el = $('list-message');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(setListMessage.timer);
  setListMessage.timer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function runEdit(action) {
  const buttons = document.querySelectorAll('#screen-edit button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await action();
  } catch (err) {
    setEditMessage(`✗ ${err.message}`, 'bad');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runEdit(async () => {
    const { point, afterId } = state.edit;
    if (point) {
      await api('points', { method: 'PUT', body: { id: point.id, ...editFormData() } });
      await afterEdit(`✓ Zapisano: ${$('edit-label').value.trim()}`);
    } else {
      await api('points', {
        method: 'POST',
        body: { trail: state.trail.id, after_id: afterId, ...editFormData() },
      });
      await afterEdit(`✓ Dodano: ${$('edit-label').value.trim()}`);
    }
  });
});

function movePoint(visualDir) {
  // Na ekranie „w górę” = wcześniej w wyświetlanej kolejności; przy odwróconym kierunku to dalej w bazie.
  const dir = state.reversed ? -visualDir : visualDir;
  runEdit(async () => {
    await api('points_move', { method: 'POST', body: { id: state.edit.point.id, dir } });
    await afterEdit(`✓ Przesunięto: ${state.edit.point.label}`);
  });
}

$('edit-up').addEventListener('click', () => movePoint(-1));
$('edit-down').addEventListener('click', () => movePoint(1));
// Nowy punkt zaraz po wskazanym (w kolejności na ekranie – także przy odwróconym kierunku).
function addPointAfter(p) {
  const afterId = afterIdFor(p);
  openEditor(null, { afterId, insertAt: afterId ? null : 'start', region: p.name_mountain_part });
}

$('edit-add-after').addEventListener('click', () => addPointAfter(state.edit.point));

// --- historia zmian punktów ---------------------------------------------------------------

const ACTION_LABEL = {
  import: '📥 zaimportowany', create: '➕ dodany', update: '✏️ zmieniony', move: '↕️ przesunięty', delete: '🗑 usunięty',
};
const FIELD_LABEL = {
  label: 'nazwa', region: 'pasmo', type: 'typ', height: 'wysokość', difficulty: 'trudność',
  map_url: 'mapa', lat: 'szer.', lon: 'dł.', position: 'pozycja',
  on_trail: 'położenie', trails_info: 'szlaki', notes: 'ciekawostki',
};

function fmtValue(key, v) {
  if (key === 'on_trail') return v === false ? 'obok szlaku' : 'na szlaku';
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'map_url') return '🗺️ link';
  if (key === 'height') return `${v} m`;
  const s = String(v);
  return s.length > 60 ? `„${s.slice(0, 57)}…”` : (key === 'notes' || key === 'trails_info' ? `„${s}”` : s);
}

function changeLines(h) {
  const c = h.changes || {};
  if (h.action === 'update' || h.action === 'move') {
    return Object.entries(c).map(([k, [a, b]]) => `${FIELD_LABEL[k] || k}: ${fmtValue(k, a)} → ${fmtValue(k, b)}`);
  }
  if (h.action === 'create' || h.action === 'delete') {
    return [['type', 'height', 'region', 'difficulty', 'position'].filter((k) => c[k] !== null && c[k] !== undefined)
      .map((k) => `${FIELD_LABEL[k]}: ${fmtValue(k, c[k])}`).join(' · ')];
  }
  return [];
}

// Wpisy historii; withPoint = pokaż nazwę punktu (lista zmian całego szlaku).
function renderHistoryEntries(box, entries, { withPoint = false } = {}) {
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = '<li class="muted">Brak zapisanych zmian.</li>';
    return;
  }
  for (const h of entries) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'h-head';
    const what = document.createElement('strong');
    what.textContent = withPoint ? `${ACTION_LABEL[h.action] || h.action}: ${h.label}` : (ACTION_LABEL[h.action] || h.action);
    const when = document.createElement('small');
    when.textContent = formatDate(h.created_at);
    head.append(what, when);
    const body = document.createElement('div');
    body.className = 'h-body';
    const lines = [`przez: ${h.login || '(usunięte konto)'}`, ...changeLines(h)].filter(Boolean);
    body.textContent = lines.join(' · ');
    li.append(head, body);
    box.appendChild(li);
  }
}

async function loadPointHistory(pointId) {
  const box = $('edit-history');
  $('edit-created').textContent = '';
  box.innerHTML = '<li class="muted">Wczytywanie…</li>';
  try {
    const h = await api('point_history', { query: { id: pointId } });
    if (!state.edit || !state.edit.point || state.edit.point.id !== pointId) return; // otwarto już inny punkt
    $('edit-created').textContent = `Utworzył(a): ${h.created_by || 'nieznany'} · ${h.created_at ? formatDate(h.created_at) : 'data nieznana'}`;
    renderHistoryEntries(box, h.entries);
  } catch (err) {
    box.innerHTML = '';
    $('edit-created').textContent = `Nie udało się wczytać historii: ${err.message}`;
  }
}

async function showChanges() {
  if (state.orderDirty) {
    setListMessage('Najpierw zapisz albo anuluj nową kolejność.');
    return;
  }
  $('changes-title').textContent = `🕘 Ostatnie zmiany · ${state.trail.short}`;
  $('changes-sub').textContent = 'Wczytywanie…';
  show('changes');
  try {
    const entries = await api('changes', { query: { trail: state.trail.id } });
    renderHistoryEntries($('changes-list'), entries, { withPoint: true });
    $('changes-sub').textContent = entries.length ? `wpisów: ${entries.length} (najnowsze na górze)` : '';
  } catch (err) {
    $('changes-list').innerHTML = '';
    $('changes-sub').textContent = `✗ ${err.message}`;
  }
}

$('list-changes').addEventListener('click', showChanges);
$('changes-back').addEventListener('click', () => showList({ keepScroll: true }));
$('edit-delete').addEventListener('click', () => {
  const p = state.edit.point;
  if (!confirm(`Usunąć punkt „${p.label}”? Tego nie da się cofnąć.`)) return;
  runEdit(async () => {
    await api('points', { method: 'DELETE', body: { id: p.id } });
    await afterEdit(`✓ Usunięto: ${p.label}`);
  });
});
$('edit-back').addEventListener('click', () => showList({ keepScroll: true }));
$('edit-cancel').addEventListener('click', () => showList({ keepScroll: true }));

// --- konto: logowanie, wyniki, zmiana hasła ---------------------------------------------

function renderAccount() {
  $('account-bar').hidden = !state.api;
  $('account-btn').textContent = state.user ? `👤 ${state.user.login}` : '👤 Zaloguj się';
}

async function restoreSession() {
  if (!state.api || !state.token) return;
  try {
    state.user = await api('me');
  } catch {
    state.user = null;
  }
  if (!state.user) {
    state.token = null;
    saveToken(null);
  }
}

$('account-btn').addEventListener('click', () => (state.user ? showAccount() : showLogin()));

function showLogin() {
  $('login-error').textContent = '';
  $('login-password').value = '';
  $('login-https').hidden = location.protocol === 'https:';
  show('login');
  $('login-login').focus({ preventScroll: true });
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-submit');
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const res = await api('login', {
      method: 'POST',
      body: { login: $('login-login').value.trim(), password: $('login-password').value },
    });
    state.token = res.token;
    state.user = res.user;
    saveToken(res.token);
    $('login-password').value = '';
    renderAccount();
    show('start');
  } catch (err) {
    $('login-error').textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
$('login-back').addEventListener('click', () => show('start'));

async function showAccount() {
  $('account-login').textContent = state.user.login;
  $('account-role').textContent = ROLE_LABEL[state.user.role] || state.user.role;
  $('account-users').hidden = !isAdmin();
  $('pw-message').textContent = '';
  show('account');
  await renderHistory();
}

const MODE_LABEL = { type: '✍️ wpisywanie', order: '🧩 układanie', between: '↕️ pomiędzy' };

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  return m ? `${m} min ${sec % 60} s` : `${sec} s`;
}

// Historia wyników: własna (userId = null) albo – dla administratora – wybranej osoby.
// Zwraca liczbę wyników (albo null przy błędzie).
async function renderHistory({ box = $('history'), userId = null } = {}) {
  box.innerHTML = '<li class="muted">Wczytywanie…</li>';
  try {
    const rows = await api('results', userId ? { query: { user: userId } } : {});
    box.innerHTML = '';
    if (!rows.length) {
      box.innerHTML = userId
        ? '<li class="muted">Ta osoba nie ma jeszcze żadnych wyników.</li>'
        : '<li class="muted">Brak wyników – ukończ naukę pasma albo szlaku, a pojawi się tutaj.</li>';
      return 0;
    }
    for (const r of rows) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'h-head';
      const what = document.createElement('strong');
      what.textContent = `${r.short} · ${r.region || 'cały szlak'}`;
      const when = document.createElement('small');
      when.textContent = formatDate(r.created_at);
      head.append(what, when);
      const body = document.createElement('div');
      body.className = 'h-body';
      const pct = r.total ? Math.round((r.correct / r.total) * 100) : 0;
      const details = r.mode === 'order'
        ? `pomyłki: ${r.mistakes}`
        : `${r.correct}/${r.total} trafione (${pct}%) · pokazane: ${r.revealed} · błędy: ${r.mistakes}`;
      body.textContent = [MODE_LABEL[r.mode], r.level ? `poziom: ${r.level}` : null,
        r.reversed ? '↩︎ odwrotnie' : null, details, formatDuration(r.duration_s)]
        .filter(Boolean).join(' · ');
      li.append(head, body);
      box.appendChild(li);
    }
    return rows.length;
  } catch (err) {
    box.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = `Nie udało się wczytać wyników: ${err.message}`;
    box.appendChild(li);
    return null;
  }
}

// Wyniki wybranej osoby (tylko administrator, z listy użytkowników).
async function showUserResults(u) {
  $('user-results-title').textContent = `📈 Wyniki: ${u.login}`;
  $('user-results-sub').textContent = ROLE_LABEL[u.role] || u.role;
  show('user-results');
  const n = await renderHistory({ box: $('user-history'), userId: u.id });
  if (n !== null) $('user-results-sub').textContent = `${ROLE_LABEL[u.role] || u.role} · wyników: ${n}`;
}

$('user-results-back').addEventListener('click', () => showUsers());

$('account-back').addEventListener('click', () => show('start'));
$('account-logout').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST' }); } catch {}
  state.user = null;
  state.token = null;
  saveToken(null);
  state.editing = false;
  renderAccount();
  show('start');
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('pw-message');
  if ($('pw-new').value !== $('pw-new2').value) {
    msg.textContent = '✗ Nowe hasła się różnią.';
    msg.className = 'feedback bad';
    return;
  }
  try {
    await api('password', { method: 'POST', body: { current: $('pw-current').value, password: $('pw-new').value } });
    msg.textContent = '✓ Hasło zmienione.';
    msg.className = 'feedback ok';
    e.target.reset();
  } catch (err) {
    msg.textContent = `✗ ${err.message}`;
    msg.className = 'feedback bad';
  }
});

// Zapis wyniku po ukończeniu nauki (tylko zalogowani, tylko z API).
async function saveResult(result) {
  const note = $('summary-note');
  if (!state.api) { note.textContent = ''; return; }
  if (!state.user) { note.textContent = 'Zaloguj się, aby zapisywać wyniki w historii.'; return; }
  note.textContent = 'Zapisywanie wyniku…';
  try {
    await api('results', {
      method: 'POST',
      body: {
        trail: state.trail.id,
        region: state.part,
        level: state.level,
        reversed: state.reversed,
        duration_s: Math.round((Date.now() - state.startedAt) / 1000),
        ...result,
      },
    });
    note.textContent = '✓ Wynik zapisany w historii.';
  } catch (err) {
    note.textContent = `✗ Nie zapisano wyniku: ${err.message}`;
  }
}

// --- konta użytkowników (administrator) --------------------------------------------------

$('account-users').addEventListener('click', showUsers);
$('users-back').addEventListener('click', () => showAccount());

async function showUsers() {
  fillSelect($('new-role'), Object.keys(ROLE_LABEL), 'user');
  [...$('new-role').options].forEach((o) => { o.textContent = ROLE_LABEL[o.value]; });
  $('users-message').textContent = '';
  show('users');
  await renderUsers();
}

function setUsersMessage(text, kind) {
  const el = $('users-message');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

async function renderUsers() {
  const box = $('users-list');
  box.innerHTML = '<li class="muted">Wczytywanie…</li>';
  let users;
  try {
    users = await api('users');
  } catch (err) {
    box.innerHTML = '';
    setUsersMessage(`✗ ${err.message}`, 'bad');
    return;
  }
  box.innerHTML = '';
  for (const u of users) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'u-name';
    const strong = document.createElement('strong');
    strong.textContent = u.login;
    const small = document.createElement('small');
    small.textContent = u.last_login ? `ostatnio: ${formatDate(u.last_login)}` : 'jeszcze się nie logował(a)';
    name.append(strong, small);

    const role = document.createElement('select');
    role.setAttribute('aria-label', `Rola: ${u.login}`);
    fillSelect(role, Object.keys(ROLE_LABEL), u.role);
    [...role.options].forEach((o) => { o.textContent = ROLE_LABEL[o.value]; });
    role.addEventListener('change', async () => {
      try {
        await api('users', { method: 'PUT', body: { id: u.id, role: role.value } });
        setUsersMessage(`✓ ${u.login}: ${ROLE_LABEL[role.value]}`, 'ok');
      } catch (err) {
        setUsersMessage(`✗ ${err.message}`, 'bad');
        role.value = u.role;
      }
    });

    const pw = document.createElement('button');
    pw.type = 'button';
    pw.className = 'pill small';
    pw.textContent = '🔑 Hasło';
    pw.addEventListener('click', async () => {
      const p = prompt(`Nowe hasło dla „${u.login}” (min. 8 znaków):`);
      if (!p) return;
      try {
        await api('users', { method: 'PUT', body: { id: u.id, password: p } });
        setUsersMessage(`✓ Zmieniono hasło: ${u.login}`, 'ok');
      } catch (err) {
        setUsersMessage(`✗ ${err.message}`, 'bad');
      }
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pill small danger';
    del.textContent = '🗑';
    del.setAttribute('aria-label', `Usuń konto ${u.login}`);
    del.hidden = state.user && u.id === state.user.id;
    del.addEventListener('click', async () => {
      if (!confirm(`Usunąć konto „${u.login}” razem z historią wyników? Tego nie da się cofnąć.`)) return;
      try {
        await api('users', { method: 'DELETE', body: { id: u.id } });
        setUsersMessage(`✓ Usunięto konto: ${u.login}`, 'ok');
        renderUsers();
      } catch (err) {
        setUsersMessage(`✗ ${err.message}`, 'bad');
      }
    });

    const actions = document.createElement('div');
    actions.className = 'u-actions';
    const stats = document.createElement('button');
    stats.type = 'button';
    stats.className = 'pill small';
    stats.textContent = '📈';
    stats.title = 'Wyniki';
    stats.setAttribute('aria-label', `Wyniki: ${u.login}`);
    stats.addEventListener('click', () => showUserResults(u));

    actions.append(role, pw, stats, del);
    li.append(name, actions);
    box.appendChild(li);
  }
}

$('new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const u = await api('users', {
      method: 'POST',
      body: { login: $('new-login').value.trim(), password: $('new-password').value, role: $('new-role').value },
    });
    setUsersMessage(`✓ Założono konto: ${u.login} (${ROLE_LABEL[u.role]})`, 'ok');
    e.target.reset();
    $('new-role').value = 'user';
    renderUsers();
  } catch (err) {
    setUsersMessage(`✗ ${err.message}`, 'bad');
  }
});

// --- nauka -------------------------------------------------------------------

async function startQuiz(part) {
  const points = await getPoints(part);
  if (tooFew(points, 2)) return;
  if (state.reversed) points.reverse();
  state.lastMode = 'type';
  state.startedAt = Date.now();
  Object.assign(state, {
    part, points, index: 0, hintLevel: 0, mistakes: 0, revealed: 0, close: 0,
  });

  $('quiz-title').textContent = `${state.trail.short} · ${part || 'cały szlak'}`;
  $('done').innerHTML = '';
  setFeedback('', '');
  show('quiz');
  // Pierwszy punkt podajemy jako punkt startowy – uczymy się „co dalej”.
  addDone(points[0], 'start');
  state.index = 1;
  nextPrompt();
}

function addDone(point, kind, score) {
  const li = document.createElement('li');
  li.className = kind;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = TYPE_ICON[point.typ_punktu] || '•';
  const label = document.createElement('span');
  label.className = 'label';
  labelWithMap(label, point);
  const meta = document.createElement('small');
  meta.textContent = score !== undefined && score < 100
    ? `${point.typ_punktu} · ${score}%`
    : point.typ_punktu;
  li.append(ico, label, meta);
  const list = $('done');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

function setFeedback(text, kind) {
  const el = $('feedback');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

function current() {
  return state.points[state.index];
}

function nextPrompt() {
  const total = state.points.length;
  $('quiz-progress').textContent = `${state.index} / ${total}`;
  $('progress-fill').style.width = `${(state.index / total) * 100}%`;

  if (state.index >= total) return finish();

  state.hintLevel = 0;
  $('hint').textContent = '';
  $('answer').value = '';
  $('answer').focus({ preventScroll: true });
}

function advance(kind, score) {
  addDone(current(), kind, score);
  state.index++;
  nextPrompt();
}

$('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('answer').value;
  if (!input.trim()) return;
  const point = current();
  const score = similarity(input, point.label);

  if (score === 100) {
    setFeedback('✓ 100% – dokładnie tak', 'ok');
    advance('ok', score);
  } else if (score >= state.threshold) {
    state.close++;
    setFeedback(`✓ ${score}% – zaliczone, poprawnie: ${point.label}`, 'close');
    advance('close', score);
  } else {
    state.mistakes++;
    setFeedback(`✗ ${score}% zgodności – potrzeba ${state.threshold}%`, 'bad');
    const field = $('answer');
    field.classList.remove('wrong');
    void field.offsetWidth; // restart animacji
    field.classList.add('wrong');
    field.select();
  }
});

$('btn-hint').addEventListener('click', () => {
  const p = current();
  state.hintLevel++;
  const type = `${p.typ_punktu}${p.height ? ` ${p.height} m` : ''}`;
  const hints = [
    `Typ: ${TYPE_ICON[p.typ_punktu] || ''} ${type}`,
    `Typ: ${type} · zaczyna się na „${p.label[0]}”`,
    `Typ: ${type} · „${p.label.slice(0, Math.ceil(p.label.length / 2))}…”`,
  ];
  $('hint').textContent = hints[Math.min(state.hintLevel, hints.length) - 1];
  $('answer').focus({ preventScroll: true });
});

$('btn-reveal').addEventListener('click', () => {
  state.revealed++;
  setFeedback(`Pokazano: ${current().label}`, 'revealed');
  advance('revealed');
});

$('back').addEventListener('click', () => show('start'));

// --- podsumowanie ------------------------------------------------------------

function finish() {
  const asked = state.points.length - 1;
  const ok = asked - state.revealed;
  $('summary').textContent =
    `Trafione: ${ok} / ${asked} (w tym z literówką: ${state.close}) · ` +
    `pokazane: ${state.revealed} · błędne próby: ${state.mistakes}`;
  show('end');
  saveResult({
    mode: 'type', total: asked, correct: ok, close: state.close, revealed: state.revealed, mistakes: state.mistakes,
  });
}

// --- układanie klocków --------------------------------------------------------------
// Pasmo układa się etapami po N punktów (domyślnie 8, zmiana przyciskami −/+).
// Na górze ostatni ułożony punkt (dla ciągłości) i N pustych miejsc, na dole N wymieszanych
// klocków. Dotknięcie klocka od razu sprawdza, czy to następny punkt: dobry ląduje na swoim
// miejscu (zielony), zły miga na czerwono i zostaje na dole. Po ułożeniu etapu pojawiają się
// kolejne klocki.

const BATCH_KEY = 'gsb.batch';
const BATCH_MIN = 3;
const BATCH_MAX = 20;
const BATCH_DEFAULT = 8;

function loadBatchSize() {
  try {
    const v = Number(localStorage.getItem(BATCH_KEY));
    if (v >= BATCH_MIN && v <= BATCH_MAX) return v;
  } catch {}
  return BATCH_DEFAULT;
}

state.batchSize = loadBatchSize();

function renderBatchSize() {
  document.querySelectorAll('.batch-value').forEach((el) => { el.textContent = state.batchSize; });
  document.querySelectorAll('.batch-dec').forEach((b) => { b.disabled = state.batchSize <= BATCH_MIN; });
  document.querySelectorAll('.batch-inc').forEach((b) => { b.disabled = state.batchSize >= BATCH_MAX; });
}

function changeBatchSize(delta) {
  state.batchSize = Math.min(BATCH_MAX, Math.max(BATCH_MIN, state.batchSize + delta));
  try { localStorage.setItem(BATCH_KEY, String(state.batchSize)); } catch {}
  renderBatchSize();
  // W trakcie układania: nowy rozmiar od razu – etap zaczyna się od następnego punktu.
  if (state.order && $('screen-order').classList.contains('active')) {
    startBatch();
    renderOrder();
  }
}

document.querySelectorAll('.batch-dec').forEach((b) => b.addEventListener('click', () => changeBatchSize(-1)));
document.querySelectorAll('.batch-inc').forEach((b) => b.addEventListener('click', () => changeBatchSize(1)));

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Nowy etap od punktu o.next: N miejsc i N wymieszanych klocków.
function startBatch() {
  const o = state.order;
  o.batchStart = o.next;
  o.batchEnd = Math.min(o.expected.length, o.next + state.batchSize);
  const batch = o.expected.slice(o.batchStart, o.batchEnd);
  const tiles = batch.map((p, i) => ({ key: o.batchStart + i, label: p.label }));
  let pool = shuffle(tiles);
  // Przy kilku klockach losowanie może dać od razu dobrą kolejność – mieszamy ponownie.
  for (let n = 0; n < 5 && pool.length > 1 && pool.every((t, i) => t.label === batch[i].label); n++) {
    pool = shuffle(tiles);
  }
  o.pool = pool;
}

async function startOrder(part) {
  const points = await getPoints(part);
  if (tooFew(points, 2)) return;
  if (state.reversed) points.reverse();
  state.part = part;
  state.lastMode = 'order';
  state.startedAt = Date.now();
  state.order = {
    expected: points,
    next: 0,          // indeks następnego punktu do ułożenia (w całym paśmie)
    batchStart: 0,
    batchEnd: 0,
    pool: [],
    mistakes: 0,
  };
  startBatch();
  $('order-title').textContent = `${state.trail.short} · ${part} · układanie`;
  setOrderFeedback('Dotknij klocka, który jest następny na szlaku', '');
  show('order');
  renderOrder();
}

function setOrderFeedback(text, kind) {
  const el = $('order-feedback');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

function slotItem(nrText, labelText, cls) {
  const li = document.createElement('li');
  const nr = document.createElement('span');
  nr.className = 'nr';
  nr.textContent = nrText;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = labelText;
  li.append(nr, label);
  li.className = cls;
  return li;
}

function renderOrder() {
  const o = state.order;
  const total = o.expected.length;
  $('order-progress').textContent = `Ułożone: ${o.next} / ${total} · pomyłki: ${o.mistakes}`;

  const slots = $('slots');
  slots.innerHTML = '';
  // Ostatni punkt poprzedniego etapu – żeby było wiadomo, od czego układamy dalej.
  if (o.batchStart > 0) {
    const prev = o.expected[o.batchStart - 1];
    slots.appendChild(slotItem(o.batchStart, prev.label, 'prev'));
  }
  for (let i = o.batchStart; i < o.batchEnd; i++) {
    const done = i < o.next;
    const cls = done ? 'locked' : (i === o.next ? 'empty next' : 'empty');
    slots.appendChild(slotItem(i + 1, done ? o.expected[i].label : '', cls));
  }

  const pool = $('pool');
  pool.innerHTML = '';
  for (const tile of o.pool) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.textContent = tile.label;
    b.addEventListener('click', () => place(tile, b));
    pool.appendChild(b);
  }
  pool.hidden = o.pool.length === 0;

  const next = slots.querySelector('.next');
  if (next) next.scrollIntoView({ block: 'nearest' });
}

function place(tile, button) {
  const o = state.order;
  const expected = o.expected[o.next];
  // Porównujemy nazwy – dwa punkty o tej samej nazwie (np. Beskidek) są zamienne.
  if (tile.label !== expected.label) {
    o.mistakes++;
    setOrderFeedback(`✗ „${tile.label}” to nie ten punkt`, 'bad');
    $('order-progress').textContent = `Ułożone: ${o.next} / ${o.expected.length} · pomyłki: ${o.mistakes}`;
    button.classList.remove('wrong');
    void button.offsetWidth; // restart animacji
    button.classList.add('wrong');
    return;
  }
  o.next++;
  o.pool = o.pool.filter((t) => t !== tile);

  if (o.next === o.expected.length) {
    setOrderFeedback(`✓ ${tile.label}`, 'ok');
    renderOrder();
    return setTimeout(finishOrder, 500);
  }
  if (o.next === o.batchEnd) {
    // Etap ułożony – chwila na zobaczenie całości, potem kolejne klocki.
    setOrderFeedback(`✓ ${tile.label} – etap ułożony, kolejne klocki…`, 'ok');
    renderOrder();
    const batchEnd = o.batchEnd;
    return setTimeout(() => {
      if (state.order !== o || o.batchEnd !== batchEnd) return;
      startBatch();
      setOrderFeedback('Dotknij klocka, który jest następny na szlaku', '');
      renderOrder();
    }, 900);
  }
  setOrderFeedback(`✓ ${tile.label}`, 'ok');
  renderOrder();
}

$('order-back').addEventListener('click', () => show('start'));

renderBatchSize();

function finishOrder() {
  const o = state.order;
  $('summary').textContent =
    `Ułożone punkty: ${o.expected.length} · pomyłki: ${o.mistakes}`;
  show('end');
  saveResult({ mode: 'order', total: o.expected.length, correct: o.expected.length, mistakes: o.mistakes });
}

// --- pomiędzy: losowe miejsce na szlaku, wpisz punkt między dwoma sąsiadami ------------------

const BETWEEN_ROUNDS = 10;

async function startBetween(part) {
  const points = await getPoints(part);
  if (tooFew(points, 3)) return;
  if (state.reversed) points.reverse();
  // Losowe, niepowtarzające się „środki” (bez pierwszego i ostatniego punktu).
  const middles = shuffle(points.slice(1, -1).map((_, i) => i + 1)).slice(0, BETWEEN_ROUNDS);
  state.part = part;
  state.lastMode = 'between';
  state.startedAt = Date.now();
  state.between = {
    points, queue: middles, i: 0, correct: 0, close: 0, revealed: 0, mistakes: 0, hintLevel: 0, busy: false,
  };
  $('between-title').textContent = `${state.trail.short} · ${part || 'cały szlak'} · pomiędzy`;
  show('between');
  nextBetween();
}

function pointBox(el, p) {
  el.replaceChildren();
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = TYPE_ICON[p.typ_punktu] || '•';
  const label = document.createElement('span');
  label.className = 'label';
  labelWithMap(label, p);
  const meta = document.createElement('small');
  meta.textContent = p.height ? `${p.typ_punktu} · ${p.height} m` : p.typ_punktu;
  el.append(ico, label, meta);
}

function setBetweenFeedback(text, kind) {
  const el = $('b-feedback');
  el.textContent = text;
  el.className = `feedback ${kind}`;
}

function renderBetweenProgress() {
  const b = state.between;
  $('between-progress').textContent = `Pytanie ${Math.min(b.i + 1, b.queue.length)} / ${b.queue.length} · trafione: ${b.correct}`;
  $('between-fill').style.width = `${(b.i / b.queue.length) * 100}%`;
}

function nextBetween() {
  const b = state.between;
  if (b.i >= b.queue.length) return finishBetween();
  const k = b.queue[b.i];
  b.cur = { prev: b.points[k - 1], mid: b.points[k], next: b.points[k + 1] };
  b.hintLevel = 0;
  b.busy = false;
  pointBox($('b-prev'), b.cur.prev);
  pointBox($('b-next'), b.cur.next);
  const mid = $('b-mid');
  mid.className = 'b-point b-mid';
  mid.textContent = '?';
  $('b-hint').textContent = '';
  setBetweenFeedback('', '');
  $('b-answer').value = '';
  $('b-answer').focus({ preventScroll: true });
  renderBetweenProgress();
}

// Pokaż odpowiedź w środku karty i po chwili przejdź do następnego pytania.
function resolveBetween(kind, delay) {
  const b = state.between;
  b.busy = true;
  const mid = $('b-mid');
  pointBox(mid, b.cur.mid);
  mid.className = `b-point b-mid ${kind}`;
  b.i++;
  renderBetweenProgress();
  setTimeout(() => { if (state.between === b) nextBetween(); }, delay);
}

$('between-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const b = state.between;
  const input = $('b-answer').value;
  if (b.busy || !input.trim()) return;
  const score = similarity(input, b.cur.mid.label);
  if (score >= state.threshold) {
    b.correct++;
    if (score < 100) b.close++;
    setBetweenFeedback(score === 100 ? '✓ 100% – dokładnie tak' : `✓ ${score}% – zaliczone, poprawnie: ${b.cur.mid.label}`,
      score === 100 ? 'ok' : 'close');
    resolveBetween(score === 100 ? 'ok' : 'close', 1200);
  } else {
    b.mistakes++;
    setBetweenFeedback(`✗ ${score}% zgodności – potrzeba ${state.threshold}%`, 'bad');
    const field = $('b-answer');
    field.classList.remove('wrong');
    void field.offsetWidth; // restart animacji
    field.classList.add('wrong');
    field.select();
  }
});

$('b-btn-hint').addEventListener('click', () => {
  const b = state.between;
  if (b.busy) return;
  const p = b.cur.mid;
  b.hintLevel++;
  const type = `${p.typ_punktu}${p.height ? ` ${p.height} m` : ''}`;
  const hints = [
    `Typ: ${TYPE_ICON[p.typ_punktu] || ''} ${type}`,
    `Typ: ${type} · zaczyna się na „${p.label[0]}”`,
    `Typ: ${type} · „${p.label.slice(0, Math.ceil(p.label.length / 2))}…”`,
  ];
  $('b-hint').textContent = hints[Math.min(b.hintLevel, hints.length) - 1];
  $('b-answer').focus({ preventScroll: true });
});

$('b-btn-reveal').addEventListener('click', () => {
  const b = state.between;
  if (b.busy) return;
  b.revealed++;
  setBetweenFeedback(`Pomiędzy jest: ${b.cur.mid.label}`, 'revealed');
  resolveBetween('revealed', 2200);
});

$('between-back').addEventListener('click', () => {
  state.between = null;
  show('start');
});

function finishBetween() {
  const b = state.between;
  const n = b.queue.length;
  $('summary').textContent =
    `Trafione: ${b.correct} / ${n} (w tym z literówką: ${b.close}) · ` +
    `pokazane: ${b.revealed} · błędne próby: ${b.mistakes}`;
  show('end');
  saveResult({ mode: 'between', total: n, correct: b.correct, close: b.close, revealed: b.revealed, mistakes: b.mistakes });
}

$('again').addEventListener('click', () => {
  if (state.lastMode === 'order') return startOrder(state.part);
  if (state.lastMode === 'between') return startBetween(state.part);
  return startQuiz(state.part);
});
$('home').addEventListener('click', () => show('start'));

// --- oczko przy haśle: pokaż / ukryj wpisywane hasło ------------------------------------

document.querySelectorAll('input[type="password"]').forEach((input) => {
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.replaceWith(wrap);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'pw-eye';
  eye.textContent = '👁';
  eye.setAttribute('aria-label', 'Pokaż hasło');
  eye.setAttribute('aria-pressed', 'false');
  eye.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    eye.textContent = visible ? '🙈' : '👁';
    eye.setAttribute('aria-label', visible ? 'Ukryj hasło' : 'Pokaż hasło');
    eye.setAttribute('aria-pressed', String(visible));
    input.focus({ preventScroll: true });
  });
  // Po wysłaniu formularza hasło znów jest ukryte.
  if (input.form) {
    input.form.addEventListener('submit', () => {
      input.type = 'password';
      eye.textContent = '👁';
      eye.setAttribute('aria-label', 'Pokaż hasło');
      eye.setAttribute('aria-pressed', 'false');
    });
  }
  wrap.append(input, eye);
});

// --- odpowiedź głosem (Web Speech API) ---------------------------------------------------
// Przycisk 🎤 pojawia się tylko, gdy przeglądarka rozpoznaje mowę i wykryto mikrofon.
// Przeglądarki udostępniają mikrofon tylko na HTTPS (albo localhost).

const VOICE = {
  answer: {
    expected: () => (state.points[state.index] || {}).label,
    form: 'answer-form',
    feedback: (t, k) => setFeedback(t, k),
  },
  'b-answer': {
    expected: () => (state.between && !state.between.busy && state.between.cur ? state.between.cur.mid.label : null),
    form: 'between-form',
    feedback: (t, k) => setBetweenFeedback(t, k),
  },
};
let recognition = null;

const speechCtor = () => window.SpeechRecognition || window.webkitSpeechRecognition;

async function detectMicrophone() {
  if (!speechCtor() || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'audioinput');
  } catch {
    return false;
  }
}

async function initVoice() {
  const ok = await detectMicrophone();
  document.querySelectorAll('.mic').forEach((b) => { b.hidden = !ok; });
  return ok;
}

function stopListening() {
  if (recognition) {
    try { recognition.abort(); } catch {}
    recognition = null;
  }
  document.querySelectorAll('.mic.listening').forEach((b) => b.classList.remove('listening'));
}

document.querySelectorAll('.mic').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (recognition) return stopListening(); // drugie dotknięcie = przerwij słuchanie
    const cfg = VOICE[btn.dataset.for];
    const expected = cfg.expected();
    if (!expected) return;
    const Ctor = speechCtor();
    const rec = new Ctor();
    rec.lang = 'pl-PL';
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    recognition = rec;
    btn.classList.add('listening');
    cfg.feedback('🎤 Słucham… powiedz nazwę punktu', '');

    rec.onresult = (e) => {
      // Rozpoznawanie nazw własnych bywa niepewne – z kilku propozycji bierzemy najbliższą nazwie punktu.
      const alts = [...e.results[0]].map((a) => a.transcript.trim()).filter(Boolean);
      if (!alts.length) return;
      const best = alts.reduce((a, b) => (similarity(b, expected) > similarity(a, expected) ? b : a));
      $(btn.dataset.for).value = best;
      stopListening();
      $(cfg.form).requestSubmit();
    };
    rec.onerror = (e) => {
      const msg = {
        'not-allowed': 'Brak zgody na mikrofon – zezwól w ustawieniach przeglądarki.',
        'service-not-allowed': 'Rozpoznawanie mowy jest wyłączone w tej przeglądarce.',
        'no-speech': 'Nic nie usłyszałem – spróbuj jeszcze raz.',
        'audio-capture': 'Nie znaleziono mikrofonu.',
        network: 'Rozpoznawanie mowy potrzebuje internetu.',
      }[e.error];
      if (e.error !== 'aborted') cfg.feedback(`🎤 ${msg || `Błąd rozpoznawania mowy (${e.error}).`}`, 'bad');
      stopListening();
    };
    rec.onend = () => {
      if (recognition === rec) stopListening();
    };
    try {
      rec.start();
    } catch {
      stopListening();
    }
  });
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', initVoice);
}
initVoice();

renderMode();
renderLevel();
renderThreshold();
loadTrails()
  .then(restoreSession)
  .then(() => {
    renderAccount();
    return selectTrail(state.trail);
  })
  .catch((err) => {
    $('parts').innerHTML = `<li class="error">Nie udało się wczytać danych: ${err.message}</li>`;
  });
