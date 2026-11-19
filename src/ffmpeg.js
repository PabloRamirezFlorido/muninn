const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// FFmpeg 8 (BtbN, win64-gpl) en vendor/ffmpeg: hace falta >= 8.0 por el filtro gfxcapture
// (captura de una ventana concreta). Empaquetado va a resources/ffmpeg (extraResources).
const FFMPEG = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  : path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');

function run(args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    let timer;
    if (timeoutMs) timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg salió con código ${code}`));
    });
  });
}

// Comprueba qué encoders por hardware funcionan de verdad en este equipo
// (que estén compilados en ffmpeg no significa que haya GPU compatible).
async function detectEncoders() {
  const candidates = ['h264_nvenc', 'hevc_nvenc', 'h264_amf', 'h264_qsv'];
  const ok = [];
  for (const enc of candidates) {
    try {
      await run(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=30', '-frames:v', '5',
        '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 8000 });
      ok.push(enc);
    } catch { /* no disponible */ }
  }
  ok.push('libx264');
  return ok;
}

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Como detectEncoders, pero recuerda el resultado en `cacheFile`: probar los 4 encoders lanza
 * FFmpeg 4 veces y se nota al arrancar con Windows. Se repite si cambia ffmpeg.exe, si el
 * resultado tiene más de 30 días o si se borra la caché (ver forgetEncoders).
 */
async function cachedEncoders(cacheFile) {
  let key = '';
  try {
    const st = fs.statSync(FFMPEG);
    key = `${st.size}-${st.mtimeMs}`;
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.key === key && Date.now() - cache.at < CACHE_MAX_AGE_MS && cache.list?.length) return cache.list;
  } catch { /* sin caché */ }
  const list = await detectEncoders();
  try { fs.writeFileSync(cacheFile, JSON.stringify({ key, at: Date.now(), list })); } catch { /* sin caché */ }
  return list;
}

function forgetEncoders(cacheFile) {
  fs.rmSync(cacheFile, { force: true });
}

/** Duración, resolución y si tiene audio (leído de la cabecera que imprime ffmpeg -i). */
function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => {
      const dur = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const vid = err.match(/Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!dur || !vid) return reject(new Error(`No se pudo leer el vídeo: ${path.basename(file)}`));
      resolve({
        duration: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
        width: Number(vid[1]),
        height: Number(vid[2]),
        hasAudio: /Stream #\d+:\d+.*Audio:/.test(err),
      });
    });
  });
}

/** Parámetros de vídeo para las ediciones (montaje, cámara lenta): calidad alta, no tamaño. */
function editVideoArgs(encoder) {
  if (encoder.endsWith('_nvenc')) return ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', '40M', '-bufsize', '80M'];
  if (encoder === 'libx264') return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];
  return ['-c:v', encoder, '-b:v', '16M'];
}

module.exports = { FFMPEG, run, detectEncoders, cachedEncoders, forgetEncoders, probe, editVideoArgs };
