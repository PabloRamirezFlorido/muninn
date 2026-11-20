const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROCESSES = {
  lol: ['league of legends.exe'],
  valorant: ['valorant-win64-shipping.exe'],
};

// Ayudante nativo (native/procwatch.cs) que vigila procesos con ~2 ms de CPU por comprobación;
// tasklist gasta ~270 ms por llamada. Empaquetado va a resources/procwatch (extraResources).
const PROCWATCH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, 'procwatch', 'procwatch.exe')
  : path.join(__dirname, '..', 'vendor', 'procwatch', 'procwatch.exe');

// Las APIs locales de Riot usan un certificado autofirmado; solo se habla con 127.0.0.1.
const localAgent = new https.Agent({ rejectUnauthorized: false });

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: localAgent, headers, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Avisa de qué juego conocido está abierto (evento 'change'). Hay que llamar a start(). */
class ProcessWatcher extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.current = null;
    this.helper = null;
    this.timer = null;
  }

  customExes() {
    return (this.getSettings().customProcesses || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  start() {
    if (this.helper || this.timer) return;
    try {
      const h = spawn(PROCWATCH, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let pending = '';
      h.stdout.on('data', (d) => {
        pending += d;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('running')) this.update(new Set(line.slice(8).split(',').filter(Boolean)));
        }
      });
      h.stdin.on('error', () => {});
      h.on('error', () => this.fallback());
      h.on('exit', () => { if (this.helper === h) this.fallback(); });
      this.helper = h;
      this.poll();
    } catch {
      this.fallback();
    }
  }

  // Si el ayudante no está o se cae, se vuelve a tasklist (más caro, pero siempre disponible).
  fallback() {
    this.helper = null;
    if (this.disposed || this.timer) return;
    this.timer = setInterval(() => this.pollTasklist(), 4000);
    this.pollTasklist();
  }

  /** Vuelve a comprobar (p. ej. tras cambiar la lista de juegos personalizados). */
  poll() {
    if (this.helper) {
      const exes = [...Object.values(PROCESSES).flat(), ...this.customExes()];
      this.helper.stdin.write(`watch ${exes.join(',')}\n`);
    } else if (this.timer) {
      this.pollTasklist();
    }
  }

  pollTasklist() {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return;
      this.update(new Set(out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '').toLowerCase())));
    });
  }

  update(running) {
    let found = null;
    for (const [game, exes] of Object.entries(PROCESSES)) {
      if (exes.some((e) => running.has(e))) { found = game; break; }
    }
    if (!found) {
      const hit = this.customExes().find((e) => running.has(e));
      if (hit) found = `custom:${hit}`;
    }
    if (found !== this.current) {
      const prev = this.current;
      this.current = found;
      this.emit('change', found, prev);
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    if (this.helper) {
      const h = this.helper;
      this.helper = null;
      h.stdin.end(); // procwatch termina solo al cerrarse su stdin
    }
  }
}

const norm = (s) => String(s || '').split('#')[0].trim().toLowerCase();

const STATS_EVERY_POLLS = 5; // las estadísticas se refrescan cada ~5 s

/**
 * League of Legends: Live Client Data API (https://127.0.0.1:2999), disponible solo durante
 * la partida. Emite matchStart / event / matchEnd. Cada 'event' es un momento tuyo (kill,
 * muerte, objetivo…): con clip=true según tus ajustes se guarda como clip; si no, solo se
 * marca en la barra de la partida completa.
 */
class LolClient extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.inMatch = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.failures = 0;
    this.timer = setInterval(() => this.poll().catch(() => {}), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.inMatch) this.endMatch(null);
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      let data;
      try {
        data = await getJson('https://127.0.0.1:2999/liveclientdata/eventdata');
        this.failures = 0;
      } catch {
        // Tras la pantalla de fin de partida la API desaparece.
        if (this.inMatch && ++this.failures > 8) this.endMatch(null);
        return;
      }
      const events = data.Events || [];
      if (!this.inMatch) {
        // Tras la victoria/derrota la API sigue respondiendo unos segundos (pantalla final):
        // no es una partida nueva. Hasta que desaparezca, sus eventos incluyen GameEnd.
        if (events.some((e) => e.EventName === 'GameEnd')) return;
        const me = await getJson('https://127.0.0.1:2999/liveclientdata/activeplayername');
        const players = await getJson('https://127.0.0.1:2999/liveclientdata/playerlist').catch(() => []);
        this.me = norm(me);
        const mine = players.find((p) => norm(p.riotId || p.riotIdGameName || p.summonerName) === this.me);
        this.champion = mine ? mine.championName : '';
        // Si la app se abre a mitad de partida, no se recortan eventos que ya no están en el buffer.
        this.lastId = events.length ? Math.max(...events.map((e) => e.EventID)) : -1;
        this.inMatch = true;
        this.stats = null;
        this.polls = 0;
        this.emit('matchStart', { champion: this.champion });
        return;
      }
      for (const ev of events) {
        if (ev.EventID <= this.lastId) continue;
        this.lastId = ev.EventID;
        this.handle(ev);
      }
      if (this.inMatch && ++this.polls % STATS_EVERY_POLLS === 1) await this.refreshStats();
    } finally {
      this.busy = false;
    }
  }

  /** Guarda tus estadísticas actuales: al acabar la partida la API desaparece enseguida. */
  async refreshStats() {
    try {
      const all = await getJson('https://127.0.0.1:2999/liveclientdata/allgamedata');
      const mine = (all.allPlayers || []).find((p) => norm(p.riotId || p.riotIdGameName || p.summonerName) === this.me);
      if (!mine) return;
      const sc = mine.scores || {};
      this.stats = {
        champion: mine.championName || this.champion,
        kills: sc.kills ?? 0,
        deaths: sc.deaths ?? 0,
        assists: sc.assists ?? 0,
        cs: sc.creepScore ?? 0,
        vision: Math.round(sc.wardScore ?? 0),
        level: mine.level ?? (all.activePlayer && all.activePlayer.level) ?? null,
        gameTime: Math.round((all.gameData && all.gameData.gameTime) || 0),
      };
    } catch { /* se reintenta en el siguiente ciclo */ }
  }

  handle(ev) {
    const cfg = this.getSettings().lol;
    const me = this.me;
    const isMe = (n) => norm(n) === me;
    const emit = (type, label, priority, clip, extra = {}) => this.emit('event', {
      type, label, priority, clip: !!clip, wall: Date.now(), pre: cfg.preSeconds, post: cfg.postSeconds, ...extra,
    });
    const objectives = { DragonKill: 'Dragón', BaronKill: 'Barón', HeraldKill: 'Heraldo', HordeKill: 'Larvas', AtakhanKill: 'Atakhan' };

    switch (ev.EventName) {
      case 'ChampionKill':
        if (isMe(ev.KillerName)) emit('kill', 'Kill', 1, cfg.kill);
        else if (isMe(ev.VictimName)) emit('death', 'Muerte', 0, cfg.deaths);
        else if ((ev.Assisters || []).some(isMe)) emit('assist', 'Asistencia', 0, cfg.assists);
        break;
      case 'Multikill':
        if (isMe(ev.KillerName)) {
          const names = { 2: 'Doble kill', 3: 'Triple kill', 4: 'Cuádruple kill', 5: 'Pentakill' };
          emit('multikill', names[ev.KillStreak] || `${ev.KillStreak} kills`, 2 + ev.KillStreak, ev.KillStreak >= cfg.multikillMin);
        }
        break;
      case 'Ace':
        if (isMe(ev.Acer)) emit('ace', 'Ace', 6, cfg.ace);
        break;
      case 'FirstBlood':
        if (isMe(ev.Recipient)) emit('firstblood', 'Primera sangre', 3, cfg.firstBlood);
        break;
      case 'TurretKilled':
      case 'InhibKilled':
        if (isMe(ev.KillerName)) emit('structure', ev.EventName === 'TurretKilled' ? 'Torre' : 'Inhibidor', 1, cfg.turrets);
        break;
      case 'GameEnd': {
        const result = ev.Result === 'Win' ? 'win' : ev.Result === 'Lose' ? 'loss' : null;
        if (result) emit(result === 'win' ? 'victory' : 'defeat', result === 'win' ? 'Victoria' : 'Derrota', 4, result === 'win' && cfg.victory, { pre: 10, post: 3 });
        this.endMatch(result);
        break;
      }
      default:
        if (objectives[ev.EventName] && isMe(ev.KillerName)) {
          if (ev.Stolen === 'True') emit('steal', `Robo de ${objectives[ev.EventName]}`, 7, cfg.steals);
          else emit('objective', objectives[ev.EventName], 2, cfg.objectives);
        }
    }
  }

  endMatch(result) {
    if (!this.inMatch) return;
    this.inMatch = false;
    this.emit('matchEnd', { result, champion: this.champion, stats: this.stats });
  }
}

function findKey(obj, re, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v !== 'object' || v === null)) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findKey(v, re, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * Valorant no tiene API de eventos de combate. Se usa la presencia del cliente local de Riot
 * (lockfile + /chat/v4/presences) para saber si se está en partida y el marcador, y así
 * detectar inicio/fin de partida y rondas ganadas/perdidas.
 */
class ValorantClient extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.inMatch = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.inMatch) this.endMatch();
  }

  auth() {
    const lockfile = path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile');
    const [, , port, password, protocol] = fs.readFileSync(lockfile, 'utf8').split(':');
    return {
      base: `${protocol || 'https'}://127.0.0.1:${port}`,
      headers: { Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}` },
    };
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { base, headers } = this.auth();
      if (!this.puuid) this.puuid = (await getJson(`${base}/chat/v1/session`, headers)).puuid;
      const { presences = [] } = await getJson(`${base}/chat/v4/presences`, headers);
      const mine = presences.find((p) => p.puuid === this.puuid && p.product === 'valorant');
      if (!mine || !mine.private) return;
      const state = JSON.parse(Buffer.from(mine.private, 'base64').toString('utf8'));
      const loop = String(findKey(state, /^sessionLoopState$/i) || '').toUpperCase();
      const ally = Number(findKey(state, /MatchScoreAllyTeam$/i)) || 0;
      const enemy = Number(findKey(state, /MatchScoreEnemyTeam$/i)) || 0;

      if (loop === 'INGAME' && !this.inMatch) {
        this.inMatch = true;
        this.ally = ally;
        this.enemy = enemy;
        this.emit('matchStart', {});
        return;
      }
      if (this.inMatch && loop && loop !== 'INGAME') {
        this.endMatch();
        return;
      }
      if (!this.inMatch) return;

      const cfg = this.getSettings().valorant;
      const emit = (type, label, priority, clip) => this.emit('event', {
        type, label, priority, clip: !!clip, wall: Date.now(), pre: cfg.preSeconds, post: cfg.postSeconds,
      });
      if (ally > this.ally) emit('round_win', `Ronda ganada ${ally}-${enemy}`, 3, cfg.roundWin);
      if (enemy > this.enemy) emit('round_loss', `Ronda perdida ${ally}-${enemy}`, 1, cfg.roundLoss);
      this.ally = ally;
      this.enemy = enemy;
    } catch {
      // Cliente de Riot cerrado o reiniciándose: se reintenta en el siguiente ciclo.
      this.puuid = null;
    } finally {
      this.busy = false;
    }
  }

  endMatch() {
    if (!this.inMatch) return;
    this.inMatch = false;
    const result = this.ally > this.enemy ? 'win' : this.ally < this.enemy ? 'loss' : null;
    this.emit('matchEnd', { result, score: `${this.ally}-${this.enemy}`, stats: { score: `${this.ally}-${this.enemy}` } });
  }
}

module.exports = { ProcessWatcher, LolClient, ValorantClient };
