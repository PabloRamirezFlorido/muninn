const api = window.muninn;
const $ = (id) => document.getElementById(id);

const GAME_NAMES = { lol: 'League of Legends', valorant: 'Valorant', desktop: 'Escritorio', mix: 'Varios juegos' };
const GIF_MAX_SECONDS = 15;
const ENCODER_NAMES = {
  auto: 'Automático (mejor disponible)',
  h264_nvenc: 'NVIDIA NVENC H.264',
  hevc_nvenc: 'NVIDIA NVENC H.265 (ocupa menos)',
  h264_amf: 'AMD AMF H.264',
  h264_qsv: 'Intel Quick Sync H.264',
  libx264: 'CPU x264 (lento)',
};

let state = { settings: null, encoders: [], status: null };
let items = [];
let view = 'clips';
let current = null;
let trimIn = null;
let trimOut = null;
let selecting = false; // modo "elegir vídeos para un montaje"
let selected = [];     // ids en el orden en que se eligieron

// ---------- utilidades ----------

function fmtDur(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtBytes(b) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Hoy, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ayer, ${time}`;
  return `${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}, ${time}`;
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

// ---------- estado ----------

function renderStatus(st) {
  state.status = st;
  const s = state.settings;
  if (!s) return; // llega estado antes de cargar los ajustes: se pinta al terminar 'state:get'
  const dot = $('rec-dot');
  dot.className = `rec-dot${st.paused ? ' paused' : st.recording ? ' on' : ''}`;

  let title;
  if (st.paused) title = 'Grabación en pausa';
  else if (st.starting) title = 'Iniciando en segundo plano…';
  else if (st.match) title = `En partida · ${st.gameName}`;
  else if (st.recording && st.game) title = `Grabando · ${st.gameName}`;
  else if (st.recording) title = 'Grabando (modo siempre)';
  else title = s.recordMode === 'game' ? 'Esperando a que abras un juego' : 'Detenido';
  $('status-title').textContent = title;

  const audio = st.audio.system && st.audio.mic ? 'sistema + micro' : st.audio.system ? 'sistema' : st.audio.mic ? 'micro' : 'sin audio';
  const parts = [];
  if (st.recording) {
    parts.push(st.captureKind === 'window' ? 'Ventana del juego' : 'Pantalla completa');
    parts.push(`Buffer ${Math.round(st.buffered)} s (${fmtBytes(st.bufferBytes)})`);
    parts.push(`${ENCODER_NAMES[st.encoder] || st.encoder}${st.zeroCopy && st.encoder.endsWith('nvenc') ? ' · GPU directa' : ''}`);
    parts.push(`Audio: ${audio}`);
  }
  if (st.match) parts.push(`Partida ${fmtDur((Date.now() - st.match.startedAt) / 1000)}`);
  if (st.pendingClip) parts.push('Guardando momento…');
  $('status-sub').textContent = parts.join('  ·  ');

  $('btn-clip').textContent = `Guardar clip (${s.hotkeyClip})`;
  $('btn-clip').disabled = !st.recording;
  $('btn-pause').textContent = st.paused ? 'Reanudar' : 'Pausar';

  const err = st.error || st.audio.error;
  $('error').classList.toggle('hidden', !err);
  $('error-text').textContent = err || '';

  const u = st.usage;
  const pct = (b) => `${Math.min(100, (b / u.quota) * 100)}%`;
  $('bar-matches').style.width = pct(u.matches);
  $('bar-clips').style.width = pct(u.clips);
  $('storage-text').textContent = `${fmtBytes(u.total)} / ${fmtBytes(u.quota)}`;
}

// ---------- biblioteca ----------

async function loadLibrary() {
  items = await api.invoke('library:list');
  renderGrid();
}

// Partida y clips se relacionan por tiempo: un clip pertenece a la partida del mismo juego que
// estaba grabándose cuando ocurrió. Así funciona también con lo grabado antes de esta versión.
function matchOf(clip) {
  if (!clip || clip.type === 'match' || clip.montage) return null;
  return items.find((m) => m.type === 'match' && m.game === clip.game
    && clip.createdAt >= m.createdAt - 2000 && clip.createdAt <= m.createdAt + m.duration * 1000) || null;
}

function clipsOf(match) {
  return items.filter((c) => c.type === 'clip' && matchOf(c)?.id === match.id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function statsParts(it) {
  const s = it.stats;
  if (!s) return [];
  if (s.score) return [['Marcador', s.score]];
  const parts = [['KDA', `${s.kills}/${s.deaths}/${s.assists}`], ['CS', s.cs]];
  if (s.vision != null) parts.push(['Visión', s.vision]);
  if (s.level != null) parts.push(['Nivel', s.level]);
  if (s.gameTime) parts.push(['Duración', fmtDur(s.gameTime)]);
  return parts;
}

function statsLine(it) {
  const s = it.stats;
  if (!s) return '';
  if (s.score) return `Marcador ${s.score}`;
  return [s.champion, `${s.kills}/${s.deaths}/${s.assists}`, `${s.cs} CS`].filter(Boolean).join(' · ');
}

function visibleItems() {
  const game = $('filter-game').value;
  const q = $('filter-text').value.trim().toLowerCase();
  return items.filter((it) => {
    if (view === 'clips' && it.type !== 'clip') return false;
    if (view === 'matches' && it.type !== 'match') return false;
    if (view === 'favorites' && !it.favorite) return false;
    if (game && it.game !== game) return false;
    if (q && !`${it.title} ${(it.events || []).map((e) => e.label).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderGrid() {
  const list = visibleItems();
  const grid = $('grid');
  grid.classList.toggle('selecting', selecting);
  grid.replaceChildren(...list.map((it) => {
    const nClips = it.type === 'match' ? clipsOf(it).length : 0;
    const order = selecting ? selected.indexOf(it.id) + 1 : 0;
    const thumb = el('div', { class: 'thumb' },
      it.favorite ? el('span', { class: 'fav' }, '★') : null,
      nClips ? el('span', { class: 'count' }, `${nClips} clip${nClips > 1 ? 's' : ''}`) : null,
      order ? el('span', { class: 'order' }, String(order)) : null,
      el('span', { class: 'game' }, GAME_NAMES[it.game] || it.game),
      el('span', { class: 'dur' }, fmtDur(it.duration)));
    if (it.thumbUrl) thumb.style.backgroundImage = `url("${it.thumbUrl}")`;
    const stats = statsLine(it);
    return el('div', { class: `card${order ? ' selected' : ''}`, onclick: () => (selecting ? toggleSelect(it) : openItem(it)) },
      thumb,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title', title: it.title }, it.title),
        stats ? el('div', { class: 'card-stats' }, stats) : null,
        el('div', { class: 'card-meta' }, el('span', {}, fmtDate(it.createdAt)), el('span', {}, fmtBytes(it.size)))));
  }));
  $('empty').classList.toggle('hidden', list.length > 0);
}

// ---------- montaje ----------

function setSelecting(on) {
  selecting = on;
  selected = [];
  $('selbar').classList.toggle('hidden', !on);
  $('btn-select').classList.toggle('hidden', on);
  updateSelbar();
  renderGrid();
}

function toggleSelect(it) {
  const i = selected.indexOf(it.id);
  if (i >= 0) selected.splice(i, 1); else selected.push(it.id);
  updateSelbar();
  renderGrid();
}

function updateSelbar() {
  const chosen = selected.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const total = chosen.reduce((s, x) => s + (x.duration || 0), 0);
  $('sel-text').textContent = chosen.length
    ? `${chosen.length} vídeo${chosen.length > 1 ? 's' : ''} · ${fmtDur(total)} · haz clic para quitar o añadir`
    : 'Haz clic en los vídeos en el orden en que quieres que salgan';
  $('sel-create').disabled = chosen.length < 2;
}

async function createMontage() {
  const btn = $('sel-create');
  const ids = [...selected];
  btn.disabled = true;
  setLabel(btn, 'Creando montaje…');
  $('sel-cancel').disabled = true;
  try {
    const it = await api.invoke('library:montage', ids, { fade: $('sel-fade').checked ? 0.5 : 0 });
    setSelecting(false);
    if (view === 'matches' || view === 'favorites') setView('clips');
    await loadLibrary();
    openItem(items.find((x) => x.id === it.id) || it);
  } catch (e) {
    alert(`No se pudo crear el montaje: ${cleanError(e)}`);
  } finally {
    setLabel(btn, 'Crear montaje');
    $('sel-cancel').disabled = false;
    updateSelbar();
  }
}

// Los botones de herramienta llevan icono + <span class="lbl">: solo se cambia el texto.
function setLabel(btn, text) {
  const lbl = btn.querySelector('.lbl');
  if (lbl) lbl.textContent = text; else btn.textContent = text;
}

function cleanError(e) {
  return String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setView(v) {
  view = v;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  const isSettings = v === 'settings';
  $('view-library').classList.toggle('hidden', isSettings);
  $('view-settings').classList.toggle('hidden', !isSettings);
  if (isSettings) renderSettings();
  else {
    $('lib-title').textContent = { clips: 'Clips', matches: 'Partidas', favorites: 'Favoritos' }[v];
    renderGrid();
  }
}

// ---------- reproductor ----------

const EVENT_COLORS = {
  kill: '#ef4444', multikill: '#f59e0b', ace: '#f59e0b', firstblood: '#f97316', steal: '#a855f7',
  objective: '#8b5cf6', structure: '#94a3b8', victory: '#22c55e', round_win: '#22c55e',
  round_loss: '#64748b', death: '#64748b', defeat: '#64748b', assist: '#9cc3d3', manual: '#58a9bf',
  note: '#e8d9a8',
};
// Al pulsar un momento se preselecciona este tramo a su alrededor.
const MOMENT_BEFORE = 10;
const MOMENT_AFTER = 4;

const video = () => $('m-video');
const duration = () => (Number.isFinite(video().duration) ? video().duration : current?.duration || 0);
const pct = (t) => `${Math.max(0, Math.min(100, (t / (duration() || 1)) * 100))}%`;

function momentTime(ev) {
  return ev.at ? (ev.at - current.createdAt) / 1000 : null;
}

function selectMoment(t) {
  trimIn = Math.max(0, t - MOMENT_BEFORE);
  trimOut = Math.min(duration(), t + MOMENT_AFTER);
  updateTrim();
  video().currentTime = trimIn;
  video().play().catch(() => {});
}

function renderTimeline() {
  if (!current) return;
  $('m-total').textContent = fmtDur(duration());
  const markers = [];
  const chips = [];
  for (const ev of current.events || []) {
    const t = momentTime(ev);
    const color = EVENT_COLORS[ev.type] || '#e5e7eb';
    if (t == null || t < 0 || t > duration() + 1) {
      chips.push(el('span', { class: 'chip' }, ev.label));
      continue;
    }
    const isNote = ev.type === 'note';
    const tip = `${fmtDur(t)} · ${isNote ? `Nota: ${ev.label}` : ev.label} — clic para seleccionar este momento`;
    const m = el('button', { class: 'tl-marker', title: tip, onclick: (e) => { e.stopPropagation(); selectMoment(t); } });
    m.style.left = pct(t);
    m.style.setProperty('--c', color);
    markers.push(m);
    const remove = isNote ? el('span', {
      class: 'x', title: 'Borrar nota',
      onclick: async (e) => {
        e.stopPropagation();
        Object.assign(current, await api.invoke('library:note-remove', current.id, ev.at));
        renderTimeline();
        loadLibrary();
      },
    }, '✕') : null;
    const chip = el('button', { class: 'chip', title: tip, onclick: () => selectMoment(t) },
      el('i'), `${fmtDur(t)} · ${isNote ? `“${ev.label}”` : ev.label}`, remove);
    chip.style.setProperty('--c', color);
    chips.push(chip);
  }
  $('m-markers').replaceChildren(...markers);
  $('m-events').replaceChildren(...chips);
}

// Estadísticas y relación partida ↔ clips encima del vídeo.
function renderContext() {
  const it = current;
  const parts = [];
  for (const [k, v] of statsParts(it)) parts.push(el('span', { class: 'stat' }, `${k} `, el('b', {}, String(v))));
  if (it.type === 'match') {
    const clips = clipsOf(it);
    if (clips.length) {
      parts.push(el('span', { class: 'muted small' }, 'Clips de esta partida:'));
      parts.push(el('div', { class: 'rel' }, clips.map((c) => {
        const b = el('button', { class: 'rel-clip', title: c.title, onclick: () => openItem(c) }, el('span', {}, c.title));
        if (c.thumbUrl) b.style.backgroundImage = `url("${c.thumbUrl}")`;
        return b;
      })));
    }
  } else {
    const m = matchOf(it);
    if (m) {
      parts.push(el('button', {
        class: 'ghost small-btn', title: m.title,
        onclick: () => {
          const t = (it.createdAt - m.createdAt) / 1000;
          openItem(m, { select: [Math.max(0, t), t + it.duration] });
        },
      }, 'Ver en la partida completa'));
    }
  }
  $('m-context').replaceChildren(...parts);
}

function openItem(it, { select } = {}) {
  current = it;
  trimIn = select ? select[0] : null;
  trimOut = select ? select[1] : null;
  closeNoteBox();
  $('m-title').value = it.title;
  video().src = it.fileUrl;
  if (select) video().addEventListener('loadedmetadata', () => { video().currentTime = select[0]; }, { once: true });
  $('m-fav').textContent = it.favorite ? '★ Favorito' : '☆ Favorito';
  setLabel($('m-discord'), 'Discord');
  setLabel($('m-gif'), 'GIF');
  updateTrim();
  renderContext();
  renderTimeline();
  $('modal').classList.remove('hidden');
  video().play().catch(() => {});
}

// ---------- notas ----------

let noteAt = null;

function openNoteBox() {
  if (!current) return;
  noteAt = current.createdAt + video().currentTime * 1000;
  video().pause();
  $('m-note-text').placeholder = `Nota en ${fmtDur(video().currentTime)} (Enter para guardar)`;
  $('m-note-box').classList.remove('hidden');
  $('m-note-text').value = '';
  $('m-note-text').focus();
}

function closeNoteBox() {
  noteAt = null;
  $('m-note-box').classList.add('hidden');
}

async function saveNote() {
  const text = $('m-note-text').value.trim();
  if (!text || noteAt == null) { closeNoteBox(); return; }
  Object.assign(current, await api.invoke('library:note-add', current.id, noteAt, text));
  closeNoteBox();
  renderTimeline();
  loadLibrary();
}

function closeModal() {
  $('m-video').pause();
  $('m-video').removeAttribute('src');
  $('m-video').load();
  $('modal').classList.add('hidden');
  current = null;
}

function updateTrim() {
  const ok = trimIn != null && trimOut != null && trimOut - trimIn >= 1;
  $('m-range').textContent = trimIn == null && trimOut == null ? 'Elige un momento o marca inicio/fin'
    : `${trimIn == null ? '—' : fmtDur(trimIn)} → ${trimOut == null ? '—' : fmtDur(trimOut)}`;
  $('m-trim').disabled = !ok;
  setLabel($('m-trim'), ok ? `Recortar ${fmtDur(trimOut - trimIn)}` : 'Recortar');
  $('m-preview').disabled = !ok;
  $('m-clear').disabled = trimIn == null && trimOut == null;
  $('m-slow').disabled = !ok;
  // GIF: el tramo seleccionado, o el vídeo entero si es corto.
  const gifLen = ok ? trimOut - trimIn : duration();
  $('m-gif').disabled = !(gifLen > 0.3 && gifLen <= GIF_MAX_SECONDS + 0.01);
  $('m-gif').title = gifLen > GIF_MAX_SECONDS
    ? `Selecciona un tramo de ${GIF_MAX_SECONDS} s como mucho para hacer un GIF`
    : 'GIF del tramo seleccionado (o del vídeo entero si es corto), copiado para pegar';
  const sel = $('m-sel');
  sel.classList.toggle('hidden', trimIn == null || trimOut == null);
  if (trimIn != null && trimOut != null) {
    sel.style.left = pct(trimIn);
    sel.style.width = `calc(${pct(trimOut)} - ${pct(trimIn)})`;
  }
}

function timeAt(clientX) {
  const r = $('m-track').getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration();
}

let previewEnd = null;
let dragEdge = null;

async function saveTitle() {
  if (!current) return;
  const title = $('m-title').value.trim();
  if (!title || title === current.title) return;
  const updated = await api.invoke('library:update', current.id, { title });
  Object.assign(current, updated);
  loadLibrary();
}

// ---------- ajustes ----------

// Secciones de Ajustes: menú lateral (con un resumen del estado actual) y, a la derecha, la
// sección elegida en una sola columna. `when` atenúa una fila si ese ajuste está desactivado.
// `color` es la clase con el tono de la sección (mismo sistema que las herramientas: --tc/--tt).
const RES_LABELS = { native: 'Nativa', 1440: '1440p', 1080: '1080p', 720: '720p' };
const QUALITY_LABELS = { high: 'Alta', balanced: 'Equilibrada', saver: 'Ahorro' };
const onOff = (v) => (v ? 'Sí' : 'No');
const pctLabel = (v) => `${Math.round((v ?? 1) * 100)} %`;

const SECTIONS = [
  {
    id: 'rec', title: 'Grabación', color: 's-rec',
    icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
    desc: 'Qué se graba, cuándo y con qué calidad.',
    summary: (s) => `${RES_LABELS[s.resolution] || s.resolution} · ${s.fps} fps · ${QUALITY_LABELS[s.quality] || s.quality}`,
    groups: [
      {
        title: 'Qué y cuándo',
        fields: [
          { key: 'recordMode', label: 'Cuándo grabar', type: 'seg', options: { game: 'Con un juego abierto', always: 'Siempre' } },
          { key: 'captureMode', label: 'Qué grabar', hint: 'La ventana del juego no incluye otras ventanas ni el escritorio aunque estén encima', type: 'seg', options: { game: 'Ventana del juego', monitor: 'Pantalla completa' } },
          { key: 'monitor', label: 'Monitor', hint: 'Para pantalla completa o sin juego abierto (0 = principal)', type: 'number', min: 0, max: 8 },
        ],
      },
      {
        title: 'Imagen',
        fields: [
          // Lista (no objeto): JavaScript pondría primero las claves numéricas (720p…) y "Nativa" al final.
          { key: 'resolution', label: 'Resolución', type: 'seg', options: [['native', 'Nativa'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p']] },
          { key: 'fps', label: 'FPS', type: 'seg', options: { 30: '30', 60: '60', 120: '120', 144: '144' }, number: true },
          { key: 'quality', label: 'Calidad', hint: 'A 1440p60: alta ≈ 7 GB/h, equilibrada ≈ 4,3 GB/h, ahorro ≈ 2,7 GB/h', type: 'seg', options: { high: 'Alta', balanced: 'Equilibrada', saver: 'Ahorro' } },
          { key: 'encoder', label: 'Codificador', hint: 'Automático elige el mejor que funcione en tu equipo', type: 'encoder' },
        ],
      },
      {
        title: 'Clips manuales',
        fields: [
          { key: 'hotkeyClip', label: 'Tecla para guardar clip', hint: 'Haz clic y pulsa la combinación', type: 'hotkey' },
          { key: 'clipSeconds', label: 'Duración del clip manual', type: 'number', min: 5, max: 600, unit: 's' },
          { key: 'bufferSeconds', label: 'Buffer fuera de partida', hint: 'Cuánto se conserva grabado cuando no estás en partida', type: 'number', min: 30, max: 1800, unit: 's' },
        ],
      },
    ],
  },
  {
    id: 'audio', title: 'Audio', color: 's-audio',
    icon: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    desc: 'Sonido del juego y del micrófono en tus grabaciones.',
    summary: (s) => `Juego ${s.audio.system ? pctLabel(s.audio.systemVolume) : 'no'} · Micro ${s.audio.mic ? pctLabel(s.audio.micVolume) : 'no'}`,
    groups: [
      {
        title: 'Juego y sistema',
        fields: [
          { key: 'audio.system', label: 'Grabar el audio del juego / sistema', type: 'switch' },
          { key: 'audio.systemVolume', label: 'Volumen', hint: 'Se graba sin tener en cuenta el volumen de Windows; bájalo si los clips suenan fuertes', type: 'range', min: 0, max: 1.5, step: 0.05, when: 'audio.system' },
        ],
      },
      {
        title: 'Micrófono',
        fields: [
          { key: 'audio.mic', label: 'Grabar el micrófono', type: 'switch' },
          { key: 'audio.micDeviceId', label: 'Dispositivo', type: 'mic', when: 'audio.mic' },
          { key: 'audio.micVolume', label: 'Volumen', type: 'range', min: 0, max: 2, step: 0.05, when: 'audio.mic' },
        ],
      },
    ],
  },
  {
    id: 'storage', title: 'Almacenamiento', color: 's-storage',
    icon: '<rect x="2" y="13" width="20" height="8" rx="2"/><path d="M5.5 13 8 4h8l2.5 9M6 17h.01M10 17h.01"/>',
    desc: 'Dónde se guardan los vídeos y cuánto espacio pueden ocupar.',
    summary: (s) => `${s.storageQuotaGB} GB · partidas: ${s.saveFullMatches ? 'sí' : 'no'}`,
    groups: [
      {
        title: 'Biblioteca',
        fields: [
          { key: 'libraryDir', label: 'Carpeta de vídeos', hint: 'Cambiarla reinicia la app', type: 'folder' },
          {
            key: 'storageQuotaGB', label: 'Espacio máximo', type: 'number', min: 1, max: 10000, unit: 'GB', usage: true,
            hint: 'Al superarlo se borran primero las partidas más antiguas y luego los clips. Los favoritos nunca se borran.',
          },
          { key: 'saveFullMatches', label: 'Guardar partidas completas', hint: 'Es lo que más ocupa; los clips sueltos se guardan igualmente', type: 'switch' },
        ],
      },
      {
        title: 'Clips y exportación',
        fields: [
          { key: 'maxClipSeconds', label: 'Duración máxima de un clip', hint: 'Los momentos seguidos se unen hasta este límite', type: 'number', min: 20, max: 300, unit: 's' },
          { key: 'discordLimitMB', label: 'Tamaño para Discord', hint: '10 MB sin Nitro, 50 con Nitro Basic, 500 con Nitro', type: 'number', min: 5, max: 500, unit: 'MB' },
        ],
      },
    ],
  },
  {
    id: 'general', title: 'General', color: 's-general',
    icon: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    desc: 'Arranque, avisos y otros juegos.',
    summary: (s) => `Inicio con Windows: ${onOff(s.launchAtStartup)}`,
    groups: [
      {
        title: 'Inicio',
        fields: [
          {
            key: 'launchAtStartup', label: 'Iniciar con Windows', type: 'switch',
            hint: 'Bajo impacto: arranca en la bandeja con prioridad baja y espera 30 s antes de vigilar juegos',
            warn: () => (state.settings.launchAtStartup && state.status?.loginItem === 'blocked'
              ? 'Windows lo tiene desactivado: actívalo en Administrador de tareas → Aplicaciones de arranque' : null),
          },
          { key: 'startMinimized', label: 'Arrancar minimizada en la bandeja', hint: 'También al abrirla tú, no solo al iniciar Windows', type: 'switch' },
        ],
      },
      {
        title: 'Avisos',
        fields: [{ key: 'notify', label: 'Aviso en pantalla al guardar un clip', type: 'switch' }],
      },
      {
        title: 'Otros juegos',
        fields: [{ key: 'customProcesses', label: 'Ejecutables que activan la grabación', hint: 'Separados por comas, p. ej. cs2.exe, eldenring.exe', type: 'list' }],
      },
    ],
  },
  {
    id: 'lol', title: 'League of Legends', color: 's-lol',
    icon: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2"/>',
    desc: 'Usa la API oficial de Riot y solo detecta tus momentos. Todos se marcan en la barra de la partida; aquí eliges cuáles generan además un clip.',
    summary: (s) => {
      if (!s.lol.enabled) return 'Desactivado';
      const n = ['kill', 'ace', 'firstBlood', 'steals', 'objectives', 'turrets', 'assists', 'deaths', 'victory'].filter((k) => s.lol[k]).length
        + (s.lol.multikillMin < 99 ? 1 : 0);
      return `${n} tipos de momento con clip`;
    },
    groups: [
      { fields: [{ key: 'lol.enabled', label: 'Detectar momentos automáticamente', type: 'switch' }] },
      {
        title: 'Generan un clip',
        fields: [
          { key: 'lol.kill', label: 'Kills', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.multikillMin', label: 'Multikill a partir de', type: 'seg', options: { 2: 'Doble', 3: 'Triple', 4: 'Cuádruple', 5: 'Penta', 99: 'Nunca' }, number: true, when: 'lol.enabled' },
          { key: 'lol.ace', label: 'Ace', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.firstBlood', label: 'Primera sangre', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.steals', label: 'Robo de dragón / barón / heraldo', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.objectives', label: 'Cualquier objetivo (dragón, barón…)', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.turrets', label: 'Torres e inhibidores', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.assists', label: 'Asistencias', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.deaths', label: 'Muertes', type: 'switch', when: 'lol.enabled' },
          { key: 'lol.victory', label: 'Victoria (final de partida)', type: 'switch', when: 'lol.enabled' },
        ],
      },
      {
        title: 'Duración de cada clip',
        fields: [
          { key: 'lol.preSeconds', label: 'Segundos antes del momento', type: 'number', min: 3, max: 120, unit: 's', when: 'lol.enabled' },
          { key: 'lol.postSeconds', label: 'Segundos después', type: 'number', min: 0, max: 60, unit: 's', when: 'lol.enabled' },
        ],
      },
    ],
  },
  {
    id: 'valorant', title: 'Valorant', color: 's-valorant',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
    desc: 'Riot no ofrece API de kills para Valorant: se detectan las partidas y el marcador de cada ronda. Para jugadas concretas, usa la tecla rápida.',
    summary: (s) => (s.valorant.enabled ? `Rondas: ${[s.valorant.roundWin && 'ganadas', s.valorant.roundLoss && 'perdidas'].filter(Boolean).join(' y ') || 'ninguna'}` : 'Desactivado'),
    groups: [
      { fields: [{ key: 'valorant.enabled', label: 'Detectar partidas y rondas', type: 'switch' }] },
      {
        title: 'Generan un clip',
        fields: [
          { key: 'valorant.roundWin', label: 'Ronda ganada', type: 'switch', when: 'valorant.enabled' },
          { key: 'valorant.roundLoss', label: 'Ronda perdida', type: 'switch', when: 'valorant.enabled' },
        ],
      },
      {
        title: 'Duración de cada clip',
        fields: [
          { key: 'valorant.preSeconds', label: 'Segundos antes del fin de ronda', type: 'number', min: 5, max: 120, unit: 's', when: 'valorant.enabled' },
          { key: 'valorant.postSeconds', label: 'Segundos después', type: 'number', min: 0, max: 30, unit: 's', when: 'valorant.enabled' },
        ],
      },
    ],
  },
];

let settingsSection = (() => { try { return localStorage.getItem('muninn.settingsSection') || 'rec'; } catch { return 'rec'; } })();

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function patchFor(key, value) {
  const parts = key.split('.');
  const patch = {};
  let o = patch;
  parts.slice(0, -1).forEach((p) => { o = o[p] = {}; });
  o[parts[parts.length - 1]] = value;
  return patch;
}

async function save(key, value) {
  state.settings = await api.invoke('settings:update', patchFor(key, value));
  // Aviso visual en la fila cambiada + resúmenes del menú y filas dependientes al día, sin
  // repintar toda la sección (se perdería el foco del campo que estás editando).
  const row = document.querySelector(`#settings .row[data-key="${key}"]`);
  if (row) {
    row.classList.remove('saved');
    void row.offsetWidth; // reinicia la animación si se guarda dos veces seguidas
    row.classList.add('saved');
    clearTimeout(row.savedTimer);
    row.savedTimer = setTimeout(() => row.classList.remove('saved'), 1600);
  }
  refreshSettingsState();
  if (state.status) renderStatus(state.status);
}

function refreshSettingsState() {
  for (const r of document.querySelectorAll('#settings .row[data-when]')) {
    r.classList.toggle('off', !getPath(state.settings, r.dataset.when));
  }
  for (const b of document.querySelectorAll('#settings .set-nav button[data-id]')) {
    const sec = SECTIONS.find((x) => x.id === b.dataset.id);
    b.querySelector('.s').textContent = sec.summary(state.settings);
  }
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (/^Arrow/.test(key)) key = key.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join('+');
}

async function micOptions(select, value) {
  try {
    // Pedir el micro un instante es lo que permite ver los nombres de los dispositivos.
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch { /* sin permiso: solo se verá "Predeterminado" */ }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  select.replaceChildren(
    el('option', { value: '' }, 'Predeterminado'),
    ...devices.map((d) => el('option', { value: d.deviceId }, d.label || 'Micrófono')),
  );
  select.value = value || '';
}

function field(f) {
  const value = getPath(state.settings, f.key);
  let input;
  switch (f.type) {
    case 'switch': {
      const cb = el('input', { type: 'checkbox', checked: !!value, onchange: () => save(f.key, cb.checked) });
      input = el('label', { class: 'switch' }, cb, el('span'));
      break;
    }
    case 'number':
      input = el('input', {
        type: 'number', min: f.min, max: f.max, value,
        onchange: (e) => {
          const v = Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min));
          e.target.value = v;
          save(f.key, v);
        },
      });
      break;
    case 'range': {
      const out = el('span', { class: 'muted small' }, `${Math.round(value * 100)}%`);
      const r = el('input', {
        type: 'range', min: f.min, max: f.max, step: f.step, value,
        oninput: () => { out.textContent = `${Math.round(r.value * 100)}%`; },
        onchange: () => save(f.key, Number(r.value)),
      });
      input = el('div', { class: 'folder' }, r, out);
      break;
    }
    case 'select':
      input = el('select', { onchange: (e) => save(f.key, f.number ? Number(e.target.value) : e.target.value) },
        Object.entries(f.options).map(([v, l]) => el('option', { value: v }, l)));
      input.value = String(value);
      break;
    case 'seg': {
      // Botones segmentados: todas las opciones a la vista y la elegida resaltada.
      const opts = Array.isArray(f.options) ? f.options : Object.entries(f.options);
      const buttons = opts.map(([v, l]) => el('button', {
        type: 'button', class: String(value) === v ? 'on' : '',
        onclick: () => {
          buttons.forEach((b) => b.classList.toggle('on', b === btn(v)));
          save(f.key, f.number ? Number(v) : v);
        },
      }, l));
      const btn = (v) => buttons[opts.findIndex(([k]) => k === v)];
      input = el('div', { class: 'seg-group', role: 'group' }, buttons);
      break;
    }
    case 'encoder':
      input = el('select', { onchange: (e) => save(f.key, e.target.value) },
        ['auto', ...state.encoders].map((v) => el('option', { value: v }, ENCODER_NAMES[v] || v)));
      input.value = state.encoders.includes(value) ? value : 'auto';
      break;
    case 'mic':
      input = el('select', { onchange: (e) => save(f.key, e.target.value) });
      micOptions(input, value);
      break;
    case 'list':
      input = el('textarea', {
        value: (value || []).join(', '),
        onchange: (e) => save(f.key, e.target.value.split(',').map((s) => s.trim()).filter(Boolean)),
      });
      break;
    case 'hotkey': {
      input = el('input', { type: 'text', readOnly: true, class: 'hotkey', value });
      input.addEventListener('click', () => { input.classList.add('listening'); input.value = 'Pulsa una tecla…'; });
      input.addEventListener('blur', () => { input.classList.remove('listening'); input.value = getPath(state.settings, f.key); });
      input.addEventListener('keydown', (e) => {
        if (!input.classList.contains('listening')) return;
        e.preventDefault();
        if (e.key === 'Escape') { input.blur(); return; }
        const acc = toAccelerator(e);
        if (!acc) return;
        input.classList.remove('listening');
        save(f.key, acc).then(() => { input.value = acc; input.blur(); });
      });
      break;
    }
    case 'folder': {
      const code = el('code', { title: value }, value);
      input = el('div', { class: 'folder' }, code, el('button', {
        type: 'button', class: 'ghost small-btn',
        onclick: async () => {
          const dir = await api.invoke('dialog:folder');
          if (dir && dir !== value) save(f.key, dir);
        },
      }, 'Cambiar'));
      break;
    }
    default:
      input = el('span');
  }
  const unit = f.unit ? el('span', { class: 'unit' }, f.unit) : null;
  const warn = f.warn ? f.warn() : null;
  let usage = null;
  if (f.usage && state.status) {
    // Barra con lo que ya ocupa la biblioteca frente al máximo elegido.
    const u = state.status.usage;
    const pct = Math.min(100, (u.total / (value * 1024 ** 3)) * 100);
    const bar = el('span', { class: 'mini-bar' }, el('i'));
    bar.firstChild.style.width = `${pct}%`;
    usage = el('span', { class: 'hint usage' }, bar, `Ahora ocupa ${fmtBytes(u.total)} (${Math.round(pct)} %)`);
  }
  const row = el('div', { class: 'row' },
    el('div', { class: 'row-label' },
      el('span', { class: 'row-title' }, f.label, el('span', { class: 'ok', title: 'Guardado' }, '✓ Guardado')),
      f.hint ? el('span', { class: 'hint' }, f.hint) : null,
      usage,
      warn ? el('span', { class: 'hint warn' }, warn) : null),
    el('div', { class: 'row-control' }, input, unit));
  row.dataset.key = f.key;
  if (f.when) {
    row.dataset.when = f.when;
    row.classList.toggle('off', !getPath(state.settings, f.when));
  }
  return row;
}

function renderSettings() {
  const sec = SECTIONS.find((s) => s.id === settingsSection) || SECTIONS[0];
  const icon = (s, cls) => {
    const span = el('span', { class: cls });
    span.innerHTML = `<svg viewBox="0 0 24 24">${s.icon}</svg>`; // iconos fijos del propio código
    return span;
  };
  const nav = el('nav', { class: 'set-nav', 'aria-label': 'Secciones de ajustes' }, SECTIONS.map((s) => {
    const b = el('button', {
      type: 'button', class: `${s.color}${s.id === sec.id ? ' active' : ''}`,
      onclick: () => {
        settingsSection = s.id;
        try { localStorage.setItem('muninn.settingsSection', s.id); } catch { /* sin almacenamiento */ }
        renderSettings();
        $('view-settings').scrollTop = 0;
      },
    }, icon(s, 'ico'), el('span', { class: 'nav-text' }, el('span', { class: 't' }, s.title), el('span', { class: 's' }, s.summary(state.settings))));
    b.dataset.id = s.id;
    return b;
  }));
  const panel = el('div', { class: `set-panel ${sec.color}` },
    el('div', { class: 'set-head' }, icon(sec, 'ico big'), el('div', {}, el('h2', {}, sec.title), el('p', {}, sec.desc))),
    sec.groups.map((g) => el('div', { class: 'set-group' },
      g.title ? el('h3', {}, g.title) : null,
      el('div', { class: 'set-card' }, g.fields.map(field)))));
  $('settings').replaceChildren(el('div', { class: 'set-layout' }, nav, panel));
}

// ---------- eventos ----------

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('filter-game').addEventListener('change', renderGrid);
$('filter-text').addEventListener('input', renderGrid);
$('open-folder').addEventListener('click', () => api.invoke('library:open-folder'));
$('btn-clip').addEventListener('click', () => api.invoke('clip:manual'));
$('btn-pause').addEventListener('click', () => api.invoke('recording:toggle'));
$('error-close').addEventListener('click', () => { api.invoke('error:clear'); $('error').classList.add('hidden'); });

$('m-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Escape') {
    if (noteAt != null) closeNoteBox(); else closeModal();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'i' || e.key === 'I') $('m-in').click();
  if (e.key === 'o' || e.key === 'O') $('m-out').click();
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNoteBox(); }
});
$('m-note').addEventListener('click', openNoteBox);
$('m-note-save').addEventListener('click', saveNote);
$('m-note-cancel').addEventListener('click', closeNoteBox);
$('m-note-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNote(); });
$('btn-select').addEventListener('click', () => setSelecting(true));
$('sel-cancel').addEventListener('click', () => setSelecting(false));
$('sel-create').addEventListener('click', createMontage);
$('m-slow').addEventListener('click', async () => {
  const btn = $('m-slow');
  btn.disabled = true;
  setLabel(btn, 'Creando…');
  try {
    const it = await api.invoke('library:slowmo', current.id, trimIn, trimOut, Number($('m-speed').value));
    await loadLibrary();
    openItem(items.find((x) => x.id === it.id) || it);
  } catch (e) {
    alert(`No se pudo crear la cámara lenta: ${cleanError(e)}`);
  } finally {
    setLabel(btn, 'Cámara lenta');
    updateTrim();
  }
});
$('m-gif').addEventListener('click', async () => {
  const btn = $('m-gif');
  const it = current;
  const ok = trimIn != null && trimOut != null && trimOut - trimIn >= 1;
  btn.disabled = true;
  setLabel(btn, 'Creando GIF…');
  try {
    const { size } = await api.invoke('library:gif', it.id, ok ? trimIn : 0, ok ? trimOut : duration());
    if (current === it) setLabel(btn, `GIF copiado · ${(size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    if (current === it) setLabel(btn, 'GIF');
    alert(`No se pudo crear el GIF: ${cleanError(e)}`);
  } finally {
    updateTrim();
  }
});
$('m-discord').addEventListener('click', async () => {
  const btn = $('m-discord');
  const it = current;
  btn.disabled = true;
  setLabel(btn, 'Comprimiendo…');
  try {
    const { size } = await api.invoke('library:discord', it.id);
    if (current === it) setLabel(btn, `Copiado · ${(size / 1048576).toFixed(1)} MB · Ctrl+V`);
  } catch (e) {
    if (current === it) setLabel(btn, 'Discord');
    alert(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    btn.disabled = false;
  }
});
$('m-title').addEventListener('change', saveTitle);
$('m-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('m-fav').addEventListener('click', async () => {
  const updated = await api.invoke('library:update', current.id, { favorite: !current.favorite });
  Object.assign(current, updated);
  $('m-fav').textContent = current.favorite ? '★ Favorito' : '☆ Favorito';
  loadLibrary();
});
$('m-reveal').addEventListener('click', () => api.invoke('library:reveal', current.id));
$('m-delete').addEventListener('click', async () => {
  if (!confirm(`¿Eliminar "${current.title}"? El archivo se borrará del disco.`)) return;
  const id = current.id;
  closeModal();
  await api.invoke('library:remove', id);
  loadLibrary();
});
$('m-in').addEventListener('click', () => {
  trimIn = video().currentTime;
  if (trimOut == null || trimOut <= trimIn) trimOut = Math.min(duration(), trimIn + 15);
  updateTrim();
});
$('m-out').addEventListener('click', () => {
  trimOut = video().currentTime;
  if (trimIn == null || trimIn >= trimOut) trimIn = Math.max(0, trimOut - 15);
  updateTrim();
});
$('m-clear').addEventListener('click', () => { trimIn = null; trimOut = null; previewEnd = null; updateTrim(); });
$('m-preview').addEventListener('click', () => {
  previewEnd = trimOut;
  video().currentTime = trimIn;
  video().play().catch(() => {});
});

// Barra: clic = ir a ese punto; arrastrar los extremos de la selección = ajustar el recorte.
$('m-track').addEventListener('pointerdown', (e) => {
  const edge = e.target.closest('.tl-handle')?.dataset.edge;
  if (edge) {
    dragEdge = edge;
    $('m-track').setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.target.closest('.tl-marker')) return;
  previewEnd = null;
  video().currentTime = timeAt(e.clientX);
});
$('m-track').addEventListener('pointermove', (e) => {
  if (!dragEdge) return;
  const t = timeAt(e.clientX);
  if (dragEdge === 'in') trimIn = Math.min(t, trimOut - 1);
  else trimOut = Math.max(t, trimIn + 1);
  video().currentTime = dragEdge === 'in' ? trimIn : trimOut;
  updateTrim();
});
$('m-track').addEventListener('pointerup', () => { dragEdge = null; });

video().addEventListener('loadedmetadata', () => { renderTimeline(); updateTrim(); });
video().addEventListener('timeupdate', () => {
  $('m-head').style.left = pct(video().currentTime);
  if (previewEnd != null && video().currentTime >= previewEnd) {
    video().pause();
    previewEnd = null;
  }
});
$('m-trim').addEventListener('click', async () => {
  const btn = $('m-trim');
  btn.disabled = true;
  setLabel(btn, 'Recortando…');
  try {
    const it = await api.invoke('library:trim', current.id, trimIn, trimOut);
    await loadLibrary();
    openItem(items.find((x) => x.id === it.id) || it);
  } catch (e) {
    alert(`No se pudo recortar: ${cleanError(e)}`);
  } finally {
    setLabel(btn, 'Recortar');
    updateTrim();
  }
});

api.on('status', renderStatus);
api.on('library:changed', loadLibrary);

(async () => {
  state = await api.invoke('state:get');
  $('app-version').textContent = `Versión ${state.version}`;
  renderStatus(state.status);
  await loadLibrary();
})();
