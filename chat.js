/* =====================================================================
 * Вкладка «Общение»: разговорная практика с нейросетью.
 *
 *   🎙 запись голоса → WAV 16 кГц → Gemini (распознаёт, исправляет, отвечает)
 *   → 💡 исправленная фраза [Объяснить] [Оценка]
 *   → 🔊 ответ только голосом [Текст] [Помощь]
 *   → в тексте нажимаешь на слово → перевод → «В словарь» (сразу в «Мои слова»)
 *
 * Мозг — Google Gemini API: бесплатный ключ из AI Studio хранится только в этом браузере.
 * Голос озвучивает сам браузер (speechSynthesis), перевод слов — встроенный словарь приложения.
 * Использует общие функции из app.js: $, esc, svg, toast, speak, addWord, localLookup, loadDict.
 * ===================================================================== */

const AI_KEY = 'wordbook.ai';        // { key, model, rate }
const CHAT_KEY = 'wordbook.chat';    // { msgs: [...] }
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const HISTORY_TURNS = 20;            // сколько последних реплик видит собеседник
const MAX_RECORD_SEC = 60;
const TIMEOUT_MS = 45000;            // дольше одну модель не ждём совсем
const HEDGE_MS = 8000;               // молчит дольше — параллельно спрашиваем следующую модель
const COOLDOWN_MS = 10 * 60 * 1000;  // модель, которая не ответила, 10 минут пробуем последней

const CHAT_ICON = {
  mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
  send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  keyboard: svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  bookmark: svg('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

/* ---------------------------- Хранилище ---------------------------- */

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch { return { ...fallback }; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('save', e); }
}

const ai = loadJSON(AI_KEY, { key: '', model: '', rate: 1, voice: 'Aoede', v: 0 });
// раньше модель запоминалась сама после первого ответа; теперь пустая модель = «выбирать автоматически»
const migrate = ai.v < 2;
if (migrate) { ai.model = ''; ai.v = 2; }
// скорость и сбои моделей: { [модель]: { ms, failAt } } — чтобы сначала идти к быстрым и живым
const health = loadJSON('wordbook.ai-health', {});
const chat = loadJSON(CHAT_KEY, { msgs: [], memory: '' });
const MEMORY_MAX = 1200;             // краткая выжимка о тебе и прошлых разговорах, символов
// копию обновляем всегда: если ключ стёрли в настройках, восстанавливать его не нужно
const saveAi = () => { saveJSON(AI_KEY, ai); backupKey(ai.key); };
// сохраняем при запуске, только если что-то поменяли: иначе пустые настройки могли бы затереть ключ
if (migrate && ai.key) saveAi();

/* ---------------------- Запасная копия ключа ------------------------
 * iOS иногда чистит localStorage сайтов, открытых с главного экрана. Ключ дублируем в IndexedDB
 * и просим браузер не удалять данные сайта (navigator.storage.persist). */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('wordbook', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { resolve(req.result); open.result.close(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function backupKey(key) {
  idb('readwrite', s => s.put(key, 'gemini-key')).catch(e => console.warn('idb', e));
  if (key) navigator.storage?.persist?.().catch(() => {});
}

/* Ключа нет в localStorage, но есть в запасной копии — восстанавливаем */
async function restoreKey() {
  if (ai.key) return;
  try {
    const key = await idb('readonly', s => s.get('gemini-key'));
    if (!key || ai.key) return;
    ai.key = key;
    saveJSON(AI_KEY, ai);
    if (document.body.classList.contains('chat-mode')) showChat();
  } catch (e) { console.warn('idb', e); }
}
// ссылки на записи голоса живут только до перезагрузки — в хранилище их не кладём
const saveChat = () => saveJSON(CHAT_KEY, {
  msgs: chat.msgs.filter(m => !m.failed && (m.kind !== 'user' || m.fb)).slice(-100).map(({ audioUrl, ...m }) => m),
  memory: chat.memory,
});

/* ------------------------------ Промпты ----------------------------- */

const SYSTEM_PROMPT = `You are Chatty, a friendly English conversation partner for a Russian-speaking learner.
The learner talks to you by voice (an audio recording is attached) or by typing. Your reply is read
aloud by text-to-speech, and the learner first only hears it, so it must be easy to follow by ear.

For every learner message:
1. "transcript": write down EXACTLY what the learner said, word for word, keeping all their grammar
   mistakes, wrong words and missing words. Do NOT correct anything in the transcript — it is used to
   show the learner their mistakes. Leave out only fillers like "um", "uh". For typed messages copy the text.
2. "mistakes": real language mistakes — grammar, word choice, word order, tense, unnatural phrasing.
   Ignore punctuation and capitalisation. Explain each one briefly in Russian (one sentence).
   If the message is fine, return an empty list.
3. "corrected": the whole message rewritten as natural, correct English.
4. "reply": keep the conversation going in English: 2–4 short spoken-style sentences, then one question
   back. Match the learner's level. No lists, emoji or markdown. If the learner speaks Russian, answer
   in simple English and gently encourage them to try in English.
5. "reply_ru": natural Russian translation of your reply.
6. "score" (1–10) and "score_comment" (Russian, 1–2 sentences): rate the learner's message for their
   level — grammar, vocabulary, naturalness — what was good and what to work on.
7. "words": for EVERY word of your reply, in order: the word exactly as written in the reply, its
   dictionary form ("lemma"; for a phrasal verb or set phrase give the whole phrase, e.g. "welcome back",
   "pick up") and its Russian translation that fits this context (1–3 words).
8. "memory": your updated long-term memory about the learner, kept between conversations. Start from
   the memory you were given (if any), add what you learnt from this message and drop what no longer
   matters. Keep facts the learner shared (name, job, city, plans, hobbies, people in their life), topics
   you talked about recently, and mistakes they make again and again. Plain English, under 100 words.
   Refer to the learner by name or as "the learner"; don't guess their gender from the name.
   Use this memory naturally in conversation — ask how the things they told you about went.`;

/* Память добавляется в инструкцию отдельным блоком: так её видят и ответы, и «Помощь» */
function systemParts() {
  const parts = [{ text: SYSTEM_PROMPT }];
  if (chat.memory) parts.push({ text: 'What you remember about the learner from earlier conversations:\n' + chat.memory });
  return parts;
}

const HELP_PROMPT = `The learner doesn't know how to answer your last message. Suggest three different
short answers they could say (natural spoken English, 1–2 sentences each, from easy to more advanced),
each with a Russian translation, and one useful phrase or structure to try with a short explanation
in Russian.`;

const str = { type: 'STRING' };
const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: str,
    mistakes: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { wrong: str, right: str, why: str }, required: ['wrong', 'right', 'why'] },
    },
    corrected: str,
    score: { type: 'INTEGER' },
    score_comment: str,
    reply: str,
    reply_ru: str,
    memory: str,
    words: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { word: str, lemma: str, ru: str }, required: ['word', 'lemma', 'ru'] },
    },
  },
  required: ['transcript', 'mistakes', 'corrected', 'score', 'score_comment', 'reply', 'reply_ru', 'words', 'memory'],
  propertyOrdering: ['transcript', 'mistakes', 'corrected', 'score', 'score_comment', 'reply', 'reply_ru', 'words', 'memory'],
};
const HELP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answers: { type: 'ARRAY', items: { type: 'OBJECT', properties: { en: str, ru: str }, required: ['en', 'ru'] } },
    tip: str,
  },
  required: ['answers', 'tip'],
};

/* ------------------------------ Gemini ------------------------------ */

class AiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function geminiFetch(path, body, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctrl.abort());
  let r, data;
  try {
    r = await fetch(GEMINI + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.key },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    if (signal?.aborted) throw new AiError('отменено', 'aborted');   // ответила другая модель
    // обрыв связи или Google не ответил вовремя
    throw ctrl.signal.aborted
      ? new AiError('Google не ответил вовремя', 'timeout')
      : new AiError('Нет связи с Google', 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const msg = data.error?.message || 'HTTP ' + r.status;
    if (r.status === 400 && /API key/i.test(msg)) throw new AiError('Ключ не подходит — проверь его в настройках', 401);
    if (r.status === 403) throw new AiError('Нет доступа: ' + msg, 403);
    if (r.status === 429) throw new AiError('Исчерпан бесплатный лимит запросов', 429);
    throw new AiError(msg, r.status);
  }
  return data;
}

/* Все модели ключа одним запросом: названия у Google меняются часто, поэтому не зашиваем их в код */
let allModels = null;
async function fetchModels() {
  allModels ??= geminiFetch('/models?pageSize=1000')
    .then(d => (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, '')))
    .catch(e => { allModels = null; throw e; });
  return allModels;
}

const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
// Lite — быстрее и реже перегружены, поэтому они первыми
const rank = n => (/lite/.test(n) ? 0 : 1) + (/preview|exp/.test(n) ? 0.5 : 0);
const byRank = (a, b) => rank(a) - rank(b) || ver(b) - ver(a) || a.localeCompare(b);

/* Flash-модели для разговора */
async function listModels() {
  return (await fetchModels())
    .filter(n => /^gemini-.*flash/.test(n) && !/tts|image|live|embed|audio|omni|transcribe|computer|robotics/.test(n))
    .sort(byRank);
}

/* Модели, которые озвучивают текст */
async function listTtsModels() {
  return (await fetchModels()).filter(n => /^gemini-.*tts/.test(n) && !/pro/.test(n)).sort(byRank);
}

/* Порядок попыток: ожидаемое время ответа — измеренное, иначе условное по порядку списка;
 * модели, которые недавно не ответили, — в конец */
function byHealth(models) {
  const now = Date.now();
  models = models.filter(m => !health[m]?.gone);
  const cost = (m, i) => (now - (health[m]?.failAt || 0) < COOLDOWN_MS ? 1e9 : 0)
    + (health[m]?.ms ?? 12000 + i * 500);
  return models.map((m, i) => [m, cost(m, i)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
}

let modelsCache = null;
async function modelChain() {
  modelsCache ??= await listModels();
  const auto = byHealth(modelsCache);
  // модель, выбранная вручную в настройках, — первой
  return ai.model ? [ai.model, ...auto.filter(m => m !== ai.model)] : auto;
}

function noteHealth(model, ms, err) {
  const h = health[model] ||= {};
  if (err?.status === 404) h.gone = true;          // Google отключил модель — больше не пробуем
  else if (ms == null) h.failAt = Date.now();
  else { h.ms = h.ms ? Math.round(h.ms * 0.6 + ms * 0.4) : ms; h.failAt = 0; }
  saveJSON('wordbook.ai-health', health);
}

/*
 * Запрос к нескольким моделям «наперегонки». Google на бесплатном ключе отвечает то за 3 с, то за 50,
 * поэтому: спрашиваем первую модель; если она молчит дольше HEDGE_MS или упала — спрашиваем следующую,
 * не отменяя первую. Берём первый успешный ответ, остальные запросы отменяем.
 */
function raceModels(models, run, onSlow = () => {}) {
  return new Promise((resolve, reject) => {
    const started = new Map();   // модель → { ctrl, t0 }
    let next = 0, done = false, lastErr = null, hedge;
    const finish = () => { done = true; clearTimeout(hedge); started.forEach(a => a.ctrl.abort()); };
    const launch = () => {
      if (done) return;
      if (next >= models.length) {
        if (!started.size) { done = true; reject(lastErr || new AiError('Нет доступных моделей')); }
        return;
      }
      const model = models[next++];
      const attempt = { ctrl: new AbortController(), t0: Date.now() };
      started.set(model, attempt);
      clearTimeout(hedge);
      hedge = setTimeout(() => { if (!done && next < models.length) { onSlow(); launch(); } }, HEDGE_MS);
      run(model, attempt.ctrl.signal).then(out => {
        if (done) return;
        started.delete(model);
        noteHealth(model, Date.now() - attempt.t0);
        // проигравшие были как минимум настолько медленными — запомним, чтобы реже ставить их первыми
        started.forEach((a, m) => { const h = health[m] ||= {}; h.ms = Math.max(h.ms || 0, Date.now() - a.t0); });
        finish();
        resolve(out);
      }, e => {
        if (done) return;
        started.delete(model);
        lastErr = e;
        // ключ неверный или запрос плохой — другая модель не поможет
        if (!RETRYABLE.has(e.status)) { finish(); reject(e); return; }
        noteHealth(model, null, e);
        launch();
      });
    };
    launch();
  });
}

/* Временные сбои: лимит, перегрузка у Google, пропавшая модель, таймаут, обрыв связи.
 * На них пробуем ещё раз — уже на следующей модели из списка */
const RETRYABLE = new Set([429, 404, 500, 502, 503, 504, 'timeout', 'network', 'empty']);

async function generate(contents, schema, onRetry = () => {}) {
  const body = {
    systemInstruction: { parts: systemParts() },
    contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
  };
  return raceModels((await modelChain()).slice(0, 3), async (model, signal) => {
    const d = await geminiFetch(`/models/${model}:generateContent`, body, signal);
    const cand = d.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!text) throw new AiError(d.promptFeedback?.blockReason || cand?.finishReason || 'пустой ответ', 'empty');
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw new AiError('ответ оборвался', 'empty'); }   // недописанный JSON — пусть ответит другая модель
  }, onRetry);
}

/* История для собеседника: только тексты, без записей голоса */
function historyContents() {
  const out = [];
  for (const m of chat.msgs.slice(-HISTORY_TURNS)) {
    if (m.kind === 'user') out.push({ role: 'user', parts: [{ text: m.fb?.original || '' }] });
    if (m.kind === 'bot') out.push({ role: 'model', parts: [{ text: m.text }] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* ------------------------------ Запись ------------------------------ */

/* Любой формат записи (webm у Chrome, mp4 у Safari) → WAV 16 кГц моно: его точно понимает Gemini */
async function toWav16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const pcm16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return { wav: wavBlob(new Uint8Array(pcm16.buffer), rate), seconds: decoded.duration };
}

/* 16-битный PCM моно (little-endian) → WAV-файл */
function wavBlob(bytes, rate) {
  const head = new DataView(new ArrayBuffer(44));
  const str4 = (o, s) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  str4(0, 'RIFF'); head.setUint32(4, 36 + bytes.length, true); str4(8, 'WAVE');
  str4(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  str4(36, 'data'); head.setUint32(40, bytes.length, true);
  return new Blob([head.buffer, bytes], { type: 'audio/wav' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

const rec = { media: null, stream: null, chunks: [], started: 0, timer: null, cancelled: false };

async function startRecording() {
  unlockSpeech();
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Нет доступа к микрофону — разреши его в настройках браузера');
    return;
  }
  rec.chunks = [];
  rec.cancelled = false;
  rec.media = new MediaRecorder(rec.stream);
  rec.media.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
  rec.media.onstop = onRecorded;
  rec.media.start();
  rec.started = Date.now();
  rec.timer = setInterval(tickRecording, 200);
  setComposer('recording');
}

function tickRecording() {
  const sec = (Date.now() - rec.started) / 1000;
  const t = $('#rec-time');
  if (t) t.textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  if (sec >= MAX_RECORD_SEC) stopRecording(false);
}

function stopRecording(cancel) {
  if (!rec.media || rec.media.state === 'inactive') return;
  rec.cancelled = cancel;
  clearInterval(rec.timer);
  rec.media.stop();
  rec.stream.getTracks().forEach(t => t.stop());
}

async function onRecorded() {
  if (rec.cancelled) { setComposer('idle'); return; }
  const blob = new Blob(rec.chunks, { type: rec.media.mimeType || 'audio/webm' });
  if (Date.now() - rec.started < 700) { toast('Слишком коротко — нажми, скажи фразу и нажми ещё раз'); setComposer('idle'); return; }
  try {
    const { wav, seconds } = await toWav16k(blob);
    await sendTurn({ audio: wav, audioUrl: URL.createObjectURL(blob), seconds });
  } catch (e) {
    console.warn('audio', e);
    toast('Не удалось обработать запись');
    setComposer('idle');
  }
}

/* ------------------------------ Озвучка ----------------------------- */

/* Голоса Google (озвучивает Gemini, ~3 с на реплику) и запасной — голос телефона */
const VOICES = {
  Aoede: 'Аоэда — женский, мягкий',
  Kore: 'Кора — женский, уверенный',
  Leda: 'Леда — женский, молодой',
  Puck: 'Пак — мужской, бодрый',
  Charon: 'Харон — мужской, спокойный',
  Fenrir: 'Фенрир — мужской, энергичный',
  device: 'Голос телефона (без интернета)',
};

const player = new Audio();
const voiceCache = new Map();   // id реплики → ссылка на её озвучку (до перезагрузки страницы)

/* iOS разрешает звук только после касания: в момент нажатия «разблокируем» и плеер, и голос телефона */
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked) return;
  speechUnlocked = true;
  player.src = URL.createObjectURL(wavBlob(new Uint8Array(480), 24000));   // 10 мс тишины
  player.play().catch(() => {});
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

/* Текст → голос Google. Ответ приходит как сырой PCM (audio/L16;rate=24000) или сразу WAV */
async function synth(text, voice) {
  const body = {
    contents: [{ parts: [{ text: 'Say in a warm, natural, friendly conversational tone: ' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  return raceModels(byHealth(await listTtsModels()).slice(0, 3), async (model, signal) => {
    const d = await geminiFetch(`/models/${model}:generateContent`, body, signal);
    const data = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!data) throw new AiError('пустая озвучка', 'empty');
    const bytes = Uint8Array.from(atob(data.data), c => c.charCodeAt(0));
    if (/wav/i.test(data.mimeType)) return new Blob([bytes], { type: 'audio/wav' });
    const rate = +(data.mimeType.match(/rate=(\d+)/) || [])[1] || 24000;
    return wavBlob(bytes, rate);
  });
}

let speakingId = null;
let loadingVoice = null;   // id реплики, для которой сейчас готовится озвучка

async function speakReply(msg) {
  // повторное нажатие — стоп
  if (speakingId === msg.id || loadingVoice === msg.id) { stopSpeaking(); return; }
  stopSpeaking();
  if (ai.voice === 'device') { speakDevice(msg); return; }

  let url = voiceCache.get(msg.id);
  if (!url) {
    loadingVoice = msg.id;
    setSpeaking(null);
    try {
      url = URL.createObjectURL(await synth(msg.text, ai.voice));
      voiceCache.set(msg.id, url);
    } catch (e) {
      console.warn('tts', e);
      loadingVoice = null;
      toast('Голос Google сейчас недоступен — читаю голосом телефона');
      speakDevice(msg);
      return;
    }
    if (loadingVoice !== msg.id) return;    // пока готовилось, нажали на другую реплику
    loadingVoice = null;
  }
  player.src = url;
  player.playbackRate = ai.rate;
  player.onended = player.onpause = () => { if (speakingId === msg.id) setSpeaking(null); };
  setSpeaking(msg.id);
  player.play().catch(() => { setSpeaking(null); toast('Нажми ▶, чтобы послушать'); });
}

function speakDevice(msg) {
  if (!('speechSynthesis' in window)) { toast('Озвучка не поддерживается браузером'); return; }
  const u = new SpeechSynthesisUtterance(msg.text);
  u.lang = 'en-US';
  if (enVoice) u.voice = enVoice;
  u.rate = ai.rate * 0.95;
  u.onend = u.onerror = () => { if (speakingId === msg.id) setSpeaking(null); };
  setSpeaking(msg.id);
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  loadingVoice = null;
  player.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  setSpeaking(null);
}

function setSpeaking(id) {
  speakingId = id;
  document.querySelectorAll('.voice').forEach(el => {
    const on = el.dataset.id === id, wait = el.dataset.id === loadingVoice;
    el.classList.toggle('playing', on);
    el.classList.toggle('loading', wait);
    el.querySelector('.play').innerHTML = wait ? '<span class="spin"></span>' : on ? CHAT_ICON.stop : CHAT_ICON.play;
    el.querySelector('.play').setAttribute('aria-label', wait ? 'Готовлю голос' : on ? 'Остановить' : 'Прослушать');
  });
}

/* ------------------------- Разница фраз ----------------------------- */

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const NO_SPACE_BEFORE = new Set([...".,!?;:)%'’…"]);

function joinTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    const first = t.replace(/^(<\/?[bs]>)+/, '')[0];
    if (out && !NO_SPACE_BEFORE.has(first) && !out.replace(/(<\/?[bs]>)+$/, '').endsWith('(')) out += ' ';
    out += t;
  }
  return out;
}

/* Исправленная фраза: удалённое зачёркнуто, добавленное жирным. Сравнение по словам через НОП */
function diffHTML(original, corrected) {
  const a = original.match(TOKEN_RE) || [], b = corrected.match(TOKEN_RE) || [];
  const A = a.map(t => t.toLowerCase()), B = b.map(t => t.toLowerCase());   // регистр не считаем ошибкой
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const parts = [];
  let del = [], ins = [];
  const flush = () => {
    if (del.length) parts.push('<s>' + esc(joinTokens(del)) + '</s>');
    if (ins.length) parts.push('<b>' + esc(joinTokens(ins)) + '</b>');
    del = []; ins = [];
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); parts.push(esc(b[j])); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) ins.push(b[j++]);
    else del.push(a[i++]);
  }
  flush();
  return joinTokens(parts);
}

/* ------------------------------ Диалог ------------------------------ */

let busy = false;

/* Неотправленные реплики: запись держим в памяти, чтобы повторить без перезаписи */
const pending = new Map();

async function sendTurn(payload) {
  const { text, audio, audioUrl, seconds } = payload;
  if (busy) return;
  busy = true;
  const user = { id: uid(), kind: 'user', voice: !!audio, seconds, audioUrl, text, fb: null };
  chat.msgs.push(user);
  setComposer('thinking');
  renderChat();

  try {
    // только запись, без текста: иначе модель иногда дописывает этот текст в расшифровку
    const parts = audio
      ? [{ inlineData: { mimeType: 'audio/wav', data: await blobToBase64(audio) } }]
      : [{ text }];
    const t = await generate([...historyContents(), { role: 'user', parts }], TURN_SCHEMA,
      () => setThinkingNote('Google медлит — спрашиваю ещё одну модель…'));
    const original = audio ? (t.transcript || '').trim() : text;
    user.fb = {
      original,
      diff: diffHTML(original, t.corrected || original),
      mistakes: Array.isArray(t.mistakes) ? t.mistakes : [],
      score: t.score, comment: t.score_comment, shown: '',
    };
    const bot = { id: uid(), kind: 'bot', text: t.reply, ru: t.reply_ru, view: '', gloss: alignGloss(t.reply, t.words) };
    if (typeof t.memory === 'string' && t.memory.trim()) chat.memory = t.memory.trim().slice(0, MEMORY_MAX);
    chat.msgs.push(bot);
    saveChat();
    renderChat();
    speakReply(bot);
  } catch (e) {
    console.warn('turn', e);
    // реплика остаётся в разговоре с кнопкой «Повторить»
    user.failed = e instanceof AiError ? e.message : 'Нет связи с нейросетью';
    pending.set(user.id, payload);
    renderChat();
    if (e.status === 401) openAiSettings();
  } finally {
    busy = false;
    setComposer('idle');
  }
}

async function askHelp(msg) {
  if (msg.help) { msg.helpOpen = !msg.helpOpen; renderMsg(msg); return; }
  msg.helpLoading = true;
  renderMsg(msg);
  try {
    const contents = historyContents();
    // спрашиваем про конкретную реплику: история обрезается на ней
    const upto = contents.findLastIndex(c => c.role === 'model' && c.parts[0].text === msg.text);
    const h = await generate([...contents.slice(0, upto + 1), { role: 'user', parts: [{ text: HELP_PROMPT }] }], HELP_SCHEMA);
    msg.help = h;
    msg.helpOpen = true;
    saveChat();
  } catch (e) {
    toast(e instanceof AiError ? e.message : 'Не получилось подсказать');
  } finally {
    msg.helpLoading = false;
    renderMsg(msg);
  }
}

/* ----------------------------- Отрисовка ---------------------------- */

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
// нейросеть иногда пишет слово вместе с точкой или запятой («day.») — сравниваем только буквы
const norm = w => w.toLowerCase().replace(/’/g, "'").replace(/[^a-z']/g, '');

/* Перевод слов от нейросети → по номеру слова в тексте. Нейросеть может пропустить или
 * склеить слово, поэтому сверяем сами слова и ищем совпадение чуть впереди */
function alignGloss(text, words) {
  const list = Array.isArray(words) ? words : [];
  let k = 0;
  return [...text.matchAll(WORD_RE)].map(m => {
    for (let d = 0; d < 3 && k + d < list.length; d++) {
      if (norm(list[k + d].word || '') === norm(m[0])) {
        const g = list[k + d];
        k += d + 1;
        return { lemma: g.lemma || m[0], ru: g.ru || '' };
      }
    }
    return null;
  });
}

/* Слово в контексте: перевод от нейросети, иначе встроенный словарь */
function wordInfo(m, i, w) {
  const g = m.gloss?.[i];
  const hit = localLookup(g?.lemma || w) || localLookup(w);
  return {
    lemma: (g?.lemma || hit?.fixed || w).toLowerCase(),
    ru: g?.ru || (hit ? hit.ru.split(/[,;(]/)[0].trim() : ''),
    hit,
  };
}

function isSaved(lemma, w = lemma) {
  const l = lemma.toLowerCase(), s = w.toLowerCase();
  return state.words.some(x => { const e = x.en.toLowerCase(); return e === l || e === s; });
}

function wordsHTML(m, showGloss) {
  let out = '', pos = 0, i = 0;
  for (const match of m.text.matchAll(WORD_RE)) {
    out += esc(m.text.slice(pos, match.index));
    const w = match[0];
    const info = wordInfo(m, i, w);
    out += `<span class="tw${isSaved(info.lemma, w) ? ' saved' : ''}" data-i="${i}" role="button" tabindex="0">${esc(w)}`
      + (showGloss ? `<small>${esc(info.ru || '·')}</small>` : '') + '</span>';
    pos = match.index + w.length;
    i++;
  }
  return out + esc(m.text.slice(pos));
}

function fbHTML(m) {
  const f = m.fb;
  const head = f.mistakes.length
    ? `<p class="fix">💡 ${f.diff}</p>`
    : `<p class="fix">💡 ${esc(f.original)}</p><p class="fine">${ICON.check}Без ошибок!</p>`;
  const explain = f.shown.includes('x') && f.mistakes.length ? `<ul class="why">${f.mistakes.map(x =>
    `<li><s>${esc(x.wrong)}</s> → <b>${esc(x.right)}</b><span>${esc(x.why)}</span></li>`).join('')}</ul>` : '';
  const score = f.shown.includes('s') ? `<div class="score"><b>${esc(f.score)}/10</b><span>${esc(f.comment)}</span></div>` : '';
  const btns = [
    f.mistakes.length && !f.shown.includes('x') ? `<button class="chip" data-act="explain">Объяснить</button>` : '',
    !f.shown.includes('s') ? `<button class="chip" data-act="score">Оценка</button>` : '',
  ].join('');
  return `<div class="bubble fb">${head}${explain}${score}${btns ? `<div class="chips">${btns}</div>` : ''}</div>`;
}

function msgHTML(m) {
  if (m.kind === 'user') {
    const len = m.seconds ? `${Math.floor(m.seconds / 60)}:${String(Math.round(m.seconds % 60)).padStart(2, '0')}` : '';
    const mine = m.voice
      ? `<div class="bubble mine voice-mine">${m.audioUrl
          ? `<button class="play" data-act="mine" aria-label="Послушать себя">${CHAT_ICON.play}</button>`
          : CHAT_ICON.mic}<span class="bars" aria-hidden="true">${'<i></i>'.repeat(14)}</span><span class="len">${len}</span></div>`
      : `<div class="bubble mine">${esc(m.fb?.original || m.text || '…')}</div>`;
    const fb = m.fb ? fbHTML(m)
      : m.failed ? `<div class="bubble fb failed"><p>⚠️ ${esc(m.failed)}</p><div class="chips">
          <button class="chip" data-act="retry">Повторить</button>
          <button class="chip ghost" data-act="drop">Удалить</button></div></div>`
      : `<div class="bubble fb thinking"><span class="dots3"><i></i><i></i><i></i></span> Слушаю…</div>`;
    return `<div class="msg user" data-id="${m.id}">${mine}${fb}</div>`;
  }
  const v = m.view;
  const text = v ? `<div class="reply-text${v.includes('g') ? ' gloss' : ''}">${wordsHTML(m, v.includes('g'))}</div>
      ${v.includes('r') ? `<p class="reply-ru">${esc(m.ru)}</p>` : ''}
      <div class="chips">
        <button class="chip" data-act="gloss">${v.includes('g') ? 'Скрыть перевод слов' : 'Перевести по словам'}</button>
        <button class="chip" data-act="whole">${v.includes('r') ? 'Скрыть перевод' : 'Перевод целиком'}</button>
      </div>` : '';
  const help = m.helpOpen && m.help ? `<div class="help">${m.help.answers.map((a, i) =>
      `<div class="ans"><b>${i + 1}. ${esc(a.en)}</b><span>${esc(a.ru)}</span></div>`).join('')}
      <p class="tip">🧩 ${esc(m.help.tip)}</p></div>` : '';
  return `<div class="msg bot" data-id="${m.id}">
    <div class="bubble voice${speakingId === m.id ? ' playing' : ''}${loadingVoice === m.id ? ' loading' : ''}" data-id="${m.id}">
      <button class="play" data-act="play" aria-label="Прослушать">${loadingVoice === m.id ? '<span class="spin"></span>'
        : speakingId === m.id ? CHAT_ICON.stop : CHAT_ICON.play}</button>
      <span class="bars" aria-hidden="true">${'<i></i>'.repeat(18)}</span>
    </div>
    ${text}${help}
    <div class="chips">
      ${v ? '' : `<button class="chip" data-act="text">Текст</button>`}
      <button class="chip" data-act="help"${m.helpLoading ? ' disabled' : ''}>${m.helpLoading ? 'Думаю…' : m.helpOpen ? 'Скрыть помощь' : 'Помощь'}</button>
    </div>
  </div>`;
}

function renderMsg(m) {
  const el = document.querySelector(`.msg[data-id="${m.id}"]`);
  if (el) el.outerHTML = msgHTML(m);
}

function renderChat() {
  const root = $('#chat-root');
  if (!ai.key) { root.innerHTML = setupHTML(); return; }
  const thread = chat.msgs.length ? chat.msgs.map(msgHTML).join('') : `<div class="chat-empty">
      <p><b>Поговори со мной по-английски</b></p>
      <p class="muted small">Нажми на микрофон, скажи фразу и нажми ещё раз. Например: <i>“Hi! I want to practise my English.”</i></p>
      <p class="muted small">Я исправлю ошибки и отвечу голосом. Текст ответа — по кнопке «Текст», слова из него сохраняются в «Мои слова».</p>
    </div>`;
  root.innerHTML = `<div class="chat-thread">${thread}</div>`;
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}

function setupHTML() {
  return `<div class="card setup rise">
    <h2>Подключи нейросеть</h2>
    <p>Собеседник работает на <b>Google Gemini</b>. Для него нужен бесплатный ключ — это займёт минуту:</p>
    <ol>
      <li>Открой <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> и войди через Google-аккаунт.</li>
      <li>Нажми <b>Create API key</b> и скопируй ключ.</li>
      <li>Вставь его сюда.</li>
    </ol>
    <form id="key-form" class="form-grid" autocomplete="off">
      <label for="ai-key" class="sr-only">Ключ Gemini API</label>
      <input id="ai-key" type="text" placeholder="Вставь ключ сюда" autocapitalize="none" spellcheck="false" required>
      <button class="btn primary" type="submit">Сохранить</button>
    </form>
    <p class="muted small">Ключ хранится только на этом телефоне. На бесплатном тарифе есть лимит запросов в день,
      и Google может использовать тексты бесплатного тарифа для улучшения своих моделей — не рассказывай собеседнику личного.</p>
  </div>`;
}

/* ----------------------------- Композер ---------------------------- */

let typing = false;

function setComposer(mode) {
  const c = $('#composer');
  if (!c) return;
  c.hidden = !ai.key;
  c.dataset.mode = mode;
  if (mode === 'recording') {
    c.innerHTML = `<button class="icon-btn" data-act="cancel" aria-label="Отменить">${CHAT_ICON.close}</button>
      <div class="rec"><i class="rec-dot"></i><span id="rec-time">0:00</span><span class="muted small">Говори… нажми, чтобы отправить</span></div>
      <button class="mic on" data-act="stop" aria-label="Отправить">${CHAT_ICON.send}</button>`;
  } else if (mode === 'thinking') {
    c.innerHTML = `<div class="rec muted"><span class="dots3"><i></i><i></i><i></i></span><span id="think-note">Собеседник думает…</span></div>`;
  } else if (typing) {
    c.innerHTML = `<button class="icon-btn" data-act="voice" aria-label="Голосом">${CHAT_ICON.mic}</button>
      <form id="type-form" class="type-form" autocomplete="off">
        <label for="type-in" class="sr-only">Сообщение</label>
        <input id="type-in" type="text" placeholder="Напиши по-английски…" enterkeyhint="send">
        <button class="mic small" type="submit" aria-label="Отправить">${CHAT_ICON.send}</button>
      </form>`;
    $('#type-in').focus();
  } else {
    c.innerHTML = `<button class="icon-btn" data-act="type" aria-label="Написать текстом">${CHAT_ICON.keyboard}</button>
      <button class="mic" data-act="record" aria-label="Записать голосовое">${CHAT_ICON.mic}</button>
      <button class="icon-btn" data-act="settings" aria-label="Настройки собеседника">${CHAT_ICON.gear}</button>`;
  }
}

function setThinkingNote(text) {
  const el = $('#think-note');
  if (el) el.textContent = text;
}

/* ----------------------------- Карточка слова ----------------------- */

async function openWord(m, i) {
  await loadDict().catch(() => {});
  const w = [...m.text.matchAll(WORD_RE)][i]?.[0];
  if (!w) return;
  const { lemma, ru, hit } = wordInfo(m, i, w);
  const saved = isSaved(lemma, w);
  openModal(lemma, `
    ${lemma !== w.toLowerCase() ? `<p class="muted small" style="margin:0">в тексте: ${esc(w)}</p>` : ''}
    ${hit?.phon && !lemma.includes(' ') ? `<p class="word-phon" style="margin:4px 0 0">${esc(hit.phon)}</p>` : ''}
    <p class="word-ru" id="w-ru">${ru ? esc(ru) : '<span class="loading">Перевожу…</span>'}</p>
    <div class="row2" style="margin-top:16px">
      <button class="btn" data-act="say">${ICON.say}Произнести</button>
      <button class="btn primary" data-act="add" ${saved ? 'disabled' : ''}>${CHAT_ICON.bookmark}${saved ? 'В словаре' : 'В словарь'}</button>
    </div>`);
  $('#modal-body').onclick = async e => {
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'say') speak(lemma);
    if (btn?.dataset.act === 'add') {
      // есть во встроенном словаре — перевод с вариантами и примерами подставит приложение,
      // нет (фраза) — сохраняем перевод из контекста
      await addWord(lemma, localLookup(lemma) ? '' : $('#w-ru').textContent);
      btn.disabled = true;
      btn.innerHTML = CHAT_ICON.bookmark + 'В словаре';
      renderMsg(m);
      toast(`«${lemma}» — в словаре`);
    }
  };
  if (!ru) {
    try { $('#w-ru').textContent = (await translate(lemma)).main; }
    catch { $('#w-ru').textContent = 'Перевод не найден — сохрани слово, перевод подтянется позже'; }
  }
}

/* ----------------------------- Настройки ---------------------------- */

async function openAiSettings() {
  $('#modal-body').onclick = null;
  openModal('Собеседник', `<form id="ai-form" class="form-grid" autocomplete="off">
      <label for="ai-key2">Ключ Gemini API</label>
      <input id="ai-key2" type="text" value="${esc(ai.key)}" autocapitalize="none" spellcheck="false">
      <label for="ai-model">Модель</label>
      <select id="ai-model"><option value="">Автоматически (рекомендую)</option></select>
      <label for="ai-voice">Голос собеседника</label>
      <div class="voice-pick">
        <select id="ai-voice">${Object.entries(VOICES).map(([k, v]) =>
          `<option value="${k}" ${k === ai.voice ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <button class="btn" type="button" id="voice-try">${CHAT_ICON.play}Послушать</button>
      </div>
      <label for="ai-rate">Скорость речи: <span id="rate-val">${ai.rate}</span></label>
      <input id="ai-rate" type="range" min="0.6" max="1.2" step="0.05" value="${ai.rate}">
      <label for="ai-memory">Что собеседник помнит о тебе</label>
      <textarea id="ai-memory" rows="5" placeholder="Пока ничего — расскажи о себе в разговоре">${esc(chat.memory)}</textarea>
      <button class="btn primary" type="submit">Сохранить</button>
      <button class="btn" type="button" id="chat-clear">Начать разговор заново</button>
      <button class="btn danger" type="button" id="chat-forget">Забыть всё обо мне</button>
    </form>
    <p class="muted small">«Автоматически» — сначала самая быстрая модель, которая сейчас отвечает; если Google
      перегружен или кончился лимит, я сам попробую другую. Lite — быстрее, обычный Flash — точнее, но чаще перегружен.</p>`);
  $('#ai-rate').oninput = e => { $('#rate-val').textContent = e.target.value; };
  $('#voice-try').onclick = () => {
    unlockSpeech();
    const voice = $('#ai-voice').value;
    const sample = { id: 'sample-' + voice, text: "Hi! I'm your English buddy. What would you like to talk about today?" };
    const was = ai.voice;
    ai.voice = voice;              // пробуем выбранный голос, не сохраняя его
    speakReply(sample).finally(() => { ai.voice = was; });
  };
  $('#chat-clear').onclick = () => {
    if (!confirm('Начать новый разговор? Сообщения удалятся, но собеседник запомнит главное о тебе.')) return;
    chat.msgs = [];
    saveChat();
    closeModal();
    renderChat();
  };
  $('#chat-forget').onclick = () => {
    if (!confirm('Удалить разговор и всё, что собеседник помнит о тебе?')) return;
    chat.msgs = [];
    chat.memory = '';
    saveChat();
    closeModal();
    renderChat();
  };
  $('#ai-form').onsubmit = e => {
    e.preventDefault();
    const key = $('#ai-key2').value.trim();
    if (key !== ai.key) { ai.key = key; modelsCache = null; allModels = null; }
    ai.model = $('#ai-model').value;
    ai.rate = parseFloat($('#ai-rate').value);
    if ($('#ai-voice').value !== ai.voice) voiceCache.clear();
    ai.voice = $('#ai-voice').value;
    chat.memory = $('#ai-memory').value.trim().slice(0, MEMORY_MAX);
    saveAi();
    saveChat();
    closeModal();
    renderChat();
    setComposer('idle');
    toast('Сохранено');
  };
  try {
    modelsCache ??= await listModels();
    const ms = m => health[m]?.ms ? ` · ~${Math.round(health[m].ms / 1000)} с` : '';
    $('#ai-model').innerHTML = '<option value="">Автоматически (рекомендую)</option>' + modelsCache.map(m =>
      `<option value="${esc(m)}" ${m === ai.model ? 'selected' : ''}>${esc(m)}${ms(m)}</option>`).join('');
  } catch (e) {
    if (ai.model) $('#ai-model').insertAdjacentHTML('beforeend', `<option value="${esc(ai.model)}" selected>${esc(ai.model)}</option>`);
  }
}

/* ------------------------------ События ----------------------------- */

$('#chat-root').addEventListener('click', e => {
  const msgEl = e.target.closest('.msg');
  const m = msgEl && chat.msgs.find(x => x.id === msgEl.dataset.id);
  if (!m) return;
  const tw = e.target.closest('.tw');
  if (tw) { openWord(m, +tw.dataset.i); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'explain' || act === 'score') {
    m.fb.shown += act === 'explain' ? 'x' : 's';
    saveChat(); renderMsg(m);
  }
  if (act === 'mine' && m.audioUrl) new Audio(m.audioUrl).play();
  if (act === 'play') speakReply(m);
  if (act === 'text') { m.view = 't'; saveChat(); renderMsg(m); }
  if (act === 'gloss' || act === 'whole') {
    const flag = act === 'gloss' ? 'g' : 'r';
    m.view = m.view.includes(flag) ? m.view.replace(flag, '') : m.view + flag;
    saveChat();
    if (flag === 'g' && !DICT) loadDict().then(() => renderMsg(m));
    renderMsg(m);
  }
  if (act === 'help') askHelp(m);
  if (act === 'retry' || act === 'drop') {
    const payload = pending.get(m.id);
    pending.delete(m.id);
    chat.msgs = chat.msgs.filter(x => x !== m);
    renderChat();
    if (act === 'retry' && payload) sendTurn(payload);
  }
});

$('#chat-root').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('tw')) {
    e.preventDefault();
    const m = chat.msgs.find(x => x.id === e.target.closest('.msg').dataset.id);
    if (m) openWord(m, +e.target.dataset.i);
  }
});

$('#chat-root').addEventListener('submit', e => {
  if (e.target.id !== 'key-form') return;
  e.preventDefault();
  ai.key = $('#ai-key').value.trim();
  modelsCache = null;
  allModels = null;
  saveAi();
  renderChat();
  setComposer('idle');
});

$('#composer').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'record') startRecording();
  if (act === 'stop') stopRecording(false);
  if (act === 'cancel') stopRecording(true);
  if (act === 'settings') openAiSettings();
  if (act === 'type') { typing = true; setComposer('idle'); }
  if (act === 'voice') { typing = false; setComposer('idle'); }
});

$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#type-in').value.trim();
  if (!text) return;
  unlockSpeech();
  sendTurn({ text });
});

restoreKey();

function showChat() {
  renderChat();
  setComposer(busy ? 'thinking' : 'idle');
  loadDict().catch(() => {});
}
