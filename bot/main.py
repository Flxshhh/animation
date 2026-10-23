"""Telegram-бот для разговорной практики английского.

Голосовое → распознавание → Claude исправляет ошибки и отвечает → ответ голосом.
Под каждым голосовым ответом кнопки: показать текст, перевод, добавить слова в словарь.
"""

import asyncio
import html
import logging
import os
import tempfile
from pathlib import Path

import anthropic
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatAction, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (BufferedInputFile, CallbackQuery, FSInputFile, InlineKeyboardButton,
                           InlineKeyboardMarkup, Message)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from dotenv import load_dotenv

from speech import SpeechToText, TextToSpeech
from storage import Storage
from tutor import Tutor, TutorError, Turn

load_dotenv(Path(__file__).with_name(".env"))

HISTORY_LIMIT = 20  # сколько последних реплик помнит собеседник
ALLOWED = {int(x) for x in os.getenv("ALLOWED_USERS", "").replace(",", " ").split()}

db = Storage(os.getenv("DB_PATH", str(Path(__file__).with_name("bot.db"))))
tutor = Tutor(os.getenv("CLAUDE_MODEL", "claude-opus-5-5"), os.getenv("CLAUDE_EFFORT", "low"))
stt = SpeechToText(os.getenv("WHISPER_MODEL", "small"), os.getenv("WHISPER_LANGUAGE", "en"))
tts = TextToSpeech(os.getenv("TTS_VOICE", "en-US-AriaNeural"), os.getenv("TTS_RATE", "-5%"))

router = Router()
log = logging.getLogger("chatty")

HELP = """\
<b>Привет! Я твой собеседник для практики английского.</b>

🎙 Отправь <b>голосовое</b> на английском — я распознаю его, покажу ошибки и отвечу голосом.
⌨️ Можно и <b>текстом</b>.

Под моими голосовыми есть кнопки:
📝 <b>Текст</b> — показать, что я сказал
🇷🇺 <b>Перевод</b> — перевод моей реплики
➕ <b>В словарь</b> — выбрать слова из реплики и сохранить

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

def feedback_text(turn: Turn, heard: str | None) -> str:
    """Сообщение с разбором: что распознано и какие ошибки."""
    parts = []
    if heard:
        parts.append(f"🗣 <i>{html.escape(heard)}</i>")
    if turn.mistakes:
        parts.append("✏️ <b>Исправления</b>")
        parts += [
            f"• <s>{html.escape(m.wrong)}</s> → <b>{html.escape(m.right)}</b> — {html.escape(m.why)}"
            for m in turn.mistakes
        ]
        parts.append(f"\n✨ <b>Лучше так:</b> {html.escape(turn.corrected)}")
    else:
        parts.append("✅ Без ошибок!")
    return "\n".join(parts)


def reply_keyboard(reply_id: int, shown: str = "") -> InlineKeyboardMarkup:
    """shown: '' — ничего не раскрыто, 't' — показан текст, 'r' — текст и перевод."""
    kb = InlineKeyboardBuilder()
    if not shown:
        kb.button(text="📝 Текст", callback_data=f"show:{reply_id}:t")
    if shown != "r":
        kb.button(text="🇷🇺 Перевод", callback_data=f"show:{reply_id}:r")
    kb.button(text="➕ В словарь", callback_data=f"words:{reply_id}")
    return kb.as_markup()


async def keep_action(message: Message, action: ChatAction, done: asyncio.Event):
    # Статус «записывает голосовое…» живёт 5 секунд — обновляем, пока идёт обработка
    while not done.is_set():
        await message.bot.send_chat_action(message.chat.id, action)
        try:
            await asyncio.wait_for(done.wait(), timeout=4)
        except asyncio.TimeoutError:
            pass


async def talk(message: Message, user_text: str, heard: str | None):
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

        await message.answer(feedback_text(turn, heard))
        with tempfile.TemporaryDirectory() as tmp:
            ogg = Path(tmp) / "reply.ogg"
            try:
                await tts.synthesize(turn.reply, ogg)
            except Exception:
                # без голоса диалог всё равно продолжается — отправляем текстом
                log.exception("tts failed")
                await message.answer(html.escape(turn.reply), reply_markup=reply_keyboard(reply_id, "t"))
                return
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
    await talk(message, text, heard=text)


@router.message(F.text & ~F.text.startswith("/"))
async def on_text(message: Message):
    await talk(message, message.text, heard=None)


# ------------------------------ Кнопки ------------------------------

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
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
