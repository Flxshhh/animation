"""Telegram-бот для разговорной практики английского.

Голосовое → распознавание → Claude исправляет ошибки и отвечает → ответ голосом.
Сначала бот присылает только голос — чтобы учиться понимать на слух. Текст открывается
кнопкой «Текст» в мини-приложении, где любое слово можно перевести и сохранить в словарь.
"""

import asyncio
import difflib
import html
import logging
import os
import re
import tempfile
from pathlib import Path

import anthropic
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatAction, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (BufferedInputFile, CallbackQuery, FSInputFile, InlineKeyboardButton,
                           InlineKeyboardMarkup, Message, WebAppInfo)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from dotenv import load_dotenv

from speech import SpeechToText, TextToSpeech
from storage import Storage
from tutor import Tutor, TutorError
from webapp import make_app, start_server

load_dotenv(Path(__file__).with_name(".env"))

HISTORY_LIMIT = 20  # сколько последних реплик помнит собеседник
ALLOWED = {int(x) for x in os.getenv("ALLOWED_USERS", "").replace(",", " ").split()}

db = Storage(os.getenv("DB_PATH", str(Path(__file__).with_name("bot.db"))))
tutor = Tutor(os.getenv("CLAUDE_MODEL", "claude-opus-5-5"), os.getenv("CLAUDE_EFFORT", "low"))
stt = SpeechToText(os.getenv("WHISPER_MODEL", "small"), os.getenv("WHISPER_LANGUAGE", "en"))
tts = TextToSpeech(os.getenv("TTS_VOICE", "en-US-AriaNeural"), os.getenv("TTS_RATE", "-5%"))
# Публичный https-адрес мини-приложения (например, от cloudflared). Пусто — текст в подписи к голосовому
WEBAPP_URL = os.getenv("WEBAPP_URL", "").rstrip("/")
WEBAPP_PORT = int(os.getenv("WEBAPP_PORT", "8080"))

router = Router()
log = logging.getLogger("chatty")

HELP = """\
<b>Привет! Я твой собеседник для практики английского.</b>

🎙 Отправь <b>голосовое</b> на английском (можно и текстом).
Я покажу исправленную фразу: <s>лишнее</s> зачёркнуто, <b>нужное</b> выделено.
• <b>Объяснить</b> — почему так
• <b>Оценка</b> — оценка твоей фразы

Отвечаю только голосом — тренируй понимание на слух. Не понял?
• <b>Текст</b> — открыть текст; нажми на слово, чтобы увидеть перевод и 🔖 сохранить его
• <b>Помощь</b> — варианты, что ответить

<b>Команды</b>
/dict — мой словарь
/add <i>слово</i> — добавить слово (можно <code>/add get over — пережить</code>)
/del <i>слово</i> — удалить слово
/export — файл для импорта в приложение «Мои слова»
/reset — начать разговор заново"""


# ------------------------------ Доступ ------------------------------

@router.message.outer_middleware()
@router.callback_query.outer_middleware()
async def only_allowed(handler, event, data):
    # Каждое сообщение тратит деньги на API: если задан ALLOWED_USERS, чужим бот не отвечает
    user = data.get("event_from_user")
    if ALLOWED and (user is None or user.id not in ALLOWED):
        if isinstance(event, Message):
            await event.answer(f"Бот приватный. Твой id: <code>{user.id if user else '?'}</code>")
        return None
    return await handler(event, data)


# ------------------------------ Команды ------------------------------

@router.message(CommandStart())
@router.message(Command("help"))
async def cmd_start(message: Message):
    await message.answer(HELP)


@router.message(Command("reset"))
async def cmd_reset(message: Message):
    db.reset_history(message.from_user.id)
    await message.answer("Начинаем заново. Say hi! 👋")


@router.message(Command("dict"))
async def cmd_dict(message: Message):
    words = db.list_words(message.from_user.id)
    if not words:
        await message.answer("Словарь пуст. Нажми ➕ под моим голосовым или используй /add.")
        return
    lines = [f"• <b>{html.escape(en)}</b> — {html.escape(ru)}" for en, ru in words[:100]]
    more = f"\n…и ещё {len(words) - 100}" if len(words) > 100 else ""
    await message.answer(f"📚 <b>Слов в словаре: {len(words)}</b>\n\n" + "\n".join(lines) + more)


@router.message(Command("add"))
async def cmd_add(message: Message, command: CommandObject):
    arg = (command.args or "").strip()
    if not arg:
        await message.answer("Напиши слово после команды: <code>/add get over</code>")
        return
    # «/add слово — перевод» или «/add слово» (тогда перевод сделает Claude)
    for sep in (" — ", " - ", "="):
        if sep in arg:
            en, ru = (s.strip() for s in arg.split(sep, 1))
            break
    else:
        try:
            item = await tutor.translate(arg)
        except (anthropic.APIError, TutorError):
            log.exception("translate failed")
            await message.answer("Не получилось перевести. Добавь с переводом: <code>/add слово — перевод</code>")
            return
        en, ru = item.en, item.ru
    added = db.add_word(message.from_user.id, en, ru)
    mark = "✅ Добавлено" if added else "Уже есть в словаре"
    await message.answer(f"{mark}: <b>{html.escape(en)}</b> — {html.escape(ru)}")


@router.message(Command("del"))
async def cmd_del(message: Message, command: CommandObject):
    word = (command.args or "").strip()
    if word and db.delete_word(message.from_user.id, word):
        await message.answer(f"🗑 Удалено: <b>{html.escape(word)}</b>")
    else:
        await message.answer("Такого слова нет. Список — /dict")


@router.message(Command("export"))
async def cmd_export(message: Message):
    data = db.export_for_app(message.from_user.id)
    await message.answer_document(
        BufferedInputFile(data, filename="words-from-bot.json"),
        caption="Открой приложение «Мои слова» → Статистика → Импорт и выбери этот файл.",
    )


# ------------------------------ Диалог ------------------------------

TOKEN_RE = re.compile(r"\w+(?:['’]\w+)*|[^\w\s]")
NO_SPACE_BEFORE = set(".,!?;:)%'’…")


TAGS_RE = re.compile(r"</?[bs]>")


def join_tokens(tokens: list[str]) -> str:
    """Склеивает слова и знаки препинания: пробел ставится между словами, но не перед «.,!?»."""
    out = ""
    for t in tokens:
        first = TAGS_RE.sub("", t)[:1]          # теги <b>/<s> не влияют на пробелы
        if out and first not in NO_SPACE_BEFORE and not TAGS_RE.sub("", out).endswith("("):
            out += " "
        out += t
    return out


def diff_html(original: str, corrected: str) -> str:
    """Исправленная фраза: удалённое зачёркнуто, добавленное жирным (как в оригинальном боте)."""
    a, b = TOKEN_RE.findall(original), TOKEN_RE.findall(corrected)
    # регистр не сравниваем: распознавание речи расставляет заглавные буквы как попало
    sm = difflib.SequenceMatcher(None, [t.lower() for t in a], [t.lower() for t in b], autojunk=False)
    parts = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            parts += [html.escape(t) for t in b[j1:j2]]
        if op in ("delete", "replace"):
            parts.append("<s>" + html.escape(join_tokens(a[i1:i2])) + "</s>")
        if op in ("insert", "replace"):
            parts.append("<b>" + html.escape(join_tokens(b[j1:j2])) + "</b>")
    return join_tokens(parts)


def feedback_text(fb: dict, shown: str) -> str:
    """shown — какие разделы раскрыты: 'x' — объяснения, 's' — оценка."""
    if fb["mistakes"]:
        text = "💡 " + fb["diff"]
    else:
        text = "💡 " + html.escape(fb["original"]) + "\n✅ Без ошибок!"
    if "x" in shown and fb["mistakes"]:
        text += "\n\n" + "\n".join(
            f"• <s>{html.escape(m['wrong'])}</s> → <b>{html.escape(m['right'])}</b> — {html.escape(m['why'])}"
            for m in fb["mistakes"]
        )
    if "s" in shown:
        text += f"\n\n⭐ <b>Оценка: {fb['score']}/10</b>\n{html.escape(fb['score_comment'])}"
    return text


def feedback_keyboard(fb_id: int, has_mistakes: bool, shown: str) -> InlineKeyboardMarkup | None:
    kb = InlineKeyboardBuilder()
    if has_mistakes and "x" not in shown:
        kb.button(text="Объяснить", callback_data=f"fb:{fb_id}:{shown}x")
    if "s" not in shown:
        kb.button(text="Оценка", callback_data=f"fb:{fb_id}:{shown}s")
    markup = kb.as_markup()
    return markup if markup.inline_keyboard else None


def reply_keyboard(reply_id: int, shown: str = "") -> InlineKeyboardMarkup:
    """Кнопки под голосовым ответом. shown: '' — ничего не раскрыто, 't' — текст, 'r' — текст и перевод."""
    kb = InlineKeyboardBuilder()
    if WEBAPP_URL:
        kb.button(text="Текст", web_app=WebAppInfo(url=f"{WEBAPP_URL}/?r={reply_id}"))
    elif not shown:
        kb.button(text="Текст", callback_data=f"show:{reply_id}:t")
    else:
        # без мини-приложения: текст в подписи, а слова выбираются кнопками
        if shown != "r":
            kb.button(text="🇷🇺 Перевод", callback_data=f"show:{reply_id}:r")
        kb.button(text="➕ В словарь", callback_data=f"words:{reply_id}")
    kb.button(text="Помощь", callback_data=f"help:{reply_id}")
    return kb.as_markup()


async def keep_action(message: Message, action: ChatAction, done: asyncio.Event):
    # Статус «записывает голосовое…» живёт 5 секунд — обновляем, пока идёт обработка
    while not done.is_set():
        await message.bot.send_chat_action(message.chat.id, action)
        try:
            await asyncio.wait_for(done.wait(), timeout=4)
        except asyncio.TimeoutError:
            pass


async def talk(message: Message, user_text: str):
    user_id = message.from_user.id
    done = asyncio.Event()
    status = asyncio.create_task(keep_action(message, ChatAction.RECORD_VOICE, done))
    try:
        try:
            turn = await tutor.respond(db.get_history(user_id, HISTORY_LIMIT), user_text)
        except (anthropic.APIError, TutorError):
            log.exception("tutor failed")
            await message.answer("😕 Не получилось ответить. Попробуй ещё раз чуть позже.")
            return

        db.add_message(user_id, "user", user_text)
        db.add_message(user_id, "assistant", turn.reply)
        reply_id = db.save_reply(user_id, turn.reply, turn.reply_ru)

        fb = {
            "original": user_text,
            "diff": diff_html(user_text, turn.corrected),
            "mistakes": [m.model_dump() for m in turn.mistakes],
            "score": turn.score,
            "score_comment": turn.score_comment,
        }
        fb_id = db.save_feedback(user_id, fb)
        await message.answer(feedback_text(fb, ""), reply_markup=feedback_keyboard(fb_id, bool(fb["mistakes"]), ""))

        with tempfile.TemporaryDirectory() as tmp:
            ogg = Path(tmp) / "reply.ogg"
            try:
                await tts.synthesize(turn.reply, ogg)
            except Exception:
                # без голоса диалог всё равно продолжается — отправляем текстом
                log.exception("tts failed")
                await message.answer(html.escape(turn.reply), reply_markup=reply_keyboard(reply_id, "t"))
                return
            # голос без подписи: сначала слушаем, текст — по кнопке
            await message.answer_voice(FSInputFile(ogg), reply_markup=reply_keyboard(reply_id))
    finally:
        done.set()
        await status


@router.message(F.voice | F.audio)
async def on_voice(message: Message):
    media = message.voice or message.audio
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "voice.ogg"
        await message.bot.download(media, destination=path)
        await message.bot.send_chat_action(message.chat.id, ChatAction.TYPING)
        try:
            text = await stt.transcribe(path)
        except Exception:
            log.exception("stt failed")
            await message.answer("😕 Не получилось распознать голосовое.")
            return
    if not text:
        await message.answer("Не расслышал 🙉 Попробуй ещё раз, погромче и ближе к микрофону.")
        return
    await talk(message, text)


@router.message(F.text & ~F.text.startswith("/"))
async def on_text(message: Message):
    await talk(message, message.text)


# ------------------------------ Кнопки ------------------------------

@router.callback_query(F.data.startswith("fb:"))
async def on_feedback(call: CallbackQuery):
    _, fb_id, shown = call.data.split(":")
    fb = db.get_feedback(int(fb_id), call.from_user.id)
    if not fb:
        await call.answer("Разбор не найден", show_alert=True)
        return
    await call.message.edit_text(
        feedback_text(fb, shown),
        reply_markup=feedback_keyboard(int(fb_id), bool(fb["mistakes"]), shown),
    )
    await call.answer()


@router.callback_query(F.data.startswith("help:"))
async def on_help(call: CallbackQuery):
    reply_id = int(call.data.split(":")[1])
    if not db.get_reply(reply_id, call.from_user.id):
        await call.answer("Реплика не найдена", show_alert=True)
        return
    key = f"help:{reply_id}"
    text = db.cache_get(key)
    if text is None:
        await call.answer("Думаю, что можно ответить…")
        try:
            help_ = await tutor.help(db.get_history(call.from_user.id, HISTORY_LIMIT))
        except (anthropic.APIError, TutorError):
            log.exception("help failed")
            await call.message.answer("😕 Не получилось подсказать. Попробуй ещё раз.")
            return
        lines = ["🆘 <b>Можно ответить так:</b>"]
        lines += [f"\n{n}. <b>{html.escape(a.en)}</b>\n<i>{html.escape(a.ru)}</i>"
                  for n, a in enumerate(help_.answers, 1)]
        lines.append(f"\n🧩 {html.escape(help_.tip)}")
        text = "\n".join(lines)
        db.cache_set(key, text)
    else:
        await call.answer()
    await call.message.answer(text)


@router.callback_query(F.data.startswith("show:"))
async def on_show(call: CallbackQuery):
    _, reply_id, mode = call.data.split(":")
    row = db.get_reply(int(reply_id), call.from_user.id)
    if not row:
        await call.answer("Реплика не найдена", show_alert=True)
        return
    text, translation = row
    caption = html.escape(text)
    if mode == "r":
        caption += f"\n\n🇷🇺 <i>{html.escape(translation)}</i>"
    markup = reply_keyboard(int(reply_id), mode)
    if call.message.voice:
        await call.message.edit_caption(caption=caption[:1024], reply_markup=markup)
    else:  # запасной вариант, когда ответ пришёл текстом
        await call.message.edit_text(caption, reply_markup=markup)
    await call.answer()


@router.callback_query(F.data.startswith("words:"))
async def on_words(call: CallbackQuery):
    row = db.get_reply(int(call.data.split(":")[1]), call.from_user.id)
    if not row:
        await call.answer("Реплика не найдена", show_alert=True)
        return
    await call.answer("Подбираю слова…")
    try:
        items = await tutor.pick_words(row[0])
    except (anthropic.APIError, TutorError):
        log.exception("pick_words failed")
        await call.message.answer("😕 Не получилось подобрать слова. Добавь вручную: /add слово")
        return
    if not items:
        await call.message.answer("Здесь нечего добавлять — все слова базовые. Можно вручную: /add слово")
        return

    ids = db.save_suggestions(call.from_user.id, [(i.en, i.ru) for i in items])
    kb = InlineKeyboardBuilder()
    for sid, item in zip(ids, items):
        kb.button(text=f"{item.en} — {item.ru}"[:60], callback_data=f"add:{sid}")
    kb.button(text="➕ Добавить все", callback_data=f"addall:{ids[0]}:{ids[-1]}")
    kb.adjust(1)
    await call.message.answer(
        "Нажми на слова, которые хочешь сохранить.\nСвоё слово — командой /add",
        reply_markup=kb.as_markup(),
    )


def mark_added(markup: InlineKeyboardMarkup, done_ids: set[int]) -> InlineKeyboardMarkup:
    """Ставит ✅ на кнопки уже добавленных слов."""
    rows = []
    for row in markup.inline_keyboard:
        new_row = []
        for b in row:
            if b.callback_data and b.callback_data.startswith("add:") \
                    and int(b.callback_data[4:]) in done_ids and not b.text.startswith("✅"):
                b = InlineKeyboardButton(text="✅ " + b.text, callback_data=b.callback_data)
            new_row.append(b)
        rows.append(new_row)
    return InlineKeyboardMarkup(inline_keyboard=rows)


@router.callback_query(F.data.startswith("add:") | F.data.startswith("addall:"))
async def on_add(call: CallbackQuery):
    parts = call.data.split(":")
    ids = [int(parts[1])] if parts[0] == "add" else list(range(int(parts[1]), int(parts[2]) + 1))
    added = 0
    for sid in ids:
        row = db.get_suggestion(sid, call.from_user.id)
        if row and db.add_word(call.from_user.id, *row):
            added += 1
    await call.answer(f"Добавлено: {added}" if added else "Уже в словаре")
    new_markup = mark_added(call.message.reply_markup, set(ids))
    if new_markup != call.message.reply_markup:
        await call.message.edit_reply_markup(reply_markup=new_markup)


# ------------------------------ Запуск ------------------------------

async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bot = Bot(os.environ["TELEGRAM_BOT_TOKEN"], default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)
    runner = None
    if WEBAPP_URL:
        runner = await start_server(make_app(db, tutor, bot.token, ALLOWED), WEBAPP_PORT)
    else:
        log.warning("WEBAPP_URL не задан: кнопка «Текст» покажет текст в подписи к голосовому")
    try:
        await dp.start_polling(bot)
    finally:
        if runner:
            await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
