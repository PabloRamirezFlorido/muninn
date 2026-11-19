const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { FFMPEG, run } = require('./ffmpeg');

const SEGMENT_SECONDS = 2;
// MUNINN_FFDEBUG=1 guarda la salida completa de FFmpeg junto al buffer (JUGADAS_* por compatibilidad).
const FF_DEBUG = !!(process.env.MUNINN_FFDEBUG || process.env.JUGADAS_FFDEBUG);
const QUALITY = {
  high: { cq: 23, maxMbps: 30, avgMbps: 16 },
  balanced: { cq: 27, maxMbps: 18, avgMbps: 10 },
  saver: { cq: 31, maxMbps: 10, avgMbps: 6 },
};
// Diferencia entre el retardo con que llega el audio al worklet y el que lleva el vídeo hasta
// setpts. Calibrado con destello + pitido: el desfase sin compensar varía entre -33 y 0 ms de un
// arranque a otro, así que se centra en -16 (queda en ±17 ms). Negativo = el vídeo tarda más.
const AUDIO_LATENCY_MS = -16;
// Desviación tolerada antes de corregir el audio (30 ms a 48 kHz); por debajo es solo el
// vaivén normal de los mensajes entre procesos.
const DRIFT_FRAMES = 1440;
// La desviación tiene que mantenerse en tantos trozos seguidos (~1 s) para corregirla: un
// trozo que llega tarde por un tirón del renderer no es deriva del reloj.
const DRIFT_CHUNKS = 10;
const MAX_PIN_MS = 4 * 60 * 60 * 1000; // una partida "colgada" no puede retener más de 4 h de buffer

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Graba la pantalla de forma continua en segmentos de 2 s (mpegts) dentro de una carpeta
 * de buffer. Los segmentos antiguos se borran salvo que estén "anclados" (partida en curso o
 * clip pendiente). Un clip = concatenar los segmentos que cubren un rango de tiempo real.
 */
class Recorder extends EventEmitter {
  constructor(getSettings, bufferDir) {
    super();
    this.getSettings = getSettings;
    this.bufferDir = bufferDir;
    this.encoder = 'libx264';
    this.zeroCopy = true;
    this.proc = null;
    this.wanted = false;
    this.segments = [];        // { file, wallStart, wallEnd }
    this.pins = new Map();     // id -> wallFrom (ms)
    this.failures = 0;
    this.lastLog = [];
    this.audioEnabled = false;
    this.audioCorrections = 0;
    this.windowExe = null;     // regex del .exe cuya ventana se graba; null = monitor completo
    this.windowFallback = false;
    fs.mkdirSync(bufferDir, { recursive: true });
    // Lo que quede de una sesión anterior ya no tiene marcas de tiempo fiables.
    for (const f of fs.readdirSync(bufferDir)) fs.rmSync(path.join(bufferDir, f), { force: true });
    this.cleanupTimer = setInterval(() => this.cleanup(), 5000);
  }

  get running() { return !!this.proc; }

  setEncoder(enc) { this.encoder = enc; }

  /** Qué se graba ahora mismo: 'window' (ventana del juego) o 'monitor'. */
  get captureKind() { return this.proc ? this.proc.captureKind : null; }

  /** Graba solo la ventana del ejecutable indicado (regex), o el monitor si es null. */
  setWindowTarget(exeRegex) {
    if (exeRegex === this.windowExe) return;
    this.windowExe = exeRegex;
    this.windowFallback = false;
    this.windowRetryMs = 15000;
    clearTimeout(this.windowRetry);
    if (this.proc) this.restart();
  }

  start({ audio }) {
    this.wanted = true;
    this.audioEnabled = audio;
    if (this.proc) return;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      p.kill();
      this.emit('status');
    }
  }

  restart() {
    if (!this.wanted) return;
    const audio = this.audioEnabled;
    this.stop();
    setTimeout(() => this.start({ audio }), 500);
  }

  /**
   * Escribe un trozo de PCM (s16le estéreo 48 kHz) cuya última muestra se capturó en `wallEnd`
   * (ms). La muestra n del stream corresponde a la hora t0 + n/48000, igual que el vídeo usa la
   * hora real de cada fotograma; si el reloj de la tarjeta de sonido se desvía o se pierden
   * muestras, se rellena con silencio o se recorta para volver a cuadrar.
   */
  writeAudio(buf, wallEnd = Date.now()) {
    const p = this.proc;
    if (!p || !p.audio || !p.stdin.writable) return;
    const frames = buf.length / 4;
    const startWall = wallEnd - AUDIO_LATENCY_MS - frames / 48;
    const diff = Math.round((startWall - p.t0ms) * 48) - p.framesWritten;
    const first = p.framesWritten === 0;
    // Se corrige solo lo que se repite en todos los trozos recientes: la desviación más
    // pequeña de la ventana (los retrasos puntuales de llegada solo la harían mayor).
    let fix = 0;
    if (first) {
      fix = diff;
    } else {
      p.drift = [...(p.drift || []).slice(1 - DRIFT_CHUNKS), diff];
      if (p.drift.length === DRIFT_CHUNKS) {
        if (p.drift.every((d) => d > DRIFT_FRAMES)) fix = Math.min(...p.drift);
        else if (p.drift.every((d) => d < -DRIFT_FRAMES)) fix = Math.max(...p.drift);
      }
      if (fix) {
        p.drift = [];
        this.audioCorrections++;
      }
    }
    if (fix > 0) {
      p.stdin.write(Buffer.alloc(fix * 4));
      p.framesWritten += fix;
    } else if (fix < 0) {
      buf = buf.subarray(Math.min(frames, -fix) * 4);
    }
    if (!buf.length) return;
    p.stdin.write(buf);
    p.framesWritten += buf.length / 4;
  }

  buildArgs(session, t0ms) {
    const s = this.getSettings();
    const enc = this.encoder;
    const fps = Math.max(24, Math.min(144, Number(s.fps) || 60));
    const height = { '1440': 1440, '1080': 1080, '720': 720 }[s.resolution];
    const windowed = !!this.windowExe && !this.windowFallback;
    // gfxcapture en modo directo etiqueta el vídeo como RGB y algunos reproductores lo
    // pintarían mal: para la ventana siempre se pasa por la conversión en CPU.
    const zeroCopy = this.zeroCopy && enc.endsWith('_nvenc') && !height && !windowed;

    // gfxcapture (Windows Graphics Capture) graba solo la ventana del juego aunque haya otras
    // encima; ddagrab graba el monitor entero.
    const source = windowed
      ? `gfxcapture=window_exe='${this.windowExe}':max_framerate=${fps}:width=-2:height=-2`
      : `ddagrab=output_idx=${Number(s.monitor) || 0}:framerate=${fps}:draw_mouse=1`;

    // Audio y vídeo comparten la hora real como reloj, en segundos desde t0: setpts pone a
    // cada fotograma la hora (RTCTIME) a la que se capturó, y el audio empieza exactamente en
    // t0 (ver writeAudio). No se usan -copyts/-itsoffset: con marcas de tiempo en hora epoch,
    // el planificador de FFmpeg 7+ cree que el vídeo va muy por delante y lo detiene.
    const args = ['-hide_banner', '-loglevel', FF_DEBUG ? 'info' : 'warning', '-y',
      '-f', 'lavfi', '-thread_queue_size', '512', '-i', source];
    if (this.audioEnabled) {
      args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-thread_queue_size', '4096', '-i', 'pipe:0');
    }

    let vf = `setpts=(RTCTIME-${t0ms * 1000})/(1000000*TB)`;
    if (!zeroCopy) {
      vf += ',hwdownload,format=bgra';
      if (height) vf += `,scale=-2:${height}:flags=bicubic`;
      vf += enc === 'libx264' ? ',format=yuv420p' : ',format=nv12';
    }
    args.push('-vf', vf);

    args.push('-map', '0:v', '-fps_mode', 'passthrough');
    if (this.audioEnabled) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '160k');

    // Calidad constante con tope de bitrate: las escenas tranquilas ocupan mucho menos que
    // con bitrate fijo. Medido en una partida de LoL a 1440p60: alta ~115, equilibrada ~72,
    // ahorro ~45 MB/min (bitrate fijo de 20 Mbps: ~148 MB/min).
    const q = QUALITY[s.quality] || QUALITY.balanced;
    const cap = ['-maxrate', `${q.maxMbps}M`, '-bufsize', `${q.maxMbps * 2}M`];
    if (enc.endsWith('_nvenc')) args.push('-c:v', enc, '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', '0', ...cap, '-forced-idr', '1');
    else if (enc.endsWith('_amf')) args.push('-c:v', enc, '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', `${q.avgMbps}M`, ...cap);
    else if (enc.endsWith('_qsv')) args.push('-c:v', enc, '-preset', 'veryfast', '-global_quality', String(q.cq), ...cap);
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.cq - 2), ...cap);

    // Un keyframe exactamente cada 2 s para que cada segmento empiece limpio.
    args.push('-g', String(fps * SEGMENT_SECONDS), '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);

    args.push('-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'mpegts',
      '-reset_timestamps', '0',
      '-segment_list', path.join(this.bufferDir, `${session}.csv`), '-segment_list_type', 'csv',
      path.join(this.bufferDir, `${session}_%06d.ts`));
    return { args, zeroCopy, windowed };
  }

  spawn() {
    const t0ms = Date.now();
    const session = `s${t0ms.toString(36)}`;
    const { args, zeroCopy, windowed } = this.buildArgs(session, t0ms);
    const p = spawn(FFMPEG, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    p.captureKind = windowed ? 'window' : 'monitor';
    p.audio = this.audioEnabled;
    p.session = session;
    p.startedAt = t0ms;
    p.t0ms = t0ms;
    p.framesWritten = 0;
    p.listOffset = 0;
    p.stdin.on('error', () => {});
    const debugLog = FF_DEBUG ? path.join(this.bufferDir, `${session}.ffmpeg.log`) : null;
    if (debugLog) fs.appendFileSync(debugLog, `${args.join(' ')}\n`);
    p.debugLog = debugLog;
    p.stderr.on('data', (d) => {
      if (debugLog) fs.appendFile(debugLog, d, () => {});
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.lastLog.push(line);
        if (this.lastLog.length > 40) this.lastLog.shift();
      }
    });
    p.on('close', (code) => this.onExit(p, code, zeroCopy));
    p.on('error', (e) => this.lastLog.push(String(e)));
    p.listTimer = setInterval(() => this.readSegmentList(p), 500);
    this.proc = p;
    this.emit('status');
  }

  onExit(p, code, zeroCopy) {
    clearInterval(p.listTimer);
    this.readSegmentList(p);
    if (this.proc !== p) return; // parada intencionada
    this.proc = null;
    const shortLived = Date.now() - p.startedAt < 6000;
    if (p.captureKind === 'window') {
      // La ventana del juego aún no existe (cargando) o se ha cerrado: se graba el monitor
      // mientras tanto y se vuelve a intentar la ventana al rato. Cada reintento corta ~2 s de
      // grabación, así que si sigue sin aparecer se espacian (15 s, 30 s, 1 min, máx. 2 min).
      if (!shortLived) this.windowRetryMs = 15000;
      this.windowFallback = true;
      clearTimeout(this.windowRetry);
      const delay = this.windowRetryMs || 15000;
      this.windowRetryMs = Math.min(delay * 2, 120000);
      this.windowRetry = setTimeout(() => {
        if (!this.windowExe || !this.windowFallback) return;
        this.windowFallback = false;
        if (this.proc) this.restart();
      }, delay);
    } else if (shortLived && zeroCopy) {
      // Algunos equipos (p. ej. portátiles con la pantalla en la iGPU) no aceptan el
      // paso directo D3D11 -> NVENC: se reintenta copiando los fotogramas.
      this.zeroCopy = false;
    } else if (shortLived) {
      this.failures++;
    } else {
      this.failures = 0;
    }
    this.emit('status');
    if (!this.wanted) return;
    if (this.failures >= 4) {
      this.wanted = false;
      this.emit('error', new Error(`FFmpeg se ha detenido (código ${code}).\n${this.lastLog.slice(-8).join('\n')}`));
      return;
    }
    setTimeout(() => { if (this.wanted && !this.proc) this.spawn(); }, 1500);
  }

  readSegmentList(p) {
    const file = path.join(this.bufferDir, `${p.session}.csv`);
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= p.listOffset) { fs.closeSync(fd); return; }
      const buf = Buffer.alloc(size - p.listOffset);
      fs.readSync(fd, buf, 0, buf.length, p.listOffset);
      fs.closeSync(fd);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return;
      text = buf.subarray(0, lastNl + 1).toString('utf8');
      p.listOffset += lastNl + 1;
    } catch { return; }

    for (const line of text.split(/\r?\n/)) {
      const [name, start, end] = line.split(',');
      if (!name || end === undefined) continue;
      // Los tiempos del stream son segundos desde t0 (hora real), ver buildArgs.
      this.segments.push({
        file: path.join(this.bufferDir, name),
        wallStart: p.t0ms + parseFloat(start) * 1000,
        wallEnd: p.t0ms + parseFloat(end) * 1000,
      });
    }
    this.emit('segments');
  }

  pin(id, fromWall) { this.pins.set(id, fromWall); }
  unpin(id) { this.pins.delete(id); }

  cleanup() {
    const s = this.getSettings();
    const now = Date.now();
    let keepFrom = now - (Number(s.bufferSeconds) || 120) * 1000 - 5000;
    for (const from of this.pins.values()) keepFrom = Math.min(keepFrom, Math.max(from, now - MAX_PIN_MS));
    const keep = [];
    for (const seg of this.segments) {
      if (seg.wallEnd < keepFrom) fs.rm(seg.file, { force: true }, () => {});
      else keep.push(seg);
    }
    this.segments = keep;
  }

  bufferedSeconds() {
    if (!this.segments.length) return 0;
    return (this.segments[this.segments.length - 1].wallEnd - this.segments[0].wallStart) / 1000;
  }

  bufferBytes() {
    let total = 0;
    for (const seg of this.segments) {
      try { total += fs.statSync(seg.file).size; } catch { /* ya borrado */ }
    }
    return total;
  }

  /** Guarda en `outFile` (mp4) lo grabado entre fromWall y toWall (ms epoch). */
  async saveRange(fromWall, toWall, outFile) {
    const pinId = `save-${Math.random()}`;
    this.pin(pinId, fromWall - 3000);
    try {
      // Esperar a que FFmpeg cierre el segmento que contiene toWall.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const last = this.segments[this.segments.length - 1];
        if (last && last.wallEnd >= toWall - 500) break;
        if (!this.proc) break;
        await sleep(250);
      }
      const segs = this.segments.filter((s) => s.wallEnd > fromWall && s.wallStart < toWall);
      if (!segs.length) throw new Error('No hay grabación en el buffer para ese momento');

      const tmp = `${outFile}.part.ts`;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        out.on('error', reject);
        let i = 0;
        const next = () => {
          if (i >= segs.length) { out.end(resolve); return; }
          const rs = fs.createReadStream(segs[i++].file);
          rs.on('error', next); // un segmento que falte no debe romper el clip entero
          rs.on('end', next);
          rs.pipe(out, { end: false });
        };
        next();
      });

      const tag = this.encoder.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [];
      try {
        await run(['-y', '-fflags', '+genpts', '-i', tmp, '-map', '0', '-c', 'copy', ...tag,
          '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outFile]);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      const duration = (segs[segs.length - 1].wallEnd - segs[0].wallStart) / 1000;
      return { duration, wallStart: segs[0].wallStart };
    } finally {
      this.unpin(pinId);
    }
  }

  dispose() {
    clearInterval(this.cleanupTimer);
    clearTimeout(this.windowRetry);
    this.stop();
  }
}

module.exports = { Recorder };
