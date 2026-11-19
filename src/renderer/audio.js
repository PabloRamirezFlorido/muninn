// Captura audio del sistema (loopback) + micrófono, lo mezcla y lo manda al proceso
// principal como PCM s16le estéreo a 48 kHz, que se escribe en el stdin de FFmpeg.

const SAMPLE_RATE = 48000;
const FLUSH_FRAMES = SAMPLE_RATE / 10; // ~100 ms por mensaje

const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const n = 128;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    if (input && input.length) {
      l.set(input[0]);
      r.set(input[1] || input[0]);
    }
    this.port.postMessage([l, r], [l.buffer, r.buffer]);
    return true;
  }
}
registerProcessor('pcm', Pcm);
`;

let ctx = null;
let streams = [];
let pending = [];
let pendingFrames = 0;

function flush() {
  if (!pendingFrames) return;
  const out = new Int16Array(pendingFrames * 2);
  let o = 0;
  for (const [l, r] of pending) {
    for (let i = 0; i < l.length; i++) {
      out[o++] = Math.max(-1, Math.min(1, l[i])) * 0x7fff;
      out[o++] = Math.max(-1, Math.min(1, r[i])) * 0x7fff;
    }
  }
  pending = [];
  pendingFrames = 0;
  // flush() se llama al llegar el último bloque del worklet: ahora ≈ hora de captura de la
  // última muestra. El grabador la usa para alinear el audio con el vídeo.
  window.muninn.send('audio:chunk', { buf: out.buffer, wall: Date.now() });
}

async function teardown() {
  for (const s of streams) s.getTracks().forEach((t) => t.stop());
  streams = [];
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
  pending = [];
  pendingFrames = 0;
}

async function configure(cfg) {
  await teardown();
  const state = { system: false, mic: false, error: null };
  if (!cfg.system && !cfg.mic) {
    window.muninn.send('audio:ready', state);
    return;
  }

  // Sin dispositivo de salida: no reproduce nada y no se rompe si cambian los auriculares.
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, sinkId: { type: 'none' } });
  } catch {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  const thisCtx = ctx;
  ctx.onerror = () => {
    if (ctx !== thisCtx) return;
    queue = queue.then(() => configure(cfg)).catch(() => {});
  };
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'pcm', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit',
  });
  node.port.onmessage = ({ data }) => {
    pending.push(data);
    pendingFrames += data[0].length;
    if (pendingFrames >= FLUSH_FRAMES) flush();
  };
  // Hay que conectarlo al destino para que el navegador lo procese, pero en silencio.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  // Limitador sobre la mezcla para que los picos no saturen el clip.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 4;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  limiter.connect(node);

  const addSource = (stream, volume) => {
    streams.push(stream);
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = Number.isFinite(Number(volume)) ? Number(volume) : 1;
    src.connect(gain).connect(limiter);
  };

  if (cfg.system) {
    try {
      // Sin el procesado de videollamada (cancelación de eco, supresión de ruido, ganancia
      // automática): pasa el audio a mono y deja un efecto metálico/de eco en el juego.
      const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: raw });
      for (const t of s.getAudioTracks()) await t.applyConstraints(raw).catch(() => {});
      s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      if (s.getAudioTracks().length) {
        const { channelCount, echoCancellation, noiseSuppression, autoGainControl } = s.getAudioTracks()[0].getSettings();
        state.track = { channelCount, echoCancellation, noiseSuppression, autoGainControl };
        addSource(s, cfg.systemVolume);
        state.system = true;
      }
    } catch (e) {
      state.error = `Audio del sistema: ${e.message}`;
    }
  }
  if (cfg.mic) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: cfg.micDeviceId ? { exact: cfg.micDeviceId } : undefined,
          echoCancellation: false, autoGainControl: false, noiseSuppression: true,
        },
      });
      addSource(s, cfg.micVolume);
      state.mic = true;
    } catch (e) {
      state.error = `Micrófono: ${e.message}`;
    }
  }
  window.muninn.send('audio:ready', state);
}

let queue = Promise.resolve();
window.muninn.on('audio:config', (cfg) => {
  queue = queue.then(() => configure(cfg)).catch((e) => {
    window.muninn.send('audio:ready', { system: false, mic: false, error: e.message });
  });
});
