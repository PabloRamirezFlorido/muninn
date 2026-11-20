const { EventEmitter } = require('events');

const GAP_MS = 3000; // eventos separados por menos de esto acaban en el mismo clip
// Tras cada momento se espera esto antes de cerrar el clip, por si llega otro: LoL da un doble
// kill si la siguiente kill llega en ~10 s. Sin esta espera, la segunda kill abría un clip nuevo
// que volvía a incluir la primera (metraje duplicado).
const CHAIN_MS = 12000;
const MIN_MATCH_MS = 60000; // partidas más cortas no se guardan (falsos inicios)

/**
 * Decide qué se guarda: une eventos cercanos en un único clip (p. ej. kill + kill + doble kill),
 * guarda la partida completa al terminar y atiende los clips manuales.
 */
class Director extends EventEmitter {
  constructor({ recorder, library, getSettings, chainMs = CHAIN_MS, gapMs = GAP_MS }) {
    super();
    this.recorder = recorder;
    this.library = library;
    this.getSettings = getSettings;
    this.chainMs = chainMs;
    this.gapMs = gapMs;
    this.pending = null;
    this.match = null;
    this.saving = new Set();
    this.lastClipEnd = {}; // por juego: hora real en que terminó el último clip automático
  }

  get busy() { return !!this.pending || this.saving.size > 0; }

  track(promise) {
    this.saving.add(promise);
    promise.finally(() => { this.saving.delete(promise); this.emit('idle-check'); });
    return promise;
  }

  async whenIdle() {
    while (this.pending || this.saving.size) {
      if (this.pending) this.flush();
      await Promise.allSettled([...this.saving]);
    }
  }

  matchStart(game, info = {}) {
    if (this.match) return;
    this.match = { game, startedAt: Date.now(), info };
    this.recorder.pin('match', this.match.startedAt - 5000);
    this.emit('match', this.match);
  }

  matchEnd(game, info = {}) {
    const m = this.match;
    if (!m) return;
    this.match = null;
    this.emit('match', null);
    if (this.pending) this.flush();
    // Seguro: ninguna partida real dura menos de un minuto; algo así es un falso inicio.
    if (Date.now() - m.startedAt < MIN_MATCH_MS) { this.recorder.unpin('match'); this.emit('discarded', m); return; }
    if (!this.getSettings().saveFullMatches) { this.recorder.unpin('match'); return; }

    const label = info.result === 'win' ? 'Victoria' : info.result === 'loss' ? 'Derrota' : 'Partida';
    const extra = [m.info.champion || info.champion, info.score].filter(Boolean).join(' · ');
    const title = extra ? `${label} · ${extra}` : label;
    const out = this.library.newPath('match', game, title);
    const job = this.recorder.saveRange(m.startedAt, Date.now(), out)
      .then(({ duration, wallStart }) => this.library.add({
        type: 'match', game, title, file: out, duration, recordedAt: wallStart,
        events: m.events || [], stats: info.stats || null,
      }))
      .then((item) => this.emit('saved', item))
      .catch((e) => this.emit('failed', e))
      .finally(() => this.recorder.unpin('match'));
    this.track(job);
  }

  /** Momento que no genera clip: solo queda marcado en la barra de la partida completa. */
  mark(game, ev) {
    if (this.match) (this.match.events ||= []).push({ type: ev.type, label: ev.label, at: ev.wall });
    this.emit('event', { game, ...ev });
  }

  highlight(game, ev) {
    const s = this.getSettings();
    const start = ev.wall - ev.pre * 1000;
    const end = ev.wall + ev.post * 1000;
    this.mark(game, ev);

    const p = this.pending;
    if (p && p.game === game && start <= p.end + this.gapMs && Math.max(end, p.end) - p.start <= s.maxClipSeconds * 1000) {
      p.end = Math.max(p.end, end);
      p.lastWall = Math.max(p.lastWall, ev.wall);
      p.events.push(ev);
      this.schedule(p);
      return;
    }
    if (p) this.flush();
    // Nunca empieza antes de donde acabó el clip anterior: así dos clips seguidos no repiten
    // metraje aunque sus momentos estén cerca.
    const clipStart = Math.min(ev.wall, Math.max(start, this.lastClipEnd[game] || 0));
    const id = `hl-${Date.now()}`;
    this.pending = { id, game, start: clipStart, end, lastWall: ev.wall, events: [ev] };
    this.recorder.pin(id, clipStart);
    this.schedule(this.pending);
  }

  schedule(p) {
    clearTimeout(p.timer);
    // Se cierra al final del clip o al acabar la espera de encadenado, lo que llegue después.
    const at = Math.max(p.end, p.lastWall + this.chainMs);
    p.timer = setTimeout(() => this.flush(), Math.max(0, at - Date.now()));
  }

  flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    this.lastClipEnd[p.game] = Math.max(this.lastClipEnd[p.game] || 0, p.end);
    const best = [...p.events].sort((a, b) => b.priority - a.priority)[0];
    const kills = p.events.filter((e) => e.type === 'kill').length;
    let title = best.label;
    if (best.type === 'kill' && kills > 1) title = `${kills} kills`;
    const champ = this.match && this.match.info.champion;
    if (champ) title += ` · ${champ}`;
    const events = p.events.map((e) => ({ type: e.type, label: e.label, at: e.wall }));
    this.saveClip(p.game, title, p.start, p.end, events, p.id);
  }

  manualClip(game) {
    const now = Date.now();
    const secs = Number(this.getSettings().clipSeconds) || 30;
    // La pulsación también queda marcada en la barra de la partida completa.
    if (this.match) (this.match.events ||= []).push({ type: 'manual', label: 'Marcado a mano', at: now });
    this.saveClip(game || 'desktop', 'Clip manual', now - secs * 1000, now, [{ type: 'manual', label: 'Manual', at: now }]);
  }

  saveClip(game, title, start, end, events, pinId) {
    const out = this.library.newPath('clip', game, title);
    const job = this.recorder.saveRange(start, end, out)
      .then(({ duration, wallStart }) => {
        // También se marcan en el clip los demás momentos de la partida que caen dentro de su
        // tramo (p. ej. la muerte justo después de un doble kill).
        const seen = new Set(events.map((e) => `${e.type}@${e.at}`));
        const others = ((this.match && this.match.events) || [])
          .filter((e) => e.at >= wallStart && e.at <= wallStart + duration * 1000 && !seen.has(`${e.type}@${e.at}`));
        const all = [...events, ...others].sort((a, b) => (a.at || 0) - (b.at || 0));
        return this.library.add({ type: 'clip', game, title, events: all, file: out, duration, recordedAt: wallStart });
      })
      .then((item) => this.emit('saved', item))
      .catch((e) => this.emit('failed', e))
      .finally(() => { if (pinId) this.recorder.unpin(pinId); });
    return this.track(job);
  }
}

module.exports = { Director };
