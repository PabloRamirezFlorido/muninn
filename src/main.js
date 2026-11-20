const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, shell, dialog, screen,
  session, desktopCapturer, nativeImage,
} = require('electron');
const { Settings } = require('./settings');
const { Recorder } = require('./recorder');
const { Library, GAME_NAMES } = require('./library');
const { Director } = require('./director');
const { ProcessWatcher, LolClient, ValorantClient } = require('./games');
const { cachedEncoders, forgetEncoders } = require('./ffmpeg');

// Permite ejecutar una copia aislada (pruebas) con su propia configuración.
const TEST_DATA = process.env.MUNINN_DATA || process.env.JUGADAS_DATA;
if (TEST_DATA) app.setPath('userData', TEST_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);

// Hasta la 1.2 la app se llamaba Jugadas y guardaba la configuración en %APPDATA%\Jugadas.
// La primera vez que arranca Muninn se copia, para conservar carpeta de vídeos, teclas, etc.
function migrateFromJugadas() {
  // MUNINN_OLD_DATA permite probar la migración con una copia aislada.
  if (TEST_DATA && !process.env.MUNINN_OLD_DATA) return;
  const fs = require('fs');
  const dir = app.getPath('userData');
  const old = process.env.MUNINN_OLD_DATA || path.join(app.getPath('appData'), 'Jugadas');
  if (fs.existsSync(path.join(dir, 'settings.json')) || !fs.existsSync(path.join(old, 'settings.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['settings.json', 'encoders.json']) {
    try { fs.copyFileSync(path.join(old, f), path.join(dir, f)); } catch { /* opcional */ }
  }
  log('migrado desde', old);
}

const ASSETS = path.join(__dirname, '..', 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

// Lanzada por Windows al iniciar sesión (ver loginItemOptions): todo lo que no hace falta para
// estar en la bandeja se aplaza para no competir con el resto del arranque del sistema.
const AT_LOGIN = process.argv.includes('--hidden');
const LOGIN_DELAY_MS = 30000;

let settings; let library; let recorder; let director; let watcher; let lol; let valorant;
let mainWin = null; let audioWin = null; let toastWin = null; let tray;
let encoders = ['libx264'];
let resolveEncoders;
const encodersReady = new Promise((r) => { resolveEncoders = r; });
let booted = false;
let bootTimer = null;
let paused = false;
let audioState = { ready: false, system: false, mic: false, error: null };
let audioTimeout = null;
let lastError = null;
let quitting = false;
let demo = false;

const S = () => settings.get();
const encoderCacheFile = () => path.join(app.getPath('userData'), 'encoders.json');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try { require('fs').appendFileSync(path.join(app.getPath('userData'), 'muninn.log'), line); } catch { /* sin log */ }
}

function gameId() {
  const g = watcher && watcher.current;
  if (!g) return 'desktop';
  return g.startsWith('custom:') ? g.slice(7).replace(/\.exe$/i, '') : g;
}

// Regex del .exe cuya ventana se graba (filtro gfxcapture), o null para grabar el monitor.
function windowTarget() {
  const g = watcher.current;
  if (S().captureMode !== 'game' || !g) return null;
  if (g === 'lol') return '(?i)league of legends[.]exe$';
  if (g === 'valorant') return '(?i)valorant-win64-shipping[.]exe$';
  const exe = g.slice('custom:'.length).replace(/[^a-z0-9 _-]/gi, (c) => `[${c}]`);
  return `(?i)${exe}$`;
}

function chooseEncoder() {
  const want = S().encoder;
  return want !== 'auto' && encoders.includes(want) ? want : encoders[0];
}

// ---------- Inicio con Windows ----------

function loginItemOptions() {
  // En desarrollo el ejecutable es electron.exe y hay que pasarle la carpeta de la app.
  return process.defaultApp
    ? { path: process.execPath, args: [path.resolve(process.argv[1]), '--hidden'] }
    : { path: process.execPath, args: ['--hidden'] };
}

function applyLoginItem(enabled) {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: enabled });
}

/** 'on', 'off' o 'blocked' (activado en Muninn pero desactivado en el Administrador de tareas). */
function loginItemState() {
  const st = app.getLoginItemSettings(loginItemOptions());
  if (!st.openAtLogin) return 'off';
  return st.executableWillLaunchAtLogin === false ? 'blocked' : 'on';
}

// ---------- Ventanas (se crean solo cuando hacen falta) ----------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, show: false,
    title: 'Muninn', backgroundColor: '#070B0E', autoHideMenuBar: true,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin && mainWin.show());
  // Al cerrar se destruye en vez de ocultarse: mientras juegas no ocupa memoria. Abrirla de
  // nuevo desde la bandeja tarda un instante más.
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  boot();
  if (!mainWin) { createMainWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function sendToMain(channel, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
}

function startAudio() {
  // Ventana oculta que captura el audio del sistema (loopback) y el micro con WebAudio y
  // envía PCM a FFmpeg. Solo existe mientras se graba: capturar audio cuesta CPU continuamente.
  if (audioWin) return;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });
  audioWin = new BrowserWindow({
    show: false, width: 200, height: 100,
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  audioWin.webContents.on('console-message', (e) => log('audio-console', e.message || ''));
  audioWin.webContents.once('did-finish-load', configureAudio);
  audioWin.loadFile(path.join(__dirname, 'renderer', 'audio.html'));
  // Si el audio no responde en 4 s, se graba sin audio en lugar de no grabar.
  clearTimeout(audioTimeout);
  audioTimeout = setTimeout(() => {
    if (audioState.ready || !audioWin) return;
    log('audio sin respuesta');
    audioState = { ready: true, system: false, mic: false, error: 'El audio no respondió' };
    updateRecording();
  }, 4000);
}

function stopAudio() {
  clearTimeout(audioTimeout);
  if (audioWin) audioWin.destroy();
  audioWin = null;
  audioState = { ready: false, system: false, mic: false, error: null };
}

function configureAudio() {
  if (!audioWin) return;
  audioState = { ...audioState, ready: false };
  audioWin.webContents.send('audio:config', S().audio);
}

let toastTimer;
function toast(title, body, kind = 'ok') {
  if (!S().notify) return;
  if (!toastWin) {
    toastWin = new BrowserWindow({
      width: 360, height: 84, show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.setIgnoreMouseEvents(true);
    toastWin.loadFile(path.join(__dirname, 'renderer', 'toast.html'));
  }
  const w = toastWin;
  const show = () => {
    const { workArea } = screen.getPrimaryDisplay();
    w.setPosition(workArea.x + workArea.width - 380, workArea.y + 20);
    w.webContents.send('toast', { title, body, kind });
    w.showInactive();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      // Se destruye al ocultarse: la próxima notificación la vuelve a crear.
      if (toastWin === w) { w.destroy(); toastWin = null; }
    }, 3500);
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', show);
  else show();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('Muninn');
  tray.on('click', showMain);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Muninn', click: showMain },
    { label: `Guardar clip ahora (${S().hotkeyClip})`, click: manualClip, enabled: !!recorder?.running },
    { label: paused ? 'Reanudar grabación' : 'Pausar grabación', click: togglePause },
    { type: 'separator' },
    { label: 'Abrir carpeta de vídeos', click: () => shell.openPath(S().libraryDir) },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- Grabación ----------

function shouldRecord() {
  if (paused || !booted) return false;
  return demo || S().recordMode === 'always' || !!watcher.current;
}

let stopping = false;
async function updateRecording() {
  await encodersReady;
  if (shouldRecord()) {
    if (!recorder.running && !audioState.ready) {
      startAudio(); // se llama otra vez al llegar 'audio:ready'
      return;
    }
    recorder.setEncoder(chooseEncoder());
    recorder.setWindowTarget(windowTarget());
    recorder.start({ audio: audioState.ready && (audioState.system || audioState.mic) });
  } else if (recorder.running && !stopping) {
    // Antes de parar hay que terminar de guardar la partida y los clips pendientes.
    stopping = true;
    await director.whenIdle();
    stopping = false;
    if (!shouldRecord()) {
      recorder.stop();
      stopAudio();
    }
  }
  refreshTray();
  pushStatus();
}

function togglePause() {
  paused = !paused;
  log(paused ? 'pausa' : 'reanudar');
  updateRecording();
}

function manualClip() {
  if (!recorder.running || recorder.bufferedSeconds() < 1) {
    boot();
    toast('No se está grabando', 'Abre un juego o activa "Grabar siempre"', 'warn');
    return;
  }
  toast('Guardando clip…', `Últimos ${S().clipSeconds} s`, 'info');
  director.manualClip(gameId());
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    if (!globalShortcut.register(S().hotkeyClip, manualClip)) lastError = `No se pudo registrar la tecla ${S().hotkeyClip} (¿la usa otra app?)`;
  } catch {
    lastError = `Tecla rápida no válida: ${S().hotkeyClip}`;
  }
}

// ---------- Estado para la interfaz ----------

function status() {
  const u = library.usage();
  return {
    recording: recorder.running,
    paused,
    starting: !booted,
    game: watcher.current ? gameId() : null,
    gameName: watcher.current ? (GAME_NAMES[gameId()] || gameId()) : null,
    match: director.match ? { game: director.match.game, startedAt: director.match.startedAt } : null,
    pendingClip: !!director.pending,
    buffered: recorder.bufferedSeconds(),
    bufferBytes: recorder.bufferBytes(),
    encoder: recorder.encoder,
    zeroCopy: recorder.zeroCopy && recorder.captureKind === 'monitor',
    captureKind: recorder.captureKind,
    audio: audioState,
    usage: u,
    loginItem: loginItemState(),
    error: lastError,
  };
}

function pushStatus() {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) mainWin.webContents.send('status', status());
}

/** Deja el archivo en el portapapeles para pegarlo directamente en Discord u otro chat (Ctrl+V). */
function copyFileToClipboard(file) {
  return new Promise((resolve) => {
    const quoted = `'${file.replace(/'/g, "''")}'`; // comillas simples de PowerShell
    require('child_process').execFile('powershell', ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath ${quoted}`],
      { windowsHide: true }, () => resolve());
  });
}

function serialize(it) {
  return { ...it, fileUrl: pathToFileURL(it.file).href, thumbUrl: it.thumb ? pathToFileURL(it.thumb).href : null };
}

// ---------- IPC ----------

function setupIpc() {
  ipcMain.handle('state:get', async () => {
    await encodersReady;
    return { settings: S(), encoders, status: status(), version: app.getVersion() };
  });
  ipcMain.handle('library:list', () => library.list().map(serialize));
  ipcMain.handle('library:update', (_e, id, patch) => serialize(library.update(id, patch)));
  ipcMain.handle('library:remove', (_e, id) => library.remove(id));
  ipcMain.handle('library:reveal', (_e, id) => { const it = library.get(id); if (it) shell.showItemInFolder(it.file); });
  ipcMain.handle('library:trim', async (_e, id, start, end) => serialize(await library.trim(id, start, end, recorder.encoder)));
  ipcMain.handle('library:note-add', (_e, id, at, text) => serialize(library.addNote(id, at, text)));
  ipcMain.handle('library:note-remove', (_e, id, at) => serialize(library.removeNote(id, at)));
  ipcMain.handle('library:discord', async (_e, id) => {
    await encodersReady;
    const { file, size } = await library.exportForDiscord(id, Number(S().discordLimitMB) || 10, chooseEncoder());
    await copyFileToClipboard(file);
    log('exportado para Discord', path.basename(file), size);
    return { file, size };
  });
  ipcMain.handle('library:gif', async (_e, id, start, end) => {
    const { file, size } = await library.exportGif(id, start, end);
    await copyFileToClipboard(file);
    log('GIF', path.basename(file), size);
    return { file, size };
  });
  ipcMain.handle('library:montage', async (_e, ids, opts) => {
    await encodersReady;
    const it = await library.montage(ids, chooseEncoder(), opts);
    log('montaje', it.title, ids.length);
    return serialize(it);
  });
  ipcMain.handle('library:slowmo', async (_e, id, start, end, factor) => {
    await encodersReady;
    return serialize(await library.slowMotion(id, start, end, factor, chooseEncoder()));
  });
  ipcMain.handle('library:reveal-file', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('library:open-folder', () => shell.openPath(S().libraryDir));
  ipcMain.handle('clip:manual', () => manualClip());
  ipcMain.handle('recording:toggle', () => { togglePause(); return paused; });
  ipcMain.handle('error:clear', () => { lastError = null; });
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: S().libraryDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));

  ipcMain.on('audio:chunk', (_e, { buf, wall }) => recorder.writeAudio(Buffer.from(buf), wall));
  ipcMain.on('audio:ready', (e, st) => {
    if (!audioWin || e.sender !== audioWin.webContents) return; // ventana ya cerrada
    clearTimeout(audioTimeout);
    const wasEnabled = recorder.audioEnabled;
    audioState = { ready: true, ...st };
    log('audio', st);
    const nowEnabled = st.system || st.mic;
    if (recorder.running && wasEnabled !== nowEnabled) {
      recorder.audioEnabled = nowEnabled;
      recorder.restart();
    } else {
      updateRecording();
    }
  });
}

function onSettingsChanged(next, prev) {
  if (next.libraryDir !== prev.libraryDir) {
    // El buffer vive dentro de la carpeta de la biblioteca: lo más limpio es reiniciar.
    quitting = true;
    app.relaunch();
    app.exit(0);
    return;
  }
  const recKeys = ['monitor', 'fps', 'resolution', 'quality', 'encoder'];
  if (recKeys.some((k) => next[k] !== prev[k]) && recorder.running) {
    recorder.setEncoder(chooseEncoder());
    recorder.zeroCopy = true;
    recorder.restart();
  }
  if (next.captureMode !== prev.captureMode && booted) recorder.setWindowTarget(windowTarget());
  if (JSON.stringify(next.audio) !== JSON.stringify(prev.audio)) configureAudio();
  if (next.hotkeyClip !== prev.hotkeyClip) { lastError = null; registerHotkey(); }
  if (next.launchAtStartup !== prev.launchAtStartup) applyLoginItem(next.launchAtStartup);
  if (next.storageQuotaGB !== prev.storageQuotaGB) library.enforceQuota();
  if (next.recordMode !== prev.recordMode || JSON.stringify(next.customProcesses) !== JSON.stringify(prev.customProcesses)) {
    watcher.poll();
    updateRecording();
  }
  if (next.lol.enabled !== prev.lol.enabled || next.valorant.enabled !== prev.valorant.enabled) syncGameClients();
  refreshTray();
  pushStatus();
}

function syncGameClients() {
  const g = watcher.current;
  if (g === 'lol' && S().lol.enabled) lol.start(); else lol.stop();
  if (g === 'valorant' && S().valorant.enabled) valorant.start(); else valorant.stop();
}

// ---------- Arranque ----------

/**
 * Parte "pesada" del arranque: detectar encoders, vigilar procesos y empezar a grabar.
 * Al iniciar con Windows se aplaza LOGIN_DELAY_MS, salvo que antes abras la app o pulses
 * la tecla rápida.
 */
function boot() {
  if (booted) return;
  booted = true;
  clearTimeout(bootTimer);
  if (AT_LOGIN) {
    try { os.setPriority(os.constants.priority.PRIORITY_NORMAL); } catch { /* sin permisos */ }
  }
  cachedEncoders(encoderCacheFile()).then((list) => {
    encoders = list;
    log('inicio', { version: app.getVersion(), encoders, alIniciarWindows: AT_LOGIN });
    resolveEncoders();
  });
  watcher.start();
  if (process.argv.includes('--demo')) runDemo();
  updateRecording();
}

app.on('second-instance', showMain);

app.whenReady().then(() => {
  if (AT_LOGIN) {
    // Mientras dura el arranque de Windows, Muninn cede la CPU al resto.
    try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* sin permisos */ }
  }
  migrateFromJugadas();
  settings = new Settings();
  library = new Library(S);
  recorder = new Recorder(S, path.join(S().libraryDir, '_buffer'));
  director = new Director({ recorder, library, getSettings: S });
  watcher = new ProcessWatcher(S);
  lol = new LolClient(S);
  valorant = new ValorantClient(S);

  setupIpc();
  settings.onChange(onSettingsChanged);
  createTray();
  registerHotkey();
  // Si la instalación cambió de carpeta, el acceso de inicio debe apuntar al nuevo .exe.
  if (S().launchAtStartup) applyLoginItem(true);

  recorder.on('status', () => {
    log('grabador', { running: recorder.running, captura: recorder.captureKind, encoder: recorder.encoder, zeroCopy: recorder.zeroCopy, audio: recorder.audioEnabled, correccionesAudio: recorder.audioCorrections, ffmpeg: recorder.lastLog.slice(-3) });
    refreshTray();
    pushStatus();
  });
  recorder.on('error', (e) => {
    log('error grabador', e.message);
    forgetEncoders(encoderCacheFile()); // quizá cambió la GPU o el driver: se vuelven a probar
    lastError = e.message;
    toast('Error de grabación', 'Revisa la app para más detalles', 'error');
    pushStatus();
  });

  director.on('saved', (it) => {
    log('guardado', it.type, it.title);
    toast(it.type === 'match' ? 'Partida guardada' : 'Clip guardado', it.title);
    sendToMain('library:changed');
  });
  director.on('failed', (e) => { log('error guardando', e.message); toast('No se pudo guardar', e.message, 'error'); });
  director.on('match', () => pushStatus());
  director.on('discarded', (m) => log('partida descartada por corta', m.game, `${Math.round((Date.now() - m.startedAt) / 1000)} s`));
  library.on('pruned', (items) => {
    sendToMain('library:changed');
    toast('Espacio liberado', `Se borraron ${items.length} vídeo(s) antiguos por la cuota`, 'info');
  });

  for (const [client, id] of [[lol, 'lol'], [valorant, 'valorant']]) {
    client.on('matchStart', (info) => { log('inicio partida', id, info); director.matchStart(id, info); });
    client.on('event', (ev) => {
      log('momento', id, ev.label, { clip: ev.clip, grabando: recorder.running });
      if (ev.clip && recorder.running) director.highlight(id, ev);
      else director.mark(id, ev);
    });
    client.on('matchEnd', (info) => { log('fin partida', id, info); director.matchEnd(id, info); });
  }

  watcher.on('change', (game) => {
    log('juego', game || 'ninguno');
    syncGameClients();
    updateRecording();
  });

  setInterval(pushStatus, 1000);

  if (AT_LOGIN) {
    bootTimer = setTimeout(boot, LOGIN_DELAY_MS);
  } else {
    if (!S().startMinimized) showMain();
    boot();
  }
});

// Simula una partida de LoL para probar todo el flujo sin abrir el juego (npm start -- --demo).
function runDemo() {
  demo = true;
  updateRecording();
  const at = (s, fn) => setTimeout(fn, s * 1000);
  const ev = (type, label, priority, clip = true) => ({ type, label, priority, clip, wall: Date.now(), pre: 6, post: 2 });
  at(6, () => lol.emit('matchStart', { champion: 'Ahri' }));
  at(10, () => lol.emit('event', ev('assist', 'Asistencia', 0, false)));
  at(14, () => lol.emit('event', ev('kill', 'Kill', 1)));
  at(15, () => lol.emit('event', ev('kill', 'Kill', 1)));
  at(15.5, () => lol.emit('event', ev('multikill', 'Doble kill', 4)));
  at(17, () => lol.emit('event', ev('death', 'Muerte', 0, false)));
  at(26, () => lol.emit('event', ev('steal', 'Robo de Barón', 7)));
  at(34, () => lol.emit('matchEnd', {
    result: 'win', champion: 'Ahri',
    stats: { champion: 'Ahri', kills: 2, deaths: 1, assists: 1, cs: 187, vision: 21, level: 14, gameTime: 1712 },
  }));
}

app.on('window-all-closed', () => { /* sigue en la bandeja */ });

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (recorder) recorder.dispose();
  if (watcher) watcher.dispose();
});
