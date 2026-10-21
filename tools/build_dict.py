"""Собирает офлайн-словарь для «Мои слова» из открытых источников.

  OpenRussian (CC BY-SA 4.0)        → перевод en → ru (инвертируем ru → en)
  CMU Pronouncing Dictionary (ISC)  → транскрипция: IPA и русскими буквами
  WordNet 3.0 (WordNet licence)     → английские примеры употребления

Результат: dict/ru.json, dict/pron.json, dict/ex.json
"""
import csv, json, re, sys, os
from collections import defaultdict

SRC = sys.argv[1]   # папка с исходниками
OUT = sys.argv[2]   # куда писать JSON
os.makedirs(OUT, exist_ok=True)
csv.field_size_limit(10**8)

# ---------------- 1. OpenRussian: инвертируем ru → en ----------------
POS = {'nouns': 'сущ', 'verbs': 'гл', 'adjectives': 'прил', 'others': ''}
SKIP_PREFIX = re.compile(r'^(to|a|an|the|be)\s+')
cands = defaultdict(list)   # en -> [(score, ru, pos)]

def stress(accented):
    # «челове'к» → «челове́к»; в односложных ударение не ставим
    if accented.count("'") and len(re.findall('[аеёиоуыэюя]', accented.replace("'", ''))) > 1:
        return accented.replace("'", '́')
    return accented.replace("'", '')

for fname, pos in POS.items():
    with open(f'{SRC}/{fname}.csv', encoding='utf-8') as f:
        for rank, row in enumerate(csv.DictReader(f, delimiter='\t')):
            tr = (row.get('translations_en') or '').strip()
            ru = stress((row.get('accented') or row.get('bare') or '').strip())
            if not tr or not ru or ' ' in row['bare'].strip():
                continue
            for m_i, meaning in enumerate(tr.split(';')):
                meaning = re.sub(r'\([^)]*\)|\[[^\]]*\]', '', meaning)
                for i_i, item in enumerate(meaning.split(',')):
                    key = SKIP_PREFIX.sub('', item.strip().lower()).strip(' .!?*/')
                    if not key or len(key) > 30 or len(key.split()) > 3 or not re.fullmatch(r"[a-z][a-z' -]*", key):
                        continue
                    # чем частотнее русское слово и чем раньше значение — тем выше
                    score = rank + m_i * 400 + i_i * 120
                    cands[key].append((score, ru, pos))

ru_dict = {}
for key, lst in cands.items():
    lst.sort()
    seen, out = set(), []
    for _, ru, pos in lst:
        if ru in seen:
            continue
        seen.add(ru)
        out.append(f'{pos}:{ru}' if pos else ru)
        if len(out) == 5:
            break
    ru_dict[key] = ';'.join(out)

# ---------------- 2. CMU: ARPAbet → IPA и русская транскрипция ----------------
IPA = {'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ', 'EH': 'ɛ', 'ER': 'ɝ',
       'EY': 'eɪ', 'IH': 'ɪ', 'IY': 'i', 'OW': 'oʊ', 'OY': 'ɔɪ', 'UH': 'ʊ', 'UW': 'u',
       'B': 'b', 'CH': 'tʃ', 'D': 'd', 'DH': 'ð', 'F': 'f', 'G': 'ɡ', 'HH': 'h', 'JH': 'dʒ', 'K': 'k',
       'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ', 'P': 'p', 'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't',
       'TH': 'θ', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'}
CYR = {'AA': 'а', 'AE': 'э', 'AH': 'а', 'AO': 'о', 'AW': 'ау', 'AY': 'ай', 'EH': 'е', 'ER': 'ёр',
       'EY': 'эй', 'IH': 'и', 'IY': 'и', 'OW': 'оу', 'OY': 'ой', 'UH': 'у', 'UW': 'у',
       'B': 'б', 'CH': 'ч', 'D': 'д', 'DH': 'з', 'F': 'ф', 'G': 'г', 'HH': 'х', 'JH': 'дж', 'K': 'к',
       'L': 'л', 'M': 'м', 'N': 'н', 'NG': 'нг', 'P': 'п', 'R': 'р', 'S': 'с', 'SH': 'ш', 'T': 'т',
       'TH': 'с', 'V': 'в', 'W': 'у', 'Y': 'й', 'Z': 'з', 'ZH': 'ж'}
ONSETS = {'pl', 'pɹ', 'bl', 'bɹ', 'tɹ', 'dɹ', 'kl', 'kɹ', 'ɡl', 'ɡɹ', 'fl', 'fɹ', 'θɹ', 'ʃɹ', 'sp', 'st',
          'sk', 'sl', 'sm', 'sn', 'sw', 'tw', 'kw', 'dw', 'spɹ', 'stɹ', 'skɹ', 'spl', 'skw', 'pj', 'kj', 'bj', 'fj', 'mj', 'hj'}
VOWELS = set('AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW'.split())

def to_ipa(arpa):
    ph = arpa.split()
    out = []          # список (ipa, is_vowel, stress)
    for p in ph:
        base, st = re.match(r'([A-Z]+)(\d?)', p).groups()
        if base in VOWELS:
            sym = IPA[base]
            if base == 'AH' and st == '0': sym = 'ə'
            if base == 'ER' and st == '0': sym = 'ɚ'
            out.append((sym, True, st))
        else:
            out.append((IPA[base], False, ''))
    multi = sum(1 for o in out if o[1]) > 1
    res = []
    for i, (sym, is_v, st) in enumerate(out):
        res.append(sym)
        if is_v and st == '1' and multi:
            # ставим ˈ перед началом слога: перед допустимым кластером согласных
            j = len(res) - 1
            k = j
            while k - 1 >= 0 and not out[k - 1][1] and ''.join(r for r in res[k - 1:j]) in ONSETS | {s for s in IPA.values()}:
                k -= 1
            res.insert(k, 'ˈ')
    return '/' + ''.join(res) + '/'

def to_cyr(arpa):
    ph = arpa.split()
    s = ''
    for i, p in enumerate(ph):
        base, st = re.match(r'([A-Z]+)(\d?)', p).groups()
        nxt = re.match(r'([A-Z]+)', ph[i + 1]).group(1) if i + 1 < len(ph) else ''
        prev = re.match(r'([A-Z]+)', ph[i - 1]).group(1) if i else ''
        if base == 'Y' and nxt in ('UW', 'UH'):
            continue                                   # «ju» → «ю», обработаем на гласной
        c = CYR[base]
        if base in ('UW', 'UH') and prev == 'Y': c = 'ю'
        if base == 'AH' and st == '0': c = 'э'
        if base == 'ER' and st == '0': c = 'эр'
        if base == 'EH' and (i == 0 or prev in VOWELS): c = 'э'
        if base == 'R' and prev == 'ER': continue      # не дублируем «р»
        if base in VOWELS and st == '1':
            c = c[0].upper() + c[1:]
        s += c
    if sum(1 for p in ph if re.match(r'[A-Z]+', p).group(0) in VOWELS) == 1:
        s = s.lower()                                  # в односложных ударение не выделяем
    return s

with open(f'{SRC}/cmu-pronouncing-dictionary/package/index.js', encoding='utf-8') as f:
    cmu = dict(re.findall(r'^\s*"([^"]+)": "([^"]+)"', f.read(), re.M))

# транскрипции только для слов, которые встречаются в словаре (или в его фразах)
need = set()
for key in ru_dict:
    need.update(key.split())
pron = {}
for w in need:
    if w in cmu:
        try:
            pron[w] = to_ipa(cmu[w]) + '|' + to_cyr(cmu[w])
        except Exception as e:
            print('skip', w, e)

# ---------------- 3. WordNet: английские примеры ----------------
examples = defaultdict(list)
for part in ('noun', 'verb', 'adj', 'adv'):
    with open(f'{SRC}/wordnet-db/package/dict/data.{part}', encoding='utf-8', errors='ignore') as f:
        for line in f:
            if line.startswith('  ') or '|' not in line:
                continue
            head, gloss = line.split('|', 1)
            parts = head.split()
            n = int(parts[3], 16)
            lemmas = [parts[4 + 2 * i].lower().replace('_', ' ') for i in range(n)]
            lemmas = [re.sub(r'\(.*\)$', '', l) for l in lemmas]
            for ex in re.findall(r'"([^"]{8,140})"', gloss):
                ex = ex.strip()
                low = ex.lower()
                for lem in lemmas:
                    if lem not in ru_dict:
                        continue
                    stem = lem[:-1] if len(lem) > 4 and lem.endswith('e') else lem
                    if re.search(r'\b' + re.escape(stem), low) and ex not in examples[lem]:
                        examples[lem].append(ex)

ex_dict = {}
for lem, lst in examples.items():
    # сначала нормальные предложения (3+ слова, 20–90 символов), потом обрывки
    lst.sort(key=lambda e: (len(e.split()) < 3, abs(len(e) - 50)))
    ex_dict[lem] = lst[:4]

for name, data in (('ru', ru_dict), ('pron', pron), ('ex', ex_dict)):
    with open(f'{OUT}/{name}.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(name, len(data), os.path.getsize(f'{OUT}/{name}.json') // 1024, 'KB')

for w in ('run', 'water', 'apple', 'house', 'beautiful', 'wander', 'though', 'give up', 'computer', 'cat', 'thought', 'usually', 'university'):
    print(w, '→', ru_dict.get(w), '|', pron.get(w.split()[0]), '|', ex_dict.get(w, [])[:2])
