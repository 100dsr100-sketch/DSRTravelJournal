/* DSR Speech - the speech-to-text engine of DSR Dictation 3a, shared with DSR Notes and DSR Secure Store.
   Keep every copy identical (DSR Dictation is the master).

   Engines
   - 'google'  : the browser's Web Speech API (Chrome). Fast and accurate; the audio goes to Google.
                 Android fixes (from DSR Dictation 1x): continuous mode repeats words on Android, so it runs
                 one phrase per session and restarts; start() retries while the last session is still
                 ending; the last phrase is kept when Android ends a session without marking it final.
   - 'private' : on-device models (transformers.js in speech-worker.js) - nothing leaves the device.
                 Moonshine shows live words while you talk; Whisper transcribes after each pause.
                 Mic audio comes through an AudioWorklet (off the UI thread - the old ScriptProcessor
                 dropped audio whenever the page was busy), an adaptive noise gate finds each phrase.

   API
     DsrSpeech.start(opts) -> session { stop(), on, engine }
       opts: engine, model, lang, interim, profanity, continuous, gain, gate, keepAudio,
             onInterim(text), onFinal(text), onStatus(text), onLevel(0..1), onProgress(pct|null, label, amount),
             onError(message, fatal), onEnd(), onAudio(blob, seconds)
     DsrSpeech.process(raw, ctx, o) -> {cmd, arg, text, eat}  turn recognised words into note text
     DsrSpeech.transcribeFile(file, {model, onProgress(pct,label), onText(text)}) -> Promise<text>
     DsrSpeech.preload(model), DsrSpeech.isCached(model) -> Promise<bool>, DsrSpeech.MODELS, DsrSpeech.hasGoogle */
(function () {
  'use strict';
  var UA = navigator.userAgent, IS_ANDROID = /Android/i.test(UA), IS_PHONE = IS_ANDROID || /iPhone|iPad/i.test(UA);
  var Recog = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var LS = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  function lsGet(k) { try { return LS && LS.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (LS) { if (v == null) LS.removeItem(k); else LS.setItem(k, v); } } catch (e) {} }
  var HERE = (document.currentScript && document.currentScript.src) || location.href;

  var MODELS = [
    { id: 'onnx-community/moonshine-tiny-ONNX', name: 'Moonshine Tiny', mb: 28, live: true, hint: 'fastest - words appear while you talk' },
    { id: 'onnx-community/moonshine-base-ONNX', name: 'Moonshine Base', mb: 63, live: true, hint: 'more accurate, still quick' },
    { id: 'Xenova/whisper-tiny.en', name: 'Whisper Tiny', mb: 40, live: false, hint: 'older engine, text after each pause' },
    { id: 'Xenova/whisper-base.en', name: 'Whisper Base', mb: 75, live: false, hint: 'older engine, slow on phones' },
    { id: 'Xenova/whisper-small.en', name: 'Whisper Small', mb: 250, live: false, hint: 'best accuracy, PC only' }
  ];
  var DEFAULT_MODEL = MODELS[0].id;
  function modelInfo(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return MODELS[0]; }

  /* =====================================================================
     TEXT: spoken words -> note text (commands, punctuation, capitals, numbers, my words)
     ===================================================================== */
  /* only words that don't occur in ordinary speech - "point", "period", "quote", "dash", "colon" used to
     fire mid-sentence ("the point is" -> "the . is") */
  var CMD = {
    'full stop': '.', 'comma': ',', 'question mark': '?', 'exclamation mark': '!', 'exclamation point': '!',
    'colon mark': ':', 'semicolon': ';', 'semi colon': ';',
    'new line': '\n', 'newline': '\n', 'next line': '\n', 'line break': '\n',
    'new paragraph': '\n\n', 'next paragraph': '\n\n',
    'open bracket': '(', 'close bracket': ')', 'open parenthesis': '(', 'close parenthesis': ')',
    'open quote': '“', 'close quote': '”',
    'hyphen mark': '-', 'dash mark': ' – ', 'ellipsis': '…', 'dot dot dot': '…',
    'new bullet': '\n\u0001', 'bullet point': '\n\u0001',
    'ampersand': '&', 'percent sign': '%', 'at sign': '@', 'hash sign': '#', 'hashtag': '#', 'asterisk': '*',
    'smiley face': '🙂', 'sad face': '🙁', 'winky face': '😉', 'thumbs up emoji': '👍', 'heart emoji': '❤️'
  };
  var HUG_LEFT = { '.': 1, ',': 1, '?': 1, '!': 1, ':': 1, ';': 1, ')': 1, '”': 1, '…': 1, '%': 1 };
  /* text ending in an abbreviation (e.g. / i.e. / U.S. / Mr. / Dr.) - the next word isn't a new sentence */
  var ABBREV_END = /(?:^|[\s(“"'])(?:(?:[a-z]\.){2,}|mr\.|mrs\.|ms\.|dr\.|st\.|vs\.|approx\.|no\.)\s*$/i;
  /* hesitation sounds the engines write out ("um, so I think, uh, ...") */
  var FILLER = /,?\s*\b(?:u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m{2,}h*)\b(?:…|\.\.\.)?,?/gi;
  function dropFillers(t) {
    return t.replace(FILLER, '').replace(/([.!?])\s*[.,](?=\s|$)/g, '$1').replace(/^[\s,.…]+/, '').replace(/\s{2,}/g, ' ').trim();
  }

  function cleanKey(w) { return w.toLowerCase().replace(/[^a-z' ]/g, ''); }
  function capFirst(w) { return w.charAt(0).toUpperCase() + w.slice(1); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var N_SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  var N_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  var N_SCALE = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
  function wordsToNumbers(text) {
    var parts = text.split(/(\s+)/), out = [], i = 0;
    function low(x) { return (x || '').toLowerCase().replace(/[^a-z]/g, ''); }
    while (i < parts.length) {
      var w = low(parts[i]);
      if (parts[i].trim() === '' || (N_SMALL[w] == null && N_TENS[w] == null)) { out.push(parts[i]); i++; continue; }
      var result = 0, current = 0, seen = false, decimal = '', j = i, last = i;
      while (j < parts.length) {
        if (parts[j].trim() === '') { j++; continue; }
        var lw = low(parts[j]);
        if (lw === 'and' && seen) { j++; continue; }
        if (N_SMALL[lw] != null) { current += N_SMALL[lw]; seen = true; last = j; j++; continue; }
        if (N_TENS[lw] != null) { current += N_TENS[lw]; seen = true; last = j; j++; continue; }
        if (lw === 'hundred') { current = (current || 1) * 100; seen = true; last = j; j++; continue; }
        if (N_SCALE[lw] != null) { result += (current || 1) * N_SCALE[lw]; current = 0; seen = true; last = j; j++; continue; }
        if (lw === 'point') {
          var k = j + 1, digs = '', dlast = j;
          while (k < parts.length) { if (parts[k].trim() === '') { k++; continue; } var dl = low(parts[k]); if (N_SMALL[dl] != null && N_SMALL[dl] < 10) { digs += N_SMALL[dl]; dlast = k; k++; } else break; }
          if (digs) { decimal = '.' + digs; last = dlast; }
          break;
        }
        break;
      }
      if (seen) { out.push(String(result + current) + decimal); i = last + 1; }
      else { out.push(parts[i]); i++; }
    }
    return out.join('').replace(/(\d)\s*\bper ?cent\b/gi, '$1%');
  }

  function pushCmd(toks, v) {
    if (v.charAt(0) === '\n') toks.push({ t: 'nl', v: v });
    else if (v.length === 1 && (HUG_LEFT[v] || v === '(' || v === '“')) toks.push({ t: 'punct', v: v });
    else toks.push({ t: 'text', v: v });
  }
  function buildChunk(toks) {
    var s = '';
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (tk.t === 'nl') { s = s.replace(/[ \t]+$/, '') + tk.v; continue; }
      if (tk.t === 'punct') {
        if (HUG_LEFT[tk.v]) {
          s = s.replace(/[ \t]+$/, '');
          if (s.slice(-1) === tk.v) continue;                                     // the engine already put it there
          if (/[.!?]/.test(tk.v) && /[.!?]$/.test(s)) s = s.slice(0, -1);         // "question mark" after its full stop
          s += tk.v;
        } else { if (s && !/[\s(“]$/.test(s)) s += ' '; s += tk.v; }
        continue;
      }
      if (s && !/[\s(“]$/.test(s)) s += ' ';
      s += tk.v;
    }
    return s;
  }
  function applyCaps(chunk, ctx) {
    var atSentence = ctx === '' || (/[.!?…]["'”)]?\s*$/.test(ctx) && !ABBREV_END.test(ctx)) || /\n\s*(?:[•\-*] (?:\[ \] )?)?$/.test(ctx);
    if (atSentence) chunk = chunk.replace(/^(\s*[\(“"']?\s*)([a-z])/, function (_, p, c) { return p + c.toUpperCase(); });
    chunk = chunk.replace(/([.!?…]\s+|\n\s*(?:[•\-*] (?:\[ \] )?)?)([a-z])/g, function (all, p, c, off, str) {
      return (p.charAt(0) !== '\n' && ABBREV_END.test(ctx + ' ' + str.slice(0, off + p.length))) ? all : p + c.toUpperCase();
    });
    // the on-device engines capitalise the first word of every phrase: after a mid-sentence pause, lower it
    // again - only for everyday small words, so names keep their capital
    if (!atSentence && ctx && !/\n\s*$/.test(ctx)) chunk = chunk.replace(/^(\s*)([A-Z][a-z]*)\b/, function (all, sp, w) {
      return SMALL.test(w) ? sp + w.toLowerCase() : all;
    });
    return chunk.replace(/\bi\b(?!\.e\.)/g, 'I').replace(/\bi('|’)(m|ll|ve|d|s|re)\b/gi, function (_, ap, su) { return 'I' + ap + su; });
  }
  var SMALL = /^(A|An|And|As|At|Be|But|By|For|From|He|Her|His|If|In|Into|Is|It|Its|My|Of|On|Or|Our|She|So|That|The|Their|Them|Then|There|They|This|To|Too|Was|We|Were|What|When|Where|Which|While|Who|With|You|Your|Because|Also|Just|Not|Some|Than|About|After|Before|Until|Very|Really|Maybe|Are|Had|Has|Have|Will|Would|Could|Should|Can|Do|Did|Does|Get|Got|Go|Going|Went|Up|Out|Down|Over|Off|All|Any|Each|Every|More|Most|Much|Many)$/;
  function leadSep(existing, chunk) {
    if (!existing) return '';
    var tl = existing.slice(-1);
    if (/\s/.test(tl) || tl === '(' || tl === '“') return '';
    if (/^[.,?!:;)”…%]/.test(chunk) || chunk.charAt(0) === '\n') return '';
    return ' ';
  }
  function fmtDate(kind) {
    var d = new Date();
    if (kind === 'time') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (kind === 'date') return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /* o: { punct, numbers, caps, capsLock, fillers, phrases:[[say, write]...], bullet, has(str) }
     -> { cmd, arg } for a voice command, or { text, eat } to insert (already spaced/capitalised for ctx;
        first remove `eat` characters before the insertion point) */
  function process(raw, ctx, o) {
    o = o || {};
    ctx = ctx || '';
    raw = (raw || '').replace(/\s+/g, ' ').trim();
    if (!raw) return {};
    var whole = raw.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    if (o.punct !== false) {
      if (/^(scratch|delete|undo) that$/.test(whole)) return { cmd: 'scratch' };
      if (whole === 'delete last word') return { cmd: 'deleteWord' };
      if (whole === 'delete last sentence') return { cmd: 'deleteSentence' };
      if (whole === 'delete last line') return { cmd: 'deleteLine' };
      if (/^(stop|pause) (dictation|dictating|listening)$/.test(whole)) return { cmd: 'stop' };
      if (whole === 'caps on' || whole === 'caps lock on') return { cmd: 'capsOn' };
      if (whole === 'caps off' || whole === 'caps lock off') return { cmd: 'capsOff' };
      if (whole === 'join lines' || whole === 'join line') return { cmd: 'joinLines' };
      if (whole === 'undo') return { cmd: 'undo' };
      if (whole === 'redo') return { cmd: 'redo' };
      if (/^read (that|it|this) back$|^read back$/.test(whole)) return { cmd: 'readBack' };
      var rp = /^(?:replace|change|correct) (.+?) (?:with|to) (.+)$/i.exec(raw.replace(/[.!?]+$/, ''));
      if (rp && o.has && o.has(rp[1])) return { cmd: 'replace', arg: { from: rp[1], to: rp[2] } };
      if (/^insert (the )?(date|time|date and time|time and date|today'?s date)$/.test(whole)) {
        raw = fmtDate(/date and time|time and date/.test(whole) ? 'both' : /time/.test(whole) ? 'time' : 'date');
      }
      if (whole === 'new paragraph') return { text: '\n\n' };
    }
    if (o.fillers !== false) raw = dropFillers(raw);
    (o.phrases || []).forEach(function (p) {
      if (!p || !p[0] || p[1] == null) return;
      var re = new RegExp('(^|[^A-Za-z0-9])' + p[0].trim().split(/\s+/).map(escRe).join('[\\s,]+') + '(?![A-Za-z0-9])', 'gi');
      raw = raw.replace(re, function (_, pre) { return pre + p[1]; });
    });
    if (!raw) return {};
    if (o.numbers) raw = wordsToNumbers(raw);
    var words = raw.split(' '), toks = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i], k1 = cleanKey(w);
      var k2 = i + 1 < words.length ? k1 + ' ' + cleanKey(words[i + 1]) : null;
      var k3 = i + 2 < words.length ? k2 + ' ' + cleanKey(words[i + 2]) : null;
      if (o.punct !== false) {
        if (k3 && CMD[k3] != null) { pushCmd(toks, CMD[k3]); i += 2; continue; }
        if (k2 && CMD[k2] != null) { pushCmd(toks, CMD[k2]); i += 1; continue; }
        if (CMD[k1] != null) { pushCmd(toks, CMD[k1]); continue; }
        if ((k1 === 'capitalise' || k1 === 'capitalize') && words[i + 1]) { i++; toks.push({ t: 'text', v: capFirst(words[i]) }); continue; }
        if (k1 === 'all' && cleanKey(words[i + 1] || '') === 'caps' && words[i + 2]) { i += 2; toks.push({ t: 'text', v: words[i].toUpperCase() }); continue; }
      }
      toks.push({ t: 'text', v: w });
    }
    var chunk = buildChunk(toks).replace(/\u0001\s*/g, o.bullet == null ? '• ' : o.bullet);
    if (!chunk) return {};
    // spoken "question mark" etc. arriving after the on-device engine closed the last phrase with a full stop
    var eat = 0;
    if ((/^[.!?]/.test(chunk) && /[.!?]$/.test(ctx)) || (/^[,;:]/.test(chunk) && /\.$/.test(ctx) && !ABBREV_END.test(ctx))) { eat = 1; ctx = ctx.slice(0, -1); }
    if (o.capsLock) chunk = chunk.toUpperCase();
    else if (o.caps !== false) chunk = applyCaps(chunk, ctx);
    return { text: leadSep(ctx, chunk) + chunk, eat: eat };
  }

  /* =====================================================================
     PRIVATE ENGINE: worker, model loading, jobs
     ===================================================================== */
  var W = { worker: null, ready: '', device: '', loading: null, loadCb: null, jobs: {}, id: 0, files: {}, listeners: [] };
  function emit(type, a, b, c) { W.listeners.forEach(function (l) { try { l[type] && l[type](a, b, c); } catch (e) {} }); }
  function mb(b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0); }
  function wStage(s) { lsSet('dsr-speech.stage', s ? s + ' (' + modelInfo(W.want || DEFAULT_MODEL).name + ', ' + new Date().toLocaleTimeString() + ')' : null); }
  window.addEventListener('pagehide', function () { wStage(''); if (W.device === 'GPU') lsSet('dsr-speech.gpuTrying', null); });

  function worker() {
    if (W.worker) return W.worker;
    W.worker = new Worker(new URL('speech-worker.js', HERE).href, { type: 'module' });
    W.files = {};
    W.worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'stage') { wStage(m.stage); emit('progress', 100, 'Speech engine: ' + m.stage + '…', ''); }
      else if (m.type === 'progress') {
        if (!Object.keys(W.files).length) wStage('downloading the model');
        W.files[m.file] = { l: m.loaded, t: m.total };
        var L = 0, T = 0;
        Object.keys(W.files).forEach(function (k) { L += W.files[k].l; T += W.files[k].t; });
        // the model host often sends no file sizes (total == loaded so far) - measure against the model's known size
        var known = modelInfo(W.want).mb * 1048576;
        if (T <= L * 1.01 || T < known * 0.5) T = Math.max(T, known);
        var pct = T ? Math.min(99, Math.floor(L / T * 100)) : 0;
        emit('progress', pct, 'Downloading the private speech engine (' + modelInfo(W.want).name + ') - ' + pct + '%', mb(L) + ' of ~' + mb(T) + ' MB');
      } else if (m.type === 'gpufail') {
        lsSet('dsr-speech.noGpu', '1'); lsSet('dsr-speech.gpuTrying', null);
        W.files = {};
        emit('progress', 0, 'Graphics chip not usable - switching to the CPU version…', '');
      } else if (m.type === 'ready') {
        W.files = {}; wStage('');
        if (W.loadCb) { var cb = W.loadCb; W.loadCb = null; cb.res(m.device); }
      } else if (m.type === 'result' || m.type === 'error') {
        if (m.id != null && W.jobs[m.id]) { var j = W.jobs[m.id]; delete W.jobs[m.id]; m.type === 'result' ? j.res(m) : j.rej(new Error(m.message)); }
        else if (m.type === 'error' && W.loadCb) { var c2 = W.loadCb; W.loadCb = null; c2.rej(new Error(m.message)); }
      }
    };
    W.worker.onerror = function (ev) {
      var err = new Error((ev && ev.message) || 'the speech engine failed to start');
      if (W.loadCb) { var c = W.loadCb; W.loadCb = null; c.rej(err); }
      Object.keys(W.jobs).forEach(function (k) { W.jobs[k].rej(err); delete W.jobs[k]; });
      W.worker = null; W.ready = '';
    };
    return W.worker;
  }
  function load(model) {
    model = model || DEFAULT_MODEL;
    if (W.ready === model && W.worker) return Promise.resolve(W.device);
    if (W.loading) return W.want === model ? W.loading : W.loading.then(function () { return load(model); }, function () { return load(model); });
    W.want = model;
    emit('progress', 0, 'Loading the private speech engine (' + modelInfo(model).name + ')…', '');
    var p = new Promise(function (res, rej) {
      W.loadCb = { res: res, rej: rej };
      /* crash guard: a GPU driver can kill the whole page while building the model, so the worker never
         reports "gpufail". The attempt is marked first and cleared once a GPU job succeeds - a mark left
         over at the next load means it crashed. Phones never try the GPU. */
      if (lsGet('dsr-speech.gpuTrying') === '1') { lsSet('dsr-speech.noGpu', '1'); lsSet('dsr-speech.gpuTrying', null); }
      var noGpu = IS_PHONE || lsGet('dsr-speech.noGpu') === '1';
      if (!noGpu) lsSet('dsr-speech.gpuTrying', '1');
      worker().postMessage({ type: 'load', model: model, noGpu: noGpu });
    }).then(function (device) {
      if (device !== 'GPU') lsSet('dsr-speech.gpuTrying', null);
      W.ready = model; W.device = device; W.loading = null;
      emit('progress', null);
      emit('ready', device);
      return device;
    }, function (e) { W.loading = null; emit('progress', null); throw e; });
    W.loading = p;
    return p;
  }
  /* watchdog: a job far longer than its audio is stuck (or hopelessly slow) - kill the worker so nothing
     sits on "Transcribing…" forever; the model reloads from the device's cache for the next phrase */
  function run(audio, model) {
    var secs = audio.length / 16000, limit = Math.max(45, secs * 10) * 1000;
    return (W.ready === model && W.worker ? Promise.resolve() : load(model)).then(function () {
      return new Promise(function (res, rej) {
        var id = ++W.id, dog = setTimeout(function () {
          if (!W.jobs[id]) return;
          delete W.jobs[id];
          try { W.worker && W.worker.terminate(); } catch (x) {}
          W.worker = null; W.ready = ''; wStage('');
          rej(new Error('took over ' + Math.round(limit / 1000) + 's - skipped that bit and restarted the engine'));
        }, limit);
        W.jobs[id] = {
          res: function (v) { clearTimeout(dog); wStage(''); lsSet('dsr-speech.gpuTrying', null); res(v); },
          rej: function (e) { clearTimeout(dog); wStage(''); rej(e); }
        };
        wStage('turning ' + secs.toFixed(1) + 's of speech into text');
        worker().postMessage({ type: 'run', id: id, audio: audio }, [audio.buffer]);
      });
    });
  }
  function isCached(model) {
    model = model || DEFAULT_MODEL;
    if (!window.caches) return Promise.resolve(false);
    return caches.open('transformers-cache').then(function (c) { return c.keys(); }).then(function (keys) {
      return keys.some(function (r) { return r.url.indexOf(model) >= 0 && /\.onnx/.test(r.url); });
    }).catch(function () { return false; });
  }
  // Whisper "hears" these in silence / noise
  function junk(t) { return !t || /^[\(\[*].*[\)\]*]$/.test(t) || /^(you\.?|thank you\.?|thanks for watching[.!]?|bye\.?|\.+)$/i.test(t.trim()); }

  function to16k(src, sr) {
    if (sr === 16000) return src;
    var ratio = sr / 16000, n = Math.floor(src.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * ratio), b = Math.min(src.length, Math.floor((i + 1) * ratio)), s = 0;
      for (var j = a; j < b; j++) s += src[j];          // box-filter average = cheap anti-alias
      out[i] = b > a ? s / (b - a) : src[a];
    }
    return out;
  }

  /* =====================================================================
     SESSIONS
     ===================================================================== */
  var cur = null;
  var WORKLET = 'class C extends AudioWorkletProcessor{constructor(o){super();this.n=(o.processorOptions&&o.processorOptions.n)||1600;this.b=new Float32Array(this.n);this.i=0;}' +
    'process(inp){var c=inp[0]&&inp[0][0];if(c){for(var k=0;k<c.length;k++){this.b[this.i++]=c[k];if(this.i===this.n){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(this.n);this.i=0;}}}return true;}}' +
    'registerProcessor("dsr-capture",C);';
  var workletUrl = null;

  function start(o) {
    if (cur) cur.stop();
    o = o || {};
    var s = { on: true, engine: o.engine === 'private' || !Recog ? 'private' : 'google', o: o };
    function cb(name) { var f = o[name]; if (typeof f !== 'function') return; try { f.apply(null, [].slice.call(arguments, 1)); } catch (e) { console.error(e); } }
    s.cb = cb;
    cur = s;
    var listener = { progress: function (p, l, a) { cb('onProgress', p, l, a); } };
    W.listeners.push(listener);
    s.cleanup = function () { var i = W.listeners.indexOf(listener); if (i >= 0) W.listeners.splice(i, 1); };
    if (s.engine === 'google') startGoogle(s); else startPrivate(s);
    s.stop = function () { stopSession(s); };
    return s;
  }
  function stopSession(s) {
    if (!s.on) return;
    s.on = false;
    if (s.stopEngine) s.stopEngine();
    stopRecorder(s);
    if (cur === s) cur = null;
    s.cb('onInterim', '');
    s.cb('onLevel', 0);
    // a private session ends once its last phrases are transcribed
    if (!s.pending || !s.pending()) { s.cleanup(); s.cb('onEnd'); }
  }

  /* ---- level meter + optional recording for Google on desktop (Android allows only one mic user:
          a second stream starves the speech engine - meter moves, no text) ---- */
  function sideStream(s) {
    if (IS_ANDROID || !navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (!s.on) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
      var an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      var buf = new Uint8Array(an.fftSize), raf = null, t = 0;
      (function tick(ts) {
        if (ts - t > 60) { t = ts; an.getByteTimeDomainData(buf); var sum = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; } s.cb('onLevel', Math.sqrt(sum / buf.length)); }
        raf = requestAnimationFrame(tick);
      })(0);
      startRecorder(s, stream);
      s.stopSide = function () { cancelAnimationFrame(raf); stream.getTracks().forEach(function (t) { t.stop(); }); try { ctx.close(); } catch (e) {} };
    }).catch(function () {});
  }
  function startRecorder(s, stream) {
    if (!s.o.keepAudio || !window.MediaRecorder) return;
    try {
      var mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', ''].filter(function (m) { return !m || MediaRecorder.isTypeSupported(m); })[0];
      var r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined), parts = [], t0 = Date.now();
      r.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
      r.onstop = function () { if (parts.length) s.cb('onAudio', new Blob(parts, { type: r.mimeType || 'audio/webm' }), Math.round((Date.now() - t0) / 1000)); };
      r.start(5000);
      s.recorder = r;
    } catch (e) {}
  }
  function stopRecorder(s) { try { if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop(); } catch (e) {} s.recorder = null; }

  /* ---- Google (Web Speech) ---- */
  function startGoogle(s) {
    var o = s.o, rec = new Recog(), running = false, lastStart = 0, restartT = null, pending = '', pulseT = null;
    rec.continuous = !IS_ANDROID;            // Android repeats words in continuous mode
    rec.interimResults = o.interim !== false;
    rec.maxAlternatives = 1;
    rec.lang = o.lang || 'en-AU';
    if ('profanityFilter' in rec) rec.profanityFilter = !!o.profanity;
    function pulse(v) { if (!IS_ANDROID) return; s.cb('onLevel', v); clearTimeout(pulseT); pulseT = setTimeout(function () { s.cb('onLevel', 0); }, 350); }
    rec.onstart = function () { lastStart = Date.now(); };
    rec.onaudiostart = function () { s.cb('onStatus', 'Listening…'); };
    rec.onsoundstart = function () { pulse(0.12); };
    rec.onspeechstart = function () { pulse(0.25); };
    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) { pending = ''; s.cb('onFinal', r[0].transcript); }
        else interim += r[0].transcript;
      }
      if (interim) pending = interim;
      pulse(0.22);
      s.cb('onInterim', o.interim !== false ? interim : '');
    };
    rec.onerror = function (e) {
      var err = e.error || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') { s.cb('onError', 'Microphone permission denied - allow the microphone for this site, then try again.', true); stopSession(s); }
      else if (err === 'audio-capture') { s.cb('onError', 'No microphone found.', true); stopSession(s); }
      else if (err === 'no-speech') s.cb('onStatus', 'No speech heard - still listening…');
      else if (err === 'network') s.cb('onStatus', 'Speech network hiccup - retrying…');
      else if (err !== 'aborted') s.cb('onStatus', 'Speech error: ' + err);
    };
    rec.onend = function () {
      running = false;
      // Android often ends a session without marking the last phrase final - keep it
      if (pending) { var p = pending; pending = ''; s.cb('onInterim', ''); s.cb('onFinal', p); }
      if (!s.on) return;
      if (o.continuous === false && !IS_ANDROID) { stopSession(s); return; }
      var wait = Date.now() - lastStart < 700 ? 900 : 120;
      clearTimeout(restartT);
      restartT = setTimeout(function () { if (s.on) safeStart(0); }, wait);
    };
    /* rec.start() throws while the previous session is still ending (fast stop -> start): retry */
    function safeStart(tries) {
      if (running) return;
      try { rec.start(); running = true; }
      catch (e) { if (tries < 8) setTimeout(function () { if (s.on) safeStart(tries + 1); }, 250); }
    }
    s.stopEngine = function () {
      clearTimeout(restartT); clearTimeout(pulseT);
      try { rec.stop(); } catch (e) {}
      if (pending) { var p = pending; pending = ''; s.cb('onFinal', p); }
      if (s.stopSide) s.stopSide();
    };
    s.cb('onStatus', 'Starting…');
    safeStart(0);
    sideStream(s);
  }

  /* ---- Private (on-device) ---- */
  function startPrivate(s) {
    var o = s.o, model = o.model || DEFAULT_MODEL, info = modelInfo(model);
    var A = { ctx: null, stream: null, node: null, src: null, buf: [], len: 0, speaking: false, quietN: 0, voiced: 0, floor: 0, utt: 0, ended: false,
              queue: [], busy: false, peekAt: 0, peekGap: 900, peekOff: !info.live || o.interim === false, lastMs: 0 };
    s.pending = function () { return A.busy || A.queue.length > 0; };
    // after every job: the next one, or - once stopped and idle - end the session (exactly once)
    function settle() {
      if (A.queue.length) { drain(); return; }
      if (!s.on && !A.busy && !A.ended) { A.ended = true; s.cleanup(); s.cb('onEnd'); }
    }
    var sr = 16000;
    if (!navigator.mediaDevices || !(window.AudioContext || window.webkitAudioContext)) { s.cb('onError', 'Audio capture is not supported in this browser.', true); stopSession(s); return; }
    s.cb('onStatus', 'Loading the private speech engine…');
    load(model).then(function () {
      if (!s.on) throw 0;
      return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }).then(function (stream) {
      if (!s.on) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext, ctx;
      try { ctx = new AC({ sampleRate: 16000 }); } catch (e) { ctx = new AC(); }
      A.ctx = ctx; A.stream = stream; sr = ctx.sampleRate || 16000;
      A.src = ctx.createMediaStreamSource(stream);
      var mute = ctx.createGain(); mute.gain.value = 0;
      var frameN = Math.round(sr / 10);       // 100 ms
      var wire = function (node) { A.node = node; A.src.connect(node); node.connect(mute); mute.connect(ctx.destination); };
      var viaProcessor = function () {
        var n = ctx.createScriptProcessor(4096, 1, 1);
        n.onaudioprocess = function (ev) { frame(new Float32Array(ev.inputBuffer.getChannelData(0))); };
        wire(n);
      };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        ctx.audioWorklet.addModule(workletUrl).then(function () {
          if (!s.on) return;
          var n = new AudioWorkletNode(ctx, 'dsr-capture', { processorOptions: { n: frameN } });
          n.port.onmessage = function (e) { frame(e.data); };
          wire(n);
        }).catch(viaProcessor);
      } else viaProcessor();
      startRecorder(s, stream);
      s.cb('onStatus', listeningMsg());
    }).catch(function (e) {
      if (e === 0) return;
      s.cb('onError', 'The private speech engine could not start: ' + ((e && e.message) || e), true);
      stopSession(s);
    });

    function listeningMsg() {
      return 'Listening (' + info.name + ', ' + (W.device || 'CPU') + ')' + (A.lastMs ? ' · last phrase took ' + (A.lastMs / 1000).toFixed(1) + 's' : '') +
        (!info.live ? ' - pause to see your words' : '');
    }
    function frame(f) {
      if (!s.on) return;
      var g = +o.gain || 1, sum = 0;
      if (g !== 1) for (var i = 0; i < f.length; i++) f[i] *= g;
      for (var j = 0; j < f.length; j++) sum += f[j] * f[j];
      var rms = Math.sqrt(sum / f.length);
      s.cb('onLevel', rms);
      // adaptive: track the room's background level so steady noise can't hold the gate open (DSR Dictation 1g)
      if (!A.floor || rms < A.floor) A.floor = A.floor ? A.floor * 0.8 + rms * 0.2 : rms;
      else A.floor += (rms - A.floor) * 0.0012;        // 100 ms frames (was 256 ms) - same rise per second
      var gate = Math.max(+o.gate || 0.012, A.floor * 2.5);
      if (rms > gate) {
        if (!A.speaking) { A.speaking = true; A.utt++; A.voiced = 0; }
        A.quietN = 0; A.voiced += f.length; A.buf.push(f); A.len += f.length;
        if (o.onSpeech) s.cb('onSpeech');
      } else if (A.speaking) {
        A.buf.push(f); A.len += f.length; A.quietN += f.length;
        if (A.quietN >= sr * 0.6 && A.len > sr * 0.4) flush();
      } else {
        // keep ~0.3 s of lead-in so the first syllable isn't clipped
        A.buf.push(f); A.len += f.length;
        while (A.buf.length > 1 && A.len - A.buf[0].length > sr * 0.3) A.len -= A.buf.shift().length;
      }
      if (A.speaking && A.len > sr * 12) flush();
      else if (A.speaking) peek();
    }
    function merged() {
      var m = new Float32Array(A.len), off = 0;
      A.buf.forEach(function (fr) { m.set(fr, off); off += fr.length; });
      return m;
    }
    function flush() {
      if (!A.len) return;
      var m = merged(), tailN = Math.min(A.len, Math.round(sr * 0.2)), tail = m.slice(A.len - tailN);
      var voiced = A.voiced;
      A.buf = [tail]; A.len = tail.length; A.speaking = false; A.quietN = 0; A.voiced = 0;
      if (voiced < sr * 0.2) { s.cb('onInterim', ''); return; }       // a click or a cough - not worth a transcription
      A.queue.push({ audio: to16k(m, sr), utt: A.utt });
      drain();
    }
    /* live words (Moonshine): re-read the phrase so far about once a second while the engine is free.
       Backs off on a slow device, and stops trying if a preview takes over 4 s. */
    function peek() {
      if (A.peekOff || A.busy || A.queue.length || A.len < sr * 0.8) return;
      var now = Date.now();
      if (now - A.peekAt < A.peekGap) return;
      A.peekAt = now; A.busy = true;
      var utt = A.utt, t0 = now;
      run(to16k(merged(), sr), model).then(function (r) {
        var ms = Date.now() - t0;
        if (ms > 4000) A.peekOff = true; else A.peekGap = Math.max(900, ms * 1.6);
        if (s.on && utt === A.utt && A.speaking && !junk(r.text)) s.cb('onInterim', r.text);
      }).catch(function () { A.peekOff = true; }).then(function () { A.busy = false; settle(); });
    }
    function drain() {
      if (A.busy || !A.queue.length) return;
      A.busy = true;
      var job = A.queue.shift(), t0 = Date.now(), secs = (job.audio.length / 16000).toFixed(1);
      var tick = function () {
        var q = A.queue.length;
        s.cb('onStatus', 'Turning ' + secs + 's of speech into text… ' + Math.round((Date.now() - t0) / 1000) + 's' + (q ? ' (+' + q + ' waiting)' : ''));
      };
      var tt = info.live ? null : (tick(), setInterval(tick, 1000));
      run(job.audio, model).then(function (r) {
        A.lastMs = r.ms;
        s.cb('onInterim', '');
        if (!junk(r.text)) s.cb('onFinal', r.text);
      }).catch(function (e) {
        s.cb('onError', 'Transcription failed: ' + ((e && e.message) || e), false);
      }).then(function () {
        if (tt) clearInterval(tt);
        A.busy = false;
        if (s.on) s.cb('onStatus', listeningMsg());
        settle();
      });
    }
    s.stopEngine = function () {
      try { if (A.node) { if (A.node.port) A.node.port.onmessage = null; else A.node.onaudioprocess = null; A.node.disconnect(); } } catch (e) {}
      try { A.src && A.src.disconnect(); } catch (e) {}
      try { A.stream && A.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { A.ctx && A.ctx.close(); } catch (e) {}
      A.node = A.src = A.stream = A.ctx = null;
      if (A.speaking && A.len > sr * 0.3) flush();      // the phrase you were in the middle of
      A.buf = []; A.len = 0; A.speaking = false;
    };
  }

  /* =====================================================================
     AUDIO FILES: decode, cut at pauses into <=20 s pieces, transcribe on the device
     ===================================================================== */
  function transcribeFile(file, o) {
    o = o || {};
    var model = o.model || DEFAULT_MODEL;
    function prog(p, l) { if (o.onProgress) try { o.onProgress(p, l); } catch (e) {} }
    var listener = { progress: function (p, l, a) { if (p != null) prog(p, l + (a ? ' (' + a + ')' : '')); } };
    W.listeners.push(listener);
    function done() { var i = W.listeners.indexOf(listener); if (i >= 0) W.listeners.splice(i, 1); }
    prog(0, 'Reading ' + file.name + '…');
    return file.arrayBuffer().then(function (ab) {
      var AC = window.AudioContext || window.webkitAudioContext, ctx;
      try { ctx = new AC({ sampleRate: 16000 }); } catch (e) { ctx = new AC(); }
      return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); }).then(function (buf) {
        try { ctx.close(); } catch (e) {}
        var n = buf.length, mono = new Float32Array(n);
        for (var c = 0; c < buf.numberOfChannels; c++) { var d = buf.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
        return to16k(mono, buf.sampleRate);
      }, function () { try { ctx.close(); } catch (e) {} throw new Error("this file's audio format can't be read here"); });
    }).then(function (pcm) {
      var pieces = cutAtPauses(pcm), out = [], k = 0;
      var total = pcm.length / 16000;
      return load(model).then(function next() {
        if (o.cancelled && o.cancelled()) return out.join(' ');
        if (k >= pieces.length) return out.join(' ');
        var p = pieces[k++];
        prog(Math.round((k - 1) / pieces.length * 100), 'Transcribing ' + file.name + ' - ' + fmtClock(p.at) + ' of ' + fmtClock(total));
        return run(p.audio, model).then(function (r) {
          if (!junk(r.text)) { out.push(r.text); if (o.onText) try { o.onText(r.text); } catch (e) {} }
          return next();
        });
      });
    }).then(function (txt) { done(); prog(null); return txt; }, function (e) { done(); prog(null); throw e; });
  }
  function fmtClock(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function cutAtPauses(pcm) {
    var MAXN = 16000 * 20, MINN = 16000 * 8, WIN = 1600, out = [], start = 0;
    while (start < pcm.length) {
      var end = Math.min(pcm.length, start + MAXN);
      if (end < pcm.length) {
        // quietest 100 ms window between 8 s and 20 s into the piece
        var best = end, bestE = Infinity;
        for (var w = start + MINN; w + WIN <= end; w += WIN / 2) {
          var e = 0; for (var i = w; i < w + WIN; i += 4) e += pcm[i] * pcm[i];
          if (e < bestE) { bestE = e; best = w + WIN / 2; }
        }
        end = best;
      }
      var piece = pcm.slice(start, end), peak = 0;
      for (var j = 0; j < piece.length; j += 8) peak = Math.max(peak, Math.abs(piece[j]));
      if (peak > 0.01) out.push({ audio: piece, at: start / 16000 });      // skip silent stretches
      start = end;
    }
    return out;
  }

  window.DsrSpeech = {
    MODELS: MODELS, DEFAULT_MODEL: DEFAULT_MODEL, modelInfo: modelInfo,
    hasGoogle: !!Recog, isAndroid: IS_ANDROID, isPhone: IS_PHONE,
    start: start, process: process, wordsToNumbers: wordsToNumbers,
    preload: load, isCached: isCached, transcribeFile: transcribeFile,
    device: function () { return W.device; },
    lastCrash: function () { var v = lsGet('dsr-speech.stage'); lsSet('dsr-speech.stage', null); return v; },
    _t: { applyCaps: applyCaps, buildChunk: buildChunk, cutAtPauses: cutAtPauses, to16k: to16k }
  };
})();
