const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { run } = require('./ffmpeg');

const GAME_NAMES = { lol: 'League of Legends', valorant: 'Valorant', desktop: 'Escritorio' };

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'clip';
}

/**
 * Biblioteca de clips y partidas guardados. Los metadatos van en library.json dentro de la
 * propia carpeta, así que mover la carpeta de vídeos conserva favoritos y títulos.
 */
class Library extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.load();
  }

  get root() { return this.getSettings().libraryDir; }
  get file() { return path.join(this.root, 'library.json'); }

  load() {
    for (const d of ['clips', 'partidas', 'thumbs']) fs.mkdirSync(path.join(this.root, d), { recursive: true });
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    // Si el usuario borró vídeos a mano desde el explorador, se quitan de la lista.
    this.items = this.items.filter((it) => fs.existsSync(it.file));
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('changed');
  }

  list() { return [...this.items].sort((a, b) => b.createdAt - a.createdAt); }

  get(id) { return this.items.find((it) => it.id === id); }

  /** Devuelve la ruta donde el grabador debe escribir el nuevo vídeo. */
  newPath(type, game, title) {
    const dir = path.join(this.root, type === 'match' ? 'partidas' : 'clips');
    return path.join(dir, `${stamp()}_${safeName(GAME_NAMES[game] || game)}_${safeName(title)}.mp4`);
  }

  async add({ type, game, title, events = [], file, duration, recordedAt, stats = null }) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const thumb = path.join(this.root, 'thumbs', `${id}.jpg`);
    try {
      const at = Math.max(0, Math.min(duration - 1, duration * 0.6));
      await run(['-y', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb]);
    } catch { /* sin miniatura no pasa nada */ }
    const item = {
      id, type, game, title, events, file,
      thumb: fs.existsSync(thumb) ? thumb : null,
      duration, size: fs.statSync(file).size,
      createdAt: recordedAt || Date.now(),
      favorite: false,
      ...(stats ? { stats } : {}),
    };
    this.items.push(item);
    this.save();
    this.enforceQuota();
    return item;
  }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return null;
    if (typeof patch.title === 'string') it.title = patch.title.trim() || it.title;
    if (typeof patch.favorite === 'boolean') it.favorite = patch.favorite;
    this.save();
    return it;
  }

  /** Nota propia en un instante del vídeo (at = hora real en ms, como los demás momentos). */
  addNote(id, at, text) {
    const it = this.get(id);
    const clean = String(text || '').trim().slice(0, 200);
    if (!it || !clean || !Number.isFinite(at)) return it;
    it.events = [...(it.events || []), { type: 'note', label: clean, at: Math.round(at) }]
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    this.save();
    return it;
  }

  removeNote(id, at) {
    const it = this.get(id);
    if (!it) return it;
    it.events = (it.events || []).filter((e) => !(e.type === 'note' && e.at === at));
    this.save();
    return it;
  }

  /**
   * Recodifica un vídeo para que pese menos de `limitMB` (límite de subida de Discord) y
   * devuelve la ruta. Se baja la resolución si el bitrate disponible no da para más.
   */
  async exportForDiscord(id, limitMB, encoder) {
    const it = this.get(id);
    if (!it) throw new Error('Vídeo no encontrado');
    const limit = limitMB * 1024 * 1024;
    const audioKbps = 96;
    const dir = path.join(this.root, 'discord');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${path.basename(it.file, '.mp4')}_discord.mp4`);
    // Margen del 8 % para la cabecera del mp4 y la variación del encoder.
    let videoKbps = Math.floor((limit * 0.92 * 8) / it.duration / 1000) - audioKbps;
    if (videoKbps < 250) {
      const maxSec = Math.floor((limit * 0.92 * 8) / ((250 + audioKbps) * 1000));
      throw new Error(`Demasiado largo para ${limitMB} MB: recórtalo a menos de ${maxSec} s`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const height = videoKbps >= 5000 ? 1080 : videoKbps >= 2200 ? 720 : 540;
      const venc = encoder.endsWith('_nvenc')
        ? [encoder, '-preset', 'p5', '-rc', 'cbr', '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`]
        : ['libx264', '-preset', 'medium', '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`];
      await run(['-y', '-i', it.file, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=-2:'min(${height},ih)'`,
        '-c:v', ...venc, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', out]);
      const size = fs.statSync(out).size;
      if (size <= limit) return { file: out, size };
      videoKbps = Math.floor(videoKbps * (limit / size) * 0.9); // se pasó: se ajusta y se repite
    }
    throw new Error('No se pudo dejar por debajo del límite');
  }

  remove(id) {
    const it = this.get(id);
    if (!it) return;
    fs.rmSync(it.file, { force: true });
    if (it.thumb) fs.rmSync(it.thumb, { force: true });
    this.items = this.items.filter((x) => x !== it);
    this.save();
  }

  /** Crea un clip nuevo a partir de un tramo [start, end] (segundos) de otro vídeo. */
  async trim(id, start, end, encoder) {
    const it = this.get(id);
    if (!it) throw new Error('Vídeo no encontrado');
    const fromWall = it.createdAt + start * 1000;
    const toWall = it.createdAt + end * 1000;
    const events = (it.events || []).filter((e) => !e.at || (e.at >= fromWall && e.at <= toWall));
    let title = `${it.title} (recorte)`;
    // El título sale de los momentos buenos: muertes, asistencias y notas no lo nombran.
    const timed = events.filter((e) => e.at && !['note', 'death', 'assist', 'defeat', 'round_loss'].includes(e.type));
    if (it.type === 'match' && timed.length) {
      // "Victoria · Caitlyn" -> "Pentakill · Caitlyn" según los momentos del tramo.
      const labels = [...new Set(timed.map((e) => e.label))].slice(0, 3).join(' + ');
      const rest = it.title.split(' · ').slice(1).join(' · ');
      title = rest ? `${labels} · ${rest}` : labels;
    }
    const out = this.newPath('clip', it.game, title);
    const venc = encoder.endsWith('_nvenc') ? [encoder, '-preset', 'p5', '-cq', '21']
      : encoder === 'libx264' ? ['libx264', '-preset', 'fast', '-crf', '20'] : [encoder, '-b:v', '20M'];
    // Se recodifica para que el corte sea exacto (con copia solo se puede cortar en keyframes).
    await run(['-y', '-ss', start.toFixed(3), '-i', it.file, '-t', (end - start).toFixed(3),
      '-map', '0', '-c:v', ...venc, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    return this.add({ type: 'clip', game: it.game, title, events, file: out, duration: end - start, recordedAt: fromWall });
  }

  usage() {
    let clips = 0; let matches = 0; let favorites = 0;
    for (const it of this.items) {
      if (it.favorite) favorites += it.size;
      if (it.type === 'match') matches += it.size; else clips += it.size;
    }
    return { clips, matches, favorites, total: clips + matches, quota: this.getSettings().storageQuotaGB * 1024 ** 3 };
  }

  /**
   * Si se supera la cuota, borra primero las partidas completas más antiguas y después los
   * clips más antiguos. Los favoritos no se borran nunca (aunque sí cuentan para la cuota).
   */
  enforceQuota() {
    const quota = this.getSettings().storageQuotaGB * 1024 ** 3;
    let total = this.usage().total;
    if (total <= quota) return [];
    const byAge = (a, b) => a.createdAt - b.createdAt;
    const candidates = [
      ...this.items.filter((i) => !i.favorite && i.type === 'match').sort(byAge),
      ...this.items.filter((i) => !i.favorite && i.type !== 'match').sort(byAge),
    ];
    const removed = [];
    for (const it of candidates) {
      if (total <= quota) break;
      total -= it.size;
      fs.rmSync(it.file, { force: true });
      if (it.thumb) fs.rmSync(it.thumb, { force: true });
      removed.push(it);
    }
    if (removed.length) {
      this.items = this.items.filter((i) => !removed.includes(i));
      this.save();
      this.emit('pruned', removed);
    }
    return removed;
  }
}

module.exports = { Library, GAME_NAMES };
