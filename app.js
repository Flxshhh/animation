'use strict';

/* =====================================================================
 * Мои слова — PWA для изучения английских слов.
 * Данные хранятся в localStorage телефона, сервер не нужен.
 * Работает без интернета: перевод, транскрипция и примеры берутся из
 * встроенного словаря dict/*.json (собран tools/build_dict.py из
 * OpenRussian, CMU Pronouncing Dictionary и WordNet), а service worker
 * кэширует приложение и словарь на телефоне.
 * Если слова нет в словаре и есть интернет — запасные бесплатные API:
 *   - Google Translate (неофициальный endpoint gtx) — перевод + варианты
 *   - MyMemory — запасной переводчик
 *   - dictionaryapi.dev — транскрипция (IPA), аудио, примеры употребления
 * Произношение — Web Speech API (speechSynthesis) самого телефона.
 * ===================================================================== */

const STORE_KEY = 'wordbook.v1';
const MAX_LEVEL = 5;          // уровень знания 0..5, на 5 слово считается выученным
const LEVEL_NAMES = ['Новое', 'Видел', 'Знакомо', 'Помню', 'Почти', 'Выучено'];

/* ---------------------------- Хранилище ---------------------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { words: s.words || [], history: s.history || {}, settings: s.settings || {} };
    }
  } catch (e) { console.warn('load failed', e); }
  return { words: [], history: {}, settings: {} };
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Не удалось сохранить: ' + e.message); }
}

let state = loadState();

/* ----------------------------- Утилиты ----------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function todayKey(d = new Date()) {
  // локальная дата YYYY-MM-DD (toISOString дал бы UTC и «сдвинул» день)
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* Расстояние Левенштейна — чтобы засчитывать ответ с одной опечаткой */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/* ------------------------ Перевод и словарь ------------------------ */

/**
 * Переводит текст. Возвращает { main, alts: [{pos, terms[]}] }.
 * Сначала Google (даёт варианты по частям речи), при ошибке — MyMemory.
 */
async function translate(text, sl = 'en', tl = 'ru') {
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dj=1'
      + `&sl=${sl}&tl=${tl}&hl=ru&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
    const d = await fetchJSON(url);
    const main = (d.sentences || []).map(s => s.trans || '').join('').trim();
    const alts = (d.dict || []).map(x => ({ pos: x.pos || '', terms: (x.terms || []).slice(0, 6) }));
    if (main) return { main, alts };
  } catch (e) { console.warn('google translate failed', e); }

  const url = 'https://api.mymemory.translated.net/get?q='
    + encodeURIComponent(text) + `&langpair=${sl}|${tl}`;
  const d = await fetchJSON(url);
  const main = (d.responseData?.translatedText || '').trim();
  if (!main || /MYMEMORY WARNING/i.test(main)) throw new Error('Перевод не найден');
  // соберём ещё несколько уникальных вариантов из «matches»
  const extra = [...new Set((d.matches || [])
    .map(m => (m.translation || '').trim().toLowerCase())
    .filter(t => t && t !== main.toLowerCase() && t.length < 40))].slice(0, 5);
  return { main, alts: extra.length ? [{ pos: '', terms: extra }] : [] };
}

/**
 * Словарная статья с dictionaryapi.dev: транскрипция, аудио, примеры.
 * Возвращает null, если слова нет в словаре (например, это фраза).
 */
async function lookupDictionary(word) {
  try {
    const d = await fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/'
      + encodeURIComponent(word.toLowerCase()));
    if (!Array.isArray(d)) return null;

    let phon = '', audio = '';
    const examples = [];
    for (const entry of d) {
      for (const p of entry.phonetics || []) {
        if (!phon && p.text) phon = p.text;
        // предпочитаем американское/британское аудио, если есть
        if (!audio && p.audio) audio = p.audio;
      }
      if (!phon && entry.phonetic) phon = entry.phonetic;
      for (const m of entry.meanings || []) {
        for (const def of m.definitions || []) {
          examples.push({
            pos: m.partOfSpeech || '',
            def: def.definition || '',
            en: def.example || '',
          });
        }
      }
    }
    return { phon, audio, examples };
  } catch (e) {
    return null;
  }
}

/* ---------------------- Встроенный словарь ------------------------- */
/* ru.json:   "run" → "гл:бежа́ть;сущ:ход;…"   (часть речи:перевод, по убыванию частоты)
 * pron.json: "water" → "/ˈwɔtɚ/|уОтэр"        (IPA | по-русски, ударный слог заглавными)
 * ex.json:   "water" → ["Water the fields", …] (английские примеры из WordNet) */

let DICT = null;
let dictPromise = null;
const POS_RU = { 'сущ': 'сущ.', 'гл': 'гл.', 'прил': 'прил.' };

function loadDict() {
  if (!dictPromise) {
    dictPromise = Promise.all(['ru', 'pron', 'ex'].map(n =>
      fetch(`dict/${n}.json`).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })))
      .then(([ru, pron, ex]) => { DICT = { ru, pron, ex }; return DICT; })
      .catch(e => { dictPromise = null; throw e; });
  }
  return dictPromise;
}

/* Неправильные глаголы и формы, которые не сводятся к словарной форме правилами */
const IRREGULAR = {
  went: 'go', gone: 'go', was: 'be', were: 'be', been: 'be', is: 'be', are: 'be', am: 'be',
  had: 'have', has: 'have', did: 'do', done: 'do', does: 'do', said: 'say', made: 'make',
  took: 'take', taken: 'take', saw: 'see', seen: 'see', came: 'come', got: 'get', gotten: 'get',
  gave: 'give', given: 'give', knew: 'know', known: 'know', told: 'tell', found: 'find',
  felt: 'feel', brought: 'bring', began: 'begin', begun: 'begin', kept: 'keep', held: 'hold',
  wrote: 'write', written: 'write', stood: 'stand', heard: 'hear', meant: 'mean', met: 'meet',
  ran: 'run', paid: 'pay', sat: 'sit', spoke: 'speak', spoken: 'speak', led: 'lead', grew: 'grow',
  grown: 'grow', lost: 'lose', fell: 'fall', fallen: 'fall', sent: 'send', built: 'build',
  understood: 'understand', drew: 'draw', drawn: 'draw', broke: 'break', broken: 'break',
  spent: 'spend', rose: 'rise', drove: 'drive', driven: 'drive', bought: 'buy', wore: 'wear',
  worn: 'wear', chose: 'choose', chosen: 'choose', threw: 'throw', thrown: 'throw', caught: 'catch',
  taught: 'teach', ate: 'eat', eaten: 'eat', fought: 'fight', flew: 'fly', flown: 'fly', sang: 'sing',
  sung: 'sing', swam: 'swim', slept: 'sleep', sold: 'sell', won: 'win', forgot: 'forget',
  forgotten: 'forget', hid: 'hide', hidden: 'hide', woke: 'wake', woken: 'wake', shook: 'shake',
  children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', better: 'good', best: 'good', worse: 'bad', worst: 'bad',
};

/* Возможные словарные формы: cats → cat, running → run, studied → study… */
/* Формы, которые чаще ищут как самостоятельные слова: thought — «мысль», left — «левый» */
const STANDALONE = new Set(['thought', 'left', 'saw', 'felt', 'found', 'better', 'best', 'worse', 'worst',
  'people', 'children', 'men', 'women', 'feet', 'teeth', 'mice', 'geese', 'lay', 'hidden', 'broken', 'lost']);

function lemmaCandidates(w) {
  // went → go: у неправильных форм сначала начальная форма
  const out = IRREGULAR[w] && !STANDALONE.has(w) ? [IRREGULAR[w], w] : [w];
  const add = s => { if (s && s.length > 1 && !out.includes(s)) out.push(s); };
  if (IRREGULAR[w]) add(IRREGULAR[w]);
  if (w.includes(' ')) return out;
  const undouble = b => (/([bdgklmnprtz])\1$/.test(b) ? b.slice(0, -1) : b);
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { const b = w.slice(0, -2); add(b); add(b + 'e'); add(undouble(b)); }
  if (w.endsWith('ing')) { const b = w.slice(0, -3); add(b); add(b + 'e'); add(undouble(b)); }
  if (w.endsWith('ier')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('iest')) add(w.slice(0, -4) + 'y');
  if (w.endsWith('er')) { const b = w.slice(0, -2); add(b); add(b + 'e'); add(undouble(b)); }
  if (w.endsWith('est')) { const b = w.slice(0, -3); add(b); add(b + 'e'); add(undouble(b)); }
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return out;
}

/** Статья из встроенного словаря или null, если слова там нет. */
function localLookup(en) {
  if (!DICT) return null;
  const q = en.toLowerCase().trim().replace(/[’`]/g, "'").replace(/^(to|a|an|the)\s+/, '');
  const key = lemmaCandidates(q).find(k => DICT.ru[k]);
  if (!key) return null;
  const items = DICT.ru[key].split(';').map(s => {
    const i = s.indexOf(':');
    return i > 0 ? { pos: s.slice(0, i), ru: s.slice(i + 1) } : { pos: '', ru: s };
  });
  const pron = key.split(' ').map(t => DICT.pron[t]);
  const known = pron.every(Boolean);
  return {
    fixed: key !== q ? key : '',
    ru: items[0].ru,
    alts: [{ pos: '', terms: items.slice(1).map(i => i.ru) }],
    pos: POS_RU[items[0].pos] || '',
    phon: known ? '/' + pron.map(p => p.split('|')[0].slice(1, -1)).join(' ') + '/' : '',
    ruPron: known ? pron.map(p => p.split('|')[1]).join(' ') : '',
    examples: (DICT.ex[key] || []).map(e => ({ pos: '', def: '', en: e })),
  };
}

/* -------------- Транскрипция IPA → русские буквы (≈) --------------- */
/* Это приблизительно: в русском нет многих английских звуков (θ, ð, æ…).
 * Порядок важен — сначала длинные сочетания, потом одиночные символы. */
const IPA_MAP = [
  ['aɪə', 'айэ'], ['aʊə', 'ауэ'], ['ɜːɹ', 'ёр'], ['ɜːr', 'ёр'],
  ['t͡ʃ', 'ч'], ['d͡ʒ', 'дж'], ['tʃ', 'ч'], ['dʒ', 'дж'],
  ['eɪ', 'эй'], ['aɪ', 'ай'], ['ɔɪ', 'ой'], ['aʊ', 'ау'], ['əʊ', 'оу'], ['oʊ', 'оу'],
  ['ɪə', 'иэ'], ['ɪɚ', 'иэр'], ['eə', 'еэ'], ['ɛə', 'еэ'], ['ɛɚ', 'еэр'], ['ʊə', 'уэ'], ['ʊɚ', 'уэр'],
  ['iː', 'и'], ['uː', 'у'], ['ɑː', 'а'], ['ɔː', 'о'], ['ɜː', 'ё'], ['ɝ', 'ёр'], ['ɚ', 'эр'],
  ['i', 'и'], ['ɪ', 'и'], ['e', 'е'], ['ɛ', 'е'], ['æ', 'э'], ['ʌ', 'а'], ['ɑ', 'а'], ['a', 'а'],
  ['ɒ', 'о'], ['ɔ', 'о'], ['o', 'о'], ['ʊ', 'у'], ['u', 'у'], ['ə', 'э'], ['ɐ', 'а'], ['ɜ', 'ё'],
  ['p', 'п'], ['b', 'б'], ['t', 'т'], ['d', 'д'], ['k', 'к'], ['g', 'г'], ['ɡ', 'г'],
  ['f', 'ф'], ['v', 'в'], ['θ', 'с'], ['ð', 'з'], ['s', 'с'], ['z', 'з'], ['ʃ', 'ш'], ['ʒ', 'ж'],
  ['h', 'х'], ['x', 'х'], ['m', 'м'], ['n', 'н'], ['ŋ', 'нг'], ['l', 'л'], ['ɫ', 'л'],
  ['r', 'р'], ['ɹ', 'р'], ['ɾ', 'т'], ['j', 'й'], ['w', 'у'], ['ʔ', ''],
];

function ipaToCyr(ipa) {
  if (!ipa) return '';
  let s = ipa.split(/[,;]/)[0]
    .replace(/[\/\[\]()ˈˌ.ʰ‿ˑ]/g, '')
    .normalize('NFD').replace(/[̀-ͣ͡-ͯ]/g, '') // диакритика, кроме связки ͡
    .trim();
  let out = '';
  outer: while (s.length) {
    for (const [from, to] of IPA_MAP) {
      if (s.startsWith(from)) { out += to; s = s.slice(from.length); continue outer; }
    }
    if (s[0] === ' ') out += ' ';
    s = s.slice(1); // неизвестный символ (ː и т.п.) пропускаем
  }
  return out
    .replace(/(^|\s)е/g, '$1э')                                    // «egg» → эг, а не ег
    .replace(/(^|[бвгджзклмнпрстфхцчшщ])й([аэуе])/g,             // йу → ю, йа → я
      (_, pre, v) => pre + ({ а: 'я', у: 'ю', э: 'е', е: 'е' }[v]));
}

/* ---------------------------- Произношение -------------------------- */

let enVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  enVoice = voices.find(v => v.lang === 'en-US')
    || voices.find(v => v.lang === 'en-GB')
    || voices.find(v => v.lang && v.lang.startsWith('en')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text, audioUrl) {
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    if (enVoice) u.voice = enVoice;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } else if (audioUrl) {
    new Audio(audioUrl).play().catch(() => toast('Не удалось воспроизвести'));
  } else {
    toast('Озвучка не поддерживается браузером');
  }
}

/* ----------------------------- Слова ------------------------------- */

function findWord(id) { return state.words.find(w => w.id === id); }

async function addWord(en, ruManual) {
  en = en.trim().replace(/\s+/g, ' ');
  if (!en) return;
  if (state.words.some(w => w.en.toLowerCase() === en.toLowerCase())) {
    toast('Это слово уже есть в списке');
    return;
  }
  const w = {
    id: uid(), en, ru: ruManual || '', alts: [], phon: '', audio: '',
    examples: null, level: 0, correct: 0, wrong: 0,
    added: Date.now(), lastSeen: 0, pending: true,
  };
  state.words.unshift(w);
  saveState();
  renderWords();
  await enrichWord(w, !ruManual);
}

/* Русская транскрипция: из словаря, иначе грубо из IPA */
function pronCyr(w) { return w.ruPron || ipaToCyr(w.phon); }

/**
 * Догружает перевод, транскрипцию и примеры для слова.
 * Сначала встроенный словарь (работает без интернета), потом онлайн-API.
 */
async function enrichWord(w, needTranslation = true) {
  w.pending = true;
  renderWords();

  try { await loadDict(); } catch (e) { console.warn('dict', e); }
  const local = localLookup(w.en);
  if (local) {
    if (local.fixed && !state.words.some(x => x !== w && x.en.toLowerCase() === local.fixed)) {
      toast(`Сохранено в словарной форме: ${w.en} → ${local.fixed}`);
      w.en = local.fixed;
    }
    if (needTranslation || !w.ru) w.ru = local.ru;
    Object.assign(w, { alts: local.alts, pos: local.pos, phon: local.phon, ruPron: local.ruPron,
      examples: local.examples, notFound: false, pending: false });
    saveState();
    renderWords();
    return;
  }

  if (!navigator.onLine) {
    // переведём позже, когда появится интернет (см. retryOffline)
    w.notFound = true;
    w.pending = false;
    saveState();
    renderWords();
    return;
  }

  const [tr, dict] = await Promise.allSettled([
    needTranslation ? translate(w.en) : Promise.resolve(null),
    lookupDictionary(w.en),
  ]);
  if (tr.status === 'fulfilled' && tr.value) {
    w.ru = tr.value.main;
    w.alts = tr.value.alts;
    w.notFound = false;
  } else if (needTranslation && !w.ru) {
    toast('Не удалось получить перевод — проверь интернет или впиши вручную (✎)');
  }
  if (dict.status === 'fulfilled' && dict.value) {
    w.phon = dict.value.phon;
    w.audio = dict.value.audio;
    w.examples = dict.value.examples.filter(e => e.en).slice(0, 8);
    w.defs = dict.value.examples.filter(e => !e.en).slice(0, 3);
  }
  w.pending = false;
  saveState();
  renderWords();
}

function deleteWord(id, ask = true) {
  const w = findWord(id);
  if (!w) return;
  if (ask && !confirm(`Удалить «${w.en}»?`)) return;
  state.words = state.words.filter(x => x.id !== id);
  saveState();
  renderWords();
  toast(`«${w.en}» удалено`);
}

function isLearned(w) { return w.level >= MAX_LEVEL; }

function dotsHTML(level) {
  let h = '<span class="dots" title="Уровень знания">';
  for (let i = 1; i <= MAX_LEVEL; i++) h += `<i class="${i <= level ? 'on' : ''}"></i>`;
  return h + '</span>';
}

function altsText(w) {
  const terms = [];
  for (const a of w.alts || []) {
    for (const t of a.terms) if (t.toLowerCase() !== (w.ru || '').toLowerCase()) terms.push(t);
  }
  return [...new Set(terms)].slice(0, 6).join(', ');
}

function renderWords() {
  const list = $('#word-list');
  const plainRu = s => (s || '').toLowerCase().replace(/́/g, '');   // без знаков ударения
  const q = plainRu($('#search').value.trim());
  const filter = $('#filter').value;

  const items = state.words.filter(w => {
    if (filter === 'learned' && !isLearned(w)) return false;
    if (filter === 'learning' && isLearned(w)) return false;
    if (q && !w.en.toLowerCase().includes(q) && !plainRu(w.ru).includes(q)) return false;
    return true;
  });

  const learned = state.words.filter(isLearned).length;
  $('#word-count').textContent = state.words.length
    ? `Всего: ${state.words.length} · выучено: ${learned}` : '';

  if (!state.words.length) {
    list.innerHTML = '<li class="empty">Пока пусто.<br>Впиши первое английское слово выше 👆</li>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<li class="empty">Ничего не найдено</li>';
    return;
  }

  list.innerHTML = items.map(w => {
    const phon = w.phon
      ? `<span class="word-phon">${esc(w.phon)} · ≈ [${esc(pronCyr(w))}]</span>` : '';
    const ru = w.pending && !w.ru ? '<span class="loading">перевожу…</span>'
      : w.ru ? esc(w.ru)
      : w.notFound ? '<span class="loading">нет во встроенном словаре — переведу, когда появится интернет (или впиши сам ✎)</span>'
      : '— нет перевода —';
    const alts = altsText(w);
    const learnedBanner = isLearned(w) ? `
      <div class="learned-banner">
        <span>🎉 Слово выучено!</span>
        <button class="btn danger" data-act="del" data-id="${w.id}">Удалить</button>
      </div>` : '';
    return `
      <li class="word ${isLearned(w) ? 'learned' : ''}">
        <div class="word-top">
          <span class="word-en">${esc(w.en)}</span>${w.pos ? `<span class="word-pos">${esc(w.pos)}</span>` : ''}${phon}
        </div>
        <div class="word-ru">${ru}</div>
        ${alts ? `<div class="word-alts">${esc(alts)}</div>` : ''}
        <div class="word-bottom">
          ${dotsHTML(w.level)}
          <div class="word-actions">
            <button class="icon-btn" data-act="say" data-id="${w.id}" aria-label="Произнести">🔊</button>
            <button class="ex-btn" data-act="ex" data-id="${w.id}">Примеры</button>
            <button class="icon-btn" data-act="edit" data-id="${w.id}" aria-label="Редактировать">✎</button>
            <button class="icon-btn" data-act="del" data-id="${w.id}" aria-label="Удалить">🗑</button>
          </div>
        </div>
        ${learnedBanner}
      </li>`;
  }).join('');
}

/* ------------------------- Модальное окно -------------------------- */

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* Подсветка самого слова внутри примера */
function highlight(sentence, word) {
  const safe = esc(sentence);
  const stem = word.toLowerCase().replace(/[^a-z' -]/g, '').replace(/e$/, '');
  if (stem.length < 2) return safe;
  const re = new RegExp(`\\b(${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi');
  return safe.replace(re, '<b>$1</b>');
}

async function showExamples(id) {
  const w = findWord(id);
  if (!w) return;
  openModal(w.en, '<p class="loading">Ищу примеры…</p>');

  // примеры кэшируются в слове; если их ещё нет — встроенный словарь, потом онлайн
  if (!w.examples || !w.examples.length) {
    try { await loadDict(); } catch (e) { /* без словаря — только онлайн */ }
    const local = localLookup(w.en);
    const dict = local && local.examples.length ? null : await lookupDictionary(w.en);
    if (local && local.examples.length) {
      w.examples = local.examples;
      saveState();
    } else if (dict) {
      w.examples = dict.examples.filter(e => e.en).slice(0, 8);
      w.defs = dict.examples.filter(e => !e.en).slice(0, 3);
      if (!w.phon) { w.phon = dict.phon; w.audio = dict.audio; }
      saveState();
    }
  }
  if ($('#modal').classList.contains('hidden') || $('#modal-title').textContent !== w.en) return;

  const ex = w.examples || [];
  const defs = w.defs || [];
  if (!ex.length && !defs.length) {
    $('#modal-body').innerHTML = `
      <p class="muted">Примеров в словаре не нашлось (так бывает с фразами и редкими словами).</p>
      <p class="muted small">Попробуй поискать примеры в контексте:</p>
      <a class="btn block" target="_blank" rel="noopener"
         href="https://context.reverso.net/перевод/английский-русский/${encodeURIComponent(w.en)}">Открыть Reverso Context ↗</a>`;
    return;
  }

  const exHTML = ex.map((e, i) => `
    <div class="example">
      ${e.pos ? `<div class="pos">${esc(e.pos)}</div>` : ''}
      <div class="def">${esc(e.def)}</div>
      <div class="sent">${highlight(e.en, w.en)}</div>
      <div class="tr" id="ex-tr-${i}">${e.ru ? esc(e.ru) : ''}</div>
      <div class="row">
        <button class="btn" data-say="${esc(e.en)}">🔊</button>
        ${e.ru ? '' : `<button class="btn" data-tr="${i}">Перевести</button>`}
      </div>
    </div>`).join('');

  const defHTML = !ex.length ? defs.map(d => `
    <div class="example">
      ${d.pos ? `<div class="pos">${esc(d.pos)}</div>` : ''}
      <div class="sent">${esc(d.def)}</div>
    </div>`).join('') : '';

  $('#modal-body').innerHTML = (ex.length ? '' : '<p class="muted small">Примеров нет, но есть определения:</p>')
    + exHTML + defHTML
    + `<p class="small"><a target="_blank" rel="noopener"
         href="https://context.reverso.net/перевод/английский-русский/${encodeURIComponent(w.en)}">Ещё примеры на Reverso Context ↗</a></p>`;

  $('#modal-body').onclick = async e => {
    const say = e.target.closest('[data-say]');
    if (say) { speak(say.dataset.say); return; }
    const trBtn = e.target.closest('[data-tr]');
    if (trBtn) {
      const i = +trBtn.dataset.tr;
      trBtn.disabled = true;
      trBtn.textContent = '…';
      try {
        const r = await translate(ex[i].en);
        ex[i].ru = r.main;
        saveState();
        $('#ex-tr-' + i).textContent = r.main;
        trBtn.remove();
      } catch {
        trBtn.disabled = false;
        trBtn.textContent = 'Перевести';
        toast(navigator.onLine ? 'Не удалось перевести' : 'Для перевода примера нужен интернет');
      }
    }
  };
}

function editWord(id) {
  const w = findWord(id);
  if (!w) return;
  openModal('Редактировать', `
    <form id="edit-form" class="form-grid">
      <label>Английский</label>
      <input type="text" id="ed-en" value="${esc(w.en)}" autocapitalize="none">
      <label>Перевод</label>
      <input type="text" id="ed-ru" value="${esc(w.ru)}">
      <button class="btn primary" type="submit">Сохранить</button>
      <button class="btn" type="button" id="ed-retr">🔄 Перевести заново</button>
      <button class="btn" type="button" id="ed-reset">Сбросить прогресс слова</button>
    </form>`);
  $('#edit-form').onsubmit = e => {
    e.preventDefault();
    const en = $('#ed-en').value.trim();
    const changedEn = en && en !== w.en;
    if (en) w.en = en;
    w.ru = $('#ed-ru').value.trim();
    saveState();
    closeModal();
    if (changedEn) { w.examples = null; enrichWord(w, false); } else renderWords();
  };
  $('#ed-retr').onclick = () => { closeModal(); enrichWord(w, true); };
  $('#ed-reset').onclick = () => {
    w.level = 0; w.correct = 0; w.wrong = 0;
    saveState(); closeModal(); renderWords(); toast('Прогресс сброшен');
  };
}

/* --------------------------- Обработчики --------------------------- */

$('#add-form').addEventListener('submit', e => {
  e.preventDefault();
  const en = $('#add-en').value;
  const ru = $('#add-ru').value.trim();
  $('#add-en').value = '';
  $('#add-ru').value = '';
  $('#add-en').focus();
  addWord(en, ru);
});

$('#search').addEventListener('input', renderWords);
$('#filter').addEventListener('change', renderWords);

$('#word-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'say') { const w = findWord(id); speak(w.en, w.audio); }
  if (act === 'ex') showExamples(id);
  if (act === 'edit') editWord(id);
  if (act === 'del') deleteWord(id);
});

/* ---------------------------- Вкладки ------------------------------ */

const TITLES = { words: 'Мои слова', train: 'Тренажёр', stats: 'Статистика' };

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#title').textContent = TITLES[name];
  if (name === 'words') renderWords();
  if (name === 'train' && !session) renderTrainHome();
  if (name === 'stats') renderStats();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tabbar button').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ============================ ТРЕНАЖЁР ============================= */

/*
 * Интервальное повторение, упрощённо:
 *   верный ответ → level + 1, ошибка → level − 1 (не ниже 0).
 * Слова выбираются случайно, но с весом: чем ниже уровень и чем дольше
 * слово не повторяли, тем выше шанс попасться.
 */
const MODES = {
  en_ru:  { ico: '🇬🇧→🇷🇺', name: 'Выбери перевод', desc: 'Английское слово → 4 варианта', min: 2 },
  ru_en:  { ico: '🇷🇺→🇬🇧', name: 'Обратный выбор', desc: 'Русское слово → 4 варианта', min: 2 },
  write:  { ico: '⌨️', name: 'Напиши по-английски', desc: 'Видишь перевод — пишешь слово', min: 1 },
  listen: { ico: '👂', name: 'На слух', desc: 'Слушаешь и выбираешь перевод', min: 2 },
  cards:  { ico: '🃏', name: 'Карточки', desc: 'Вспомни сам и честно оцени', min: 1 },
};

let session = null;
let sessionSize = 10;
let includeLearned = false;

function wordWeight(w) {
  const daysAgo = w.lastSeen ? (Date.now() - w.lastSeen) / 864e5 : 30;
  const levelFactor = (MAX_LEVEL + 1 - Math.min(w.level, MAX_LEVEL)) ** 2;  // 36 … 1
  return levelFactor * (1 + Math.min(daysAgo, 30) / 3);
}

/* Взвешенная выборка без повторений */
function pickWords(pool, n) {
  const items = pool.map(w => ({ w, k: Math.random() ** (1 / wordWeight(w)) }));
  items.sort((a, b) => b.k - a.k);
  return items.slice(0, n).map(x => x.w);
}

function trainPool() {
  return state.words.filter(w => w.ru && (includeLearned || !isLearned(w)));
}

function renderTrainHome() {
  const root = $('#train-root');
  const pool = trainPool();
  const allReady = state.words.filter(w => w.ru).length;

  if (!state.words.length) {
    root.innerHTML = '<div class="empty">Сначала добавь слова во вкладке «Слова» 📚</div>';
    return;
  }

  root.innerHTML = `
    <div class="card">
      <div class="small muted">Слов для тренировки: <b>${pool.length}</b>${allReady !== pool.length ? ` (выученные скрыты: ${allReady - pool.length})` : ''}</div>
      <div class="seg" id="size-seg">
        ${[5, 10, 20, 0].map(n => `<button data-n="${n}" class="${n === sessionSize ? 'on' : ''}">${n || 'Все'}</button>`).join('')}
      </div>
      <label class="small"><input type="checkbox" id="inc-learned" ${includeLearned ? 'checked' : ''}> Повторять и выученные слова</label>
    </div>
    <div class="modes">
      ${Object.entries(MODES).map(([key, m]) => `
        <button class="mode" data-mode="${key}" ${pool.length < m.min ? 'disabled' : ''}>
          <span class="ico">${m.ico}</span>
          <span><b>${m.name}</b><span class="small">${m.desc}</span></span>
        </button>`).join('')}
      <button class="mode" data-mode="mix" ${pool.length < 2 ? 'disabled' : ''}>
        <span class="ico">🔀</span>
        <span><b>Микс</b><span class="small">Все режимы вперемешку</span></span>
      </button>
    </div>`;

  $('#size-seg').onclick = e => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    sessionSize = +b.dataset.n;
    renderTrainHome();
  };
  $('#inc-learned').onchange = e => { includeLearned = e.target.checked; renderTrainHome(); };
  root.querySelectorAll('[data-mode]').forEach(b =>
    b.addEventListener('click', () => startSession(b.dataset.mode)));
}

function startSession(mode) {
  const pool = trainPool();
  const n = sessionSize || pool.length;
  const words = pickWords(pool, Math.min(n, pool.length));
  const modeKeys = ['en_ru', 'ru_en', 'write', 'listen'];
  session = {
    mode,
    queue: words.map(w => ({
      id: w.id,
      mode: mode === 'mix' ? modeKeys[Math.floor(Math.random() * modeKeys.length)] : mode,
    })),
    i: 0, correct: 0, wrong: 0, answered: false,
    mistakes: [], newlyLearned: [],
  };
  renderQuestion();
}

function endSession() {
  session = null;
  renderTrainHome();
}

/* Записать результат ответа в статистику */
function recordAnswer(w, ok) {
  const wasLearned = isLearned(w);
  w.level = ok ? Math.min(MAX_LEVEL, w.level + 1) : Math.max(0, w.level - 1);
  w[ok ? 'correct' : 'wrong']++;
  w.lastSeen = Date.now();

  const day = todayKey();
  const h = state.history[day] || (state.history[day] = { c: 0, w: 0 });
  h[ok ? 'c' : 'w']++;

  if (ok) session.correct++; else { session.wrong++; session.mistakes.push(w.id); }
  if (!wasLearned && isLearned(w)) session.newlyLearned.push(w.id);
  saveState();
}

function distractors(w, field, count = 3) {
  const others = state.words.filter(x => x.id !== w.id && x.ru
    && x[field].toLowerCase() !== w[field].toLowerCase());
  return [...new Set(shuffle(others).map(x => x[field]))].slice(0, count);
}

function renderQuestion() {
  const root = $('#train-root');
  if (session.i >= session.queue.length) return renderResult();

  const item = session.queue[session.i];
  const w = findWord(item.id);
  if (!w) { session.i++; return renderQuestion(); }   // слово удалили во время сессии
  session.answered = false;

  const progress = `
    <div class="row2 small muted" style="margin-bottom:6px">
      <span>${session.i + 1} / ${session.queue.length}</span>
      <span style="text-align:right">✅ ${session.correct} · ❌ ${session.wrong}</span>
    </div>
    <div class="progress"><div style="width:${session.i / session.queue.length * 100}%"></div></div>`;
  const footer = `<button class="btn block" id="quit" style="margin-top:14px">Завершить</button>`;

  let body = '';
  const mode = item.mode;

  if (mode === 'en_ru' || mode === 'ru_en' || mode === 'listen') {
    const field = mode === 'ru_en' ? 'en' : 'ru';
    const options = shuffle([w[field], ...distractors(w, field)]);
    const prompt = mode === 'en_ru'
      ? `<div class="q-word">${esc(w.en)}</div>${w.phon ? `<div class="q-sub">${esc(w.phon)}</div>` : ''}`
      : mode === 'ru_en'
        ? `<div class="q-word">${esc(w.ru)}</div>`
        : `<button class="btn primary" id="replay" style="font-size:26px;padding:16px 26px">🔊</button>
           <div class="q-sub">Нажми, чтобы прослушать ещё раз</div>`;
    body = `
      <div class="card q-card">
        <div class="q-hint">${MODES[mode].name}</div>
        ${prompt}
      </div>
      <div class="options">
        ${options.map(o => `<button class="option" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}
      </div>
      <div id="fb"></div>`;
  } else if (mode === 'write') {
    body = `
      <div class="card q-card">
        <div class="q-hint">Напиши по-английски</div>
        <div class="q-word">${esc(w.ru)}</div>
      </div>
      <form id="write-form" class="form-grid" autocomplete="off">
        <input type="text" id="answer" placeholder="Твой ответ" autocapitalize="none" autocorrect="off" spellcheck="false">
        <div class="row2">
          <button type="button" class="btn" id="hint">Подсказка</button>
          <button type="submit" class="btn primary">Проверить</button>
        </div>
      </form>
      <div id="fb"></div>`;
  } else if (mode === 'cards') {
    body = `
      <div class="card q-card" id="flip">
        <div class="q-hint">Вспомни перевод и нажми на карточку</div>
        <div class="q-word">${esc(w.en)}</div>
        <div id="back" style="display:none">
          ${w.phon ? `<div class="q-sub">${esc(w.phon)} · ≈ [${esc(pronCyr(w))}]</div>` : ''}
          <div style="font-size:22px;margin-top:12px">${esc(w.ru)}</div>
          ${altsText(w) ? `<div class="q-sub small">${esc(altsText(w))}</div>` : ''}
        </div>
      </div>
      <div class="row2" id="grade" style="display:none">
        <button class="btn danger" data-grade="0">😕 Не вспомнил</button>
        <button class="btn ok" data-grade="1">😎 Знаю</button>
      </div>
      <button class="btn block primary" id="show">Показать перевод</button>`;
  }

  root.innerHTML = progress + body + footer;
  $('#quit').onclick = () => (session.correct + session.wrong ? renderResult() : endSession());

  if (mode === 'listen') {
    speak(w.en, w.audio);
    $('#replay').onclick = () => speak(w.en, w.audio);
  }

  // ---- выбор варианта ----
  root.querySelectorAll('[data-opt]').forEach(btn => btn.addEventListener('click', () => {
    if (session.answered) return;
    session.answered = true;
    const field = mode === 'ru_en' ? 'en' : 'ru';
    const ok = btn.dataset.opt === w[field];
    root.querySelectorAll('[data-opt]').forEach(b => {
      if (b.dataset.opt === w[field]) b.classList.add('right');
    });
    if (!ok) btn.classList.add('wrong');
    recordAnswer(w, ok);
    if (mode !== 'listen') speak(w.en, w.audio);
    showFeedback(w, ok);
  }));

  // ---- письменный ответ ----
  if (mode === 'write') {
    const input = $('#answer');
    setTimeout(() => input.focus(), 50);
    let hintLen = 0;
    $('#hint').onclick = () => {
      hintLen = Math.min(w.en.length, hintLen + 1);
      input.placeholder = w.en.slice(0, hintLen) + '…';
    };
    $('#write-form').onsubmit = e => {
      e.preventDefault();
      if (session.answered) { next(); return; }
      const norm = s => s.toLowerCase().trim().replace(/^to\s+/, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ');
      const given = norm(input.value);
      if (!given) return;
      const target = norm(w.en);
      const dist = levenshtein(given, target);
      // одна опечатка допускается для слов длиннее 4 букв; подсказки снижают оценку
      const ok = (dist === 0 || (dist === 1 && target.length > 4)) && hintLen < target.length;
      session.answered = true;
      input.disabled = true;
      recordAnswer(w, ok);
      speak(w.en, w.audio);
      showFeedback(w, ok, ok && dist === 1 ? 'Почти идеально — одна опечатка' : '');
    };
  }

  // ---- карточки ----
  if (mode === 'cards') {
    const reveal = () => {
      $('#back').style.display = 'block';
      $('#grade').style.display = 'grid';
      $('#show').style.display = 'none';
      speak(w.en, w.audio);
    };
    $('#flip').onclick = reveal;
    $('#show').onclick = reveal;
    root.querySelectorAll('[data-grade]').forEach(b => b.addEventListener('click', () => {
      if (session.answered) return;
      session.answered = true;
      recordAnswer(w, b.dataset.grade === '1');
      next();
    }));
  }
}

function showFeedback(w, ok, note = '') {
  const fb = $('#fb');
  const learnedNow = session.newlyLearned.includes(w.id);
  fb.innerHTML = `
    <div class="feedback ${ok ? 'ok' : 'bad'}">
      ${ok ? '✅ Верно!' : '❌ Ошибка'} ${note ? `<span class="small">(${esc(note)})</span>` : ''}
      <div style="font-weight:400;margin-top:4px">
        <b>${esc(w.en)}</b> ${w.phon ? `<span class="small">${esc(w.phon)}</span>` : ''} — ${esc(w.ru)}
      </div>
      ${learnedNow ? '<div style="margin-top:4px">🎉 Слово выучено!</div>' : ''}
    </div>
    <button class="btn primary block" id="next">Дальше →</button>`;
  $('#next').onclick = next;
  $('#next').focus();
}

function next() {
  session.i++;
  renderQuestion();
  window.scrollTo(0, 0);
}

function renderResult() {
  const total = session.correct + session.wrong;
  const pct = total ? Math.round(session.correct / total * 100) : 0;
  const mistakes = [...new Set(session.mistakes)].map(findWord).filter(Boolean);
  const learned = session.newlyLearned.map(findWord).filter(Boolean);

  $('#train-root').innerHTML = `
    <div class="card center">
      <div class="result-big">${pct}%</div>
      <div class="muted">Верно ${session.correct} из ${total}</div>
    </div>
    ${learned.length ? `
      <div class="card">
        <h3>🎉 Выучено в этой тренировке</h3>
        <ul class="hard-list">${learned.map(w => `
          <li><span><b>${esc(w.en)}</b> — ${esc(w.ru)}</span>
            <button class="icon-btn" data-del="${w.id}" aria-label="Удалить">🗑</button></li>`).join('')}
        </ul>
        <button class="btn danger block" id="del-learned" style="margin-top:8px">Удалить все выученные из списка</button>
      </div>` : ''}
    ${mistakes.length ? `
      <div class="card">
        <h3>Повтори эти слова</h3>
        <ul class="hard-list">${mistakes.map(w => `
          <li><span><b>${esc(w.en)}</b> — ${esc(w.ru)}</span>
            <button class="icon-btn" data-say="${w.id}">🔊</button></li>`).join('')}
        </ul>
      </div>` : ''}
    <div class="row2">
      <button class="btn" id="back-home">К режимам</button>
      <button class="btn primary" id="again">Ещё раз</button>
    </div>`;

  const mode = session.mode;
  $('#back-home').onclick = endSession;
  $('#again').onclick = () => startSession(mode);
  $('#train-root').querySelectorAll('[data-say]').forEach(b =>
    b.addEventListener('click', () => { const w = findWord(b.dataset.say); speak(w.en, w.audio); }));
  $('#train-root').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => { deleteWord(b.dataset.del); b.closest('li').remove(); }));
  const delAll = $('#del-learned');
  if (delAll) delAll.onclick = () => {
    if (!confirm(`Удалить ${learned.length} выученных слов?`)) return;
    learned.forEach(w => deleteWord(w.id, false));
    delAll.closest('.card').remove();
  };
  session = { ...session, finished: true };
}

/* =========================== СТАТИСТИКА ============================ */

function streakDays() {
  let streak = 0;
  const d = new Date();
  // если сегодня ещё не занимался — серия считается со вчерашнего дня
  if (!state.history[todayKey(d)]) d.setDate(d.getDate() - 1);
  while (true) {
    const h = state.history[todayKey(d)];
    if (!h || h.c + h.w === 0) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function renderStats() {
  const root = $('#stats-root');
  const words = state.words;
  const learned = words.filter(isLearned).length;
  const totalC = words.reduce((s, w) => s + w.correct, 0);
  const totalW = words.reduce((s, w) => s + w.wrong, 0);
  const acc = totalC + totalW ? Math.round(totalC / (totalC + totalW) * 100) : 0;
  const today = state.history[todayKey()] || { c: 0, w: 0 };

  // распределение по уровням
  const byLevel = Array(MAX_LEVEL + 1).fill(0);
  words.forEach(w => byLevel[Math.min(w.level, MAX_LEVEL)]++);
  const maxLevelCount = Math.max(1, ...byLevel);

  // последние 7 дней
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const h = state.history[todayKey(d)] || { c: 0, w: 0 };
    days.push({ label: d.toLocaleDateString('ru', { weekday: 'short' }), ...h });
  }
  const maxDay = Math.max(1, ...days.map(d => d.c + d.w));

  // трудные слова: больше всего ошибок относительно ответов
  const hard = words.filter(w => w.wrong > 0)
    .sort((a, b) => (b.wrong / (b.correct + b.wrong)) - (a.wrong / (a.correct + a.wrong)) || b.wrong - a.wrong)
    .slice(0, 7);

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${words.length}</div><div class="lbl">слов в словаре</div></div>
      <div class="stat"><div class="num" style="color:var(--ok)">${learned}</div><div class="lbl">выучено</div></div>
      <div class="stat"><div class="num">${acc}%</div><div class="lbl">точность ответов</div></div>
      <div class="stat"><div class="num">🔥 ${streakDays()}</div><div class="lbl">дней подряд</div></div>
      <div class="stat"><div class="num">${today.c + today.w}</div><div class="lbl">ответов сегодня</div></div>
      <div class="stat"><div class="num">${totalC + totalW}</div><div class="lbl">ответов всего</div></div>
    </div>

    <div class="card">
      <h3>Уровень знания слов</h3>
      ${byLevel.map((n, lvl) => `
        <div class="bar-row">
          <span>${LEVEL_NAMES[lvl]}</span>
          <div class="bar"><div style="width:${n / maxLevelCount * 100}%;${lvl === MAX_LEVEL ? 'background:var(--ok)' : ''}"></div></div>
          <span>${n}</span>
        </div>`).join('')}
    </div>

    <div class="card">
      <h3>Активность за неделю</h3>
      <div class="week">
        ${days.map(d => `
          <div class="col" title="✅ ${d.c} ❌ ${d.w}">
            <span>${d.c + d.w || ''}</span>
            <div class="stack" style="height:${(d.c + d.w) / maxDay * 80}%">
              <div class="c" style="flex:${d.c}"></div><div class="w" style="flex:${d.w}"></div>
            </div>
            <span>${d.label}</span>
          </div>`).join('')}
      </div>
    </div>

    ${hard.length ? `
      <div class="card">
        <h3>Трудные слова</h3>
        <ul class="hard-list">
          ${hard.map(w => `<li><span><b>${esc(w.en)}</b> — ${esc(w.ru)}</span>
            <span class="small muted">✅${w.correct} ❌${w.wrong}</span></li>`).join('')}
        </ul>
      </div>` : ''}

    <div class="card">
      <h3>Резервная копия</h3>
      <p class="small muted">Слова хранятся только в этом браузере. Сохрани файл, чтобы перенести их на другое устройство.</p>
      <div class="row2">
        <button class="btn" id="export">⬇️ Экспорт</button>
        <button class="btn" id="import">⬆️ Импорт</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <button class="btn danger block" id="reset-stats" style="margin-top:8px">Сбросить статистику</button>
    </div>

    <p class="small muted">Встроенный словарь: переводы — <a href="https://en.openrussian.org" target="_blank" rel="noopener">OpenRussian</a> (CC BY-SA 4.0), транскрипции — CMU Pronouncing Dictionary, примеры — WordNet 3.0 (Princeton University).</p>`;

  $('#export').onclick = exportData;
  $('#import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = importData;
  $('#reset-stats').onclick = () => {
    if (!confirm('Сбросить прогресс всех слов и историю? Сами слова останутся.')) return;
    state.words.forEach(w => { w.level = 0; w.correct = 0; w.wrong = 0; w.lastSeen = 0; });
    state.history = {};
    saveState();
    renderStats();
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `words-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.words)) throw new Error('нет списка слов');
      // объединяем: существующие слова не дублируем
      const have = new Set(state.words.map(w => w.en.toLowerCase()));
      const fresh = data.words.filter(w => w.en && !have.has(w.en.toLowerCase()));
      state.words.push(...fresh.map(w => ({ ...w, id: w.id || uid(), pending: false })));
      for (const [day, h] of Object.entries(data.history || {})) {
        const cur = state.history[day] || { c: 0, w: 0 };
        state.history[day] = { c: Math.max(cur.c, h.c || 0), w: Math.max(cur.w, h.w || 0) };
      }
      saveState();
      renderStats();
      toast(`Импортировано слов: ${fresh.length}`);
    } catch (err) {
      toast('Неверный файл: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ============================== Старт ============================== */

// Слова, добавленные без интернета и не найденные в словаре, или оставшиеся «в процессе»
// (закрыли вкладку во время запроса) — догружаем, когда есть сеть
function retryPending() {
  state.words.filter(w => w.pending || (w.notFound && !w.ru && navigator.onLine))
    .forEach(w => enrichWord(w, !w.ru));
}
window.addEventListener('online', retryPending);

loadDict().then(d => {
  $('#dict-note').textContent =
    `Встроенный словарь: ${Object.keys(d.ru).length.toLocaleString('ru')} слов — работает и без интернета.`;
}).catch(() => {
  $('#dict-note').textContent = 'Словарь не загрузился — перевод возьму из интернета или впиши сам.';
});

retryPending();
renderWords();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
