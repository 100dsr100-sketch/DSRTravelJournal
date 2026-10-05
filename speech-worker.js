/* DSR speech worker - on-device speech-to-text, off the UI thread.
   Shared by DSR Dictation, DSR Notes and DSR Secure Store: keep the copies identical.
   Moonshine (DSR Dictation 3a) is built for live dictation: its work grows with the length of what
   you said, where Whisper always processes a padded 30-second window - so a 3-second phrase is
   several times quicker on a phone. Whisper models are still offered.
   Messages in : {type:'load', model, noGpu} | {type:'run', id, audio:Float32Array(16 kHz)}
   Messages out: {type:'progress', file, loaded, total} | {type:'stage', stage} | {type:'gpufail', message}
                 {type:'ready', device} | {type:'result', id, text, ms} | {type:'error', id?, message} */
// self-hosted copies (not the CDN): multi-threaded WASM starts helper Workers from the runtime's own
// URL, and a Worker script must be same-origin. Self-hosting also makes the engine work offline.
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
// multi-threaded WASM needs cross-origin isolation (_headers on the site, the service worker as backup)
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)) : 1;
try {
  env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
  env.backends.onnx.wasm.numThreads = THREADS;
} catch (e) {}

let pipe = null, model = '', device = '', chain = Promise.resolve();
const isMoon = n => /moonshine/i.test(n);

async function hasWebGPU() {
  try { return !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()); }
  catch (e) { return false; }
}

async function load(name, noGpu) {
  if (pipe && model === name) { postMessage({ type: 'ready', device }); return; }
  if (pipe) { try { await pipe.dispose(); } catch (e) {} }
  pipe = null; model = '';
  const progress_callback = p => {
    if (p && p.status === 'progress' && p.file) postMessage({ type: 'progress', file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
  };
  // GPU (desktops only - phone GPU drivers crashed the page in DSR Dictation 1i); otherwise quantised WASM
  if (!noGpu && await hasWebGPU()) {
    postMessage({ type: 'stage', stage: 'starting the engine on the graphics chip (GPU)' });
    try {
      pipe = await pipeline('automatic-speech-recognition', name, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback });
      device = 'GPU';
    } catch (e) { pipe = null; postMessage({ type: 'gpufail', message: String((e && e.message) || e) }); }
  }
  if (!pipe) {
    postMessage({ type: 'stage', stage: 'starting the engine on the CPU' });
    pipe = await pipeline('automatic-speech-recognition', name, { device: 'wasm', dtype: 'q8', progress_callback });
    device = 'CPU ×' + THREADS;
  }
  model = name;
  postMessage({ type: 'ready', device });
}

async function run(audio) {
  if (!pipe) throw new Error('the speech engine is not loaded');
  const secs = audio.length / 16000;
  // Cap output to what that much speech could hold (~4-5 tokens a second): on noise these models can
  // loop repeating themselves up to the model limit, which on a phone CPU takes minutes.
  const max_new_tokens = Math.min(440, Math.ceil(secs * 6) + 10);
  // English-only (.en) Whisper models reject task/language options
  const opts = isMoon(model) ? { max_new_tokens } : { chunk_length_s: 30, max_new_tokens };
  const out = await pipe(audio, opts);
  return ((out && out.text) || '').trim();
}

self.onmessage = (e) => {
  const m = e.data;
  // one job at a time, in arrival order (a live preview and a final phrase must not interleave)
  chain = chain.then(async () => {
    try {
      if (m.type === 'load') await load(m.model, m.noGpu);
      else if (m.type === 'run') {
        const t0 = performance.now();
        const text = await run(m.audio);
        postMessage({ type: 'result', id: m.id, text, ms: Math.round(performance.now() - t0) });
      }
    } catch (err) {
      postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    }
  });
};
