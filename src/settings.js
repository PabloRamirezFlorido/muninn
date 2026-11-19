const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  libraryDir: '',              // se rellena con Vídeos\Muninn al cargar
  recordMode: 'game',          // 'game' = solo con un juego abierto, 'always' = siempre
  captureMode: 'game',         // 'game' = solo la ventana del juego, 'monitor' = pantalla entera
  monitor: 0,
  fps: 60,
  resolution: 'native',        // 'native' | '1440' | '1080' | '720'
  quality: 'balanced',         // 'high' | 'balanced' | 'saver' (calidad constante con tope)
  encoder: 'auto',             // 'auto' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264'
  bufferSeconds: 120,          // cuánto se guarda en el buffer circular fuera de partida
  clipSeconds: 30,             // duración del clip manual (tecla rápida)
  hotkeyClip: 'F8',
  audio: {
    system: true,
    // La captura loopback ignora el volumen de Windows: a 1 los clips suenan demasiado fuertes.
    systemVolume: 0.5,
    mic: false,
    micDeviceId: '',
    micVolume: 1,
  },
  storageQuotaGB: 100,
  saveFullMatches: true,
  maxClipSeconds: 90,          // los eventos encadenados se unen en un clip hasta esta duración
  notify: true,
  startMinimized: false,
  launchAtStartup: false,
  customProcesses: [],         // ejecutables extra que activan la grabación (p. ej. "cs2.exe")
  discordLimitMB: 10,          // límite de subida de Discord sin Nitro
  lol: {
    enabled: true,
    kill: true,
    multikillMin: 2,
    ace: true,
    firstBlood: true,
    steals: true,
    objectives: false,
    turrets: false,
    assists: false,
    deaths: false,
    victory: true,
    preSeconds: 15,
    postSeconds: 5,
  },
  valorant: {
    enabled: true,
    roundWin: true,
    roundLoss: false,
    preSeconds: 25,
    postSeconds: 4,
  },
};

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.listeners = [];
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')); } catch { /* primera ejecución */ }
    this.data = merge(DEFAULTS, saved);
    // v1.0.0 guardaba el audio del sistema al 100 %, que suena demasiado alto.
    if (!saved.audioRev) {
      if (saved.audio && saved.audio.systemVolume === 1) this.data.audio.systemVolume = DEFAULTS.audio.systemVolume;
      this.data.audioRev = 1;
    }
    if (!this.data.libraryDir) this.data.libraryDir = path.join(app.getPath('videos'), 'Muninn');
  }

  get() { return this.data; }

  update(patch) {
    const prev = this.data;
    this.data = merge(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    for (const fn of this.listeners) fn(this.data, prev);
    return this.data;
  }

  onChange(fn) { this.listeners.push(fn); }
}

module.exports = { Settings, DEFAULTS };
