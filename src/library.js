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

  async add({ type, game, title, events = [], file, duration, recordedAt }) {
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
    const timed = events.filter((e) => e.at);
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
