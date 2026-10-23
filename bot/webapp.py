"""Мини-приложение «Текст»: веб-сервер (aiohttp) для страницы и её API.

Страница открывается кнопкой «📝 Текст» под голосовым ответом. Она показывает реплику бота,
переводит любое слово по нажатию и сохраняет слова в словарь.
"""

import logging
import re
from pathlib import Path

import anthropic
from aiogram.utils.web_app import safe_parse_webapp_init_data
from aiohttp import web

from storage import Storage
from tutor import Tutor, TutorError

PAGE = Path(__file__).with_name("webapp") / "index.html"
# Слово: буквы, допускаются апострофы внутри (I'm, don't, it's)
WORD_RE = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)*")

log = logging.getLogger("chatty.webapp")


def tokenize(text: str) -> tuple[list[dict], list[str]]:
    """Разбивает текст на куски для страницы: слова ({"t", "w": номер}) и всё между ними ({"t"})."""
    tokens, words, pos = [], [], 0
    for m in WORD_RE.finditer(text):
        if m.start() > pos:
            tokens.append({"t": text[pos:m.start()]})
        tokens.append({"t": m.group(), "w": len(words)})
        words.append(m.group())
        pos = m.end()
    if pos < len(text):
        tokens.append({"t": text[pos:]})
    return tokens, words


def make_app(db: Storage, tutor: Tutor, bot_token: str, allowed: set[int]) -> web.Application:

    async def auth(request: web.Request) -> tuple[int, dict]:
        """Проверяет подпись Telegram (initData): без неё любой мог бы читать чужие реплики."""
        body = await request.json()
        try:
            user = safe_parse_webapp_init_data(bot_token, body.get("initData", "")).user
        except ValueError:
            raise web.HTTPUnauthorized(text="bad initData")
        if user is None or (allowed and user.id not in allowed):
            raise web.HTTPForbidden()
        return user.id, body

    def reply_or_404(body: dict, user_id: int) -> tuple[str, str]:
        row = db.get_reply(int(body.get("r", 0)), user_id)
        if not row:
            raise web.HTTPNotFound(text="reply not found")
        return row

    async def page(_request):
        return web.FileResponse(PAGE)

    async def api_reply(request):
        user_id, body = await auth(request)
        text, translation = reply_or_404(body, user_id)
        tokens, _ = tokenize(text)
        return web.json_response({
            "text": text, "translation": translation, "tokens": tokens,
            "saved": sorted(db.saved_set(user_id)),
        })

    async def api_gloss(request):
        user_id, body = await auth(request)
        text, _ = reply_or_404(body, user_id)
        key = f"gloss:{int(body['r'])}"
        items = db.cache_get(key)
        if items is None:
            _, words = tokenize(text)
            try:
                glosses = await tutor.gloss(text, words) if words else {}
            except (anthropic.APIError, TutorError):
                log.exception("gloss failed")
                raise web.HTTPBadGateway(text="translation failed")
            items = {str(i): {"lemma": g.lemma, "ru": g.ru} for i, g in glosses.items()}
            db.cache_set(key, items)
        return web.json_response({"items": items})

    async def api_save(request):
        user_id, body = await auth(request)
        en, ru = str(body.get("en", "")).strip(), str(body.get("ru", "")).strip()
        if not en:
            raise web.HTTPBadRequest(text="empty word")
        if body.get("save", True):
            db.add_word(user_id, en, ru)
        else:
            db.delete_word(user_id, en)
        return web.json_response({"saved": en.lower() in db.saved_set(user_id)})

    app = web.Application()
    app.router.add_get("/", page)
    app.router.add_post("/api/reply", api_reply)
    app.router.add_post("/api/gloss", api_gloss)
    app.router.add_post("/api/save", api_save)
    return app


async def start_server(app: web.Application, port: int) -> web.AppRunner:
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    log.info("mini app server on http://localhost:%d", port)
    return runner
