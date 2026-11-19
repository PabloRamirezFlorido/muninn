const { EventEmitter } = require('events');

const GAP_MS = 3000; // eventos separados por menos de esto acaban en el mismo clip

/**
 * Decide qué se guarda: une eventos cercanos en un único clip (p. ej. kill + kill + doble kill),
 * guarda la partida completa al terminar y atiende los clips manuales.
 */
class Director extends EventEmitter {
  constructor({ recorder, library, getSettings }) {
    super();
    this.recorder = recorder;
    this.library = library;
    this.getSettings = getSettings;
    this.pending = null;
    this.match = null;
    this.saving = new Set();
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
    if (!this.getSettings().saveFullMatches) { this.recorder.unpin('match'); return; }

    const label = info.result === 'win' ? 'Victoria' : info.result === 'loss' ? 'Derrota' : 'Partida';
    const extra = [m.info.champion || info.champion, info.score].filter(Boolean).join(' · ');
    const title = extra ? `${label} · ${extra}` : label;
    const out = this.library.newPath('match', game, title);
    const job = this.recorder.saveRange(m.startedAt, Date.now(), out)
      .then(({ duration, wallStart }) => this.library.add({
        type: 'match', game, title, file: out, duration, recordedAt: wallStart,
        events: m.events || [],
      }))
      .then((item) => this.emit('saved', item))
      .catch((e) => this.emit('failed', e))
      .finally(() => this.recorder.unpin('match'));
    this.track(job);
  }

  highlight(game, ev) {
    const s = this.getSettings();
    const start = ev.wall - ev.pre * 1000;
    const end = ev.wall + ev.post * 1000;
    if (this.match) (this.match.events ||= []).push({ type: ev.type, label: ev.label, at: ev.wall });
    this.emit('event', { game, ...ev });

    const p = this.pending;
    if (p && p.game === game && start <= p.end + GAP_MS && Math.max(end, p.end) - p.start <= s.maxClipSeconds * 1000) {
      p.end = Math.max(p.end, end);
      p.events.push(ev);
      this.schedule(p);
      return;
    }
    if (p) this.flush();
    const id = `hl-${Date.now()}`;
    this.pending = { id, game, start, end, events: [ev] };
    this.recorder.pin(id, start);
    this.schedule(this.pending);
  }

  schedule(p) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.flush(), Math.max(0, p.end - Date.now()));
  }

  flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
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
      .then(({ duration, wallStart }) => this.library.add({ type: 'clip', game, title, events, file: out, duration, recordedAt: wallStart }))
      .then((item) => this.emit('saved', item))
      .catch((e) => this.emit('failed', e))
      .finally(() => { if (pinId) this.recorder.unpin(pinId); });
    return this.track(job);
  }
}

module.exports = { Director };
