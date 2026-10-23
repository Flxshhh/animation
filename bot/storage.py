"""SQLite-хранилище: история диалога, ответы бота и словарь пользователя."""

import json
import sqlite3
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role    TEXT    NOT NULL,          -- 'user' | 'assistant'
    content TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (     -- ответы бота: нужны кнопкам «Текст», «Перевод», «В словарь»
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    translation TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions ( -- слова, которые бот предложил добавить
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    en      TEXT    NOT NULL,
    ru      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS words (
    user_id INTEGER NOT NULL,
    en      TEXT    NOT NULL,
    ru      TEXT    NOT NULL,
    added   INTEGER NOT NULL,          -- мс с эпохи, как Date.now() в приложении
    PRIMARY KEY (user_id, en)
);
"""


class Storage:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    # ----------------------------- История -----------------------------

    def add_message(self, user_id: int, role: str, content: str) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO history (user_id, role, content) VALUES (?, ?, ?)",
                (user_id, role, content),
            )

    def get_history(self, user_id: int, limit: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT role, content FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        messages = [{"role": r, "content": c} for r, c in reversed(rows)]
        # API требует, чтобы диалог начинался с реплики пользователя
        while messages and messages[0]["role"] != "user":
            messages.pop(0)
        return messages

    def reset_history(self, user_id: int) -> None:
        with self.db:
            self.db.execute("DELETE FROM history WHERE user_id = ?", (user_id,))

    # --------------------------- Ответы бота ---------------------------

    def save_reply(self, user_id: int, text: str, translation: str) -> int:
        with self.db:
            cur = self.db.execute(
                "INSERT INTO replies (user_id, text, translation) VALUES (?, ?, ?)",
                (user_id, text, translation),
            )
        return cur.lastrowid

    def get_reply(self, reply_id: int, user_id: int) -> tuple[str, str] | None:
        return self.db.execute(
            "SELECT text, translation FROM replies WHERE id = ? AND user_id = ?",
            (reply_id, user_id),
        ).fetchone()

    def save_suggestions(self, user_id: int, items: list[tuple[str, str]]) -> list[int]:
        ids = []
        with self.db:
            for en, ru in items:
                cur = self.db.execute(
                    "INSERT INTO suggestions (user_id, en, ru) VALUES (?, ?, ?)",
                    (user_id, en, ru),
                )
                ids.append(cur.lastrowid)
        return ids

    def get_suggestion(self, sugg_id: int, user_id: int) -> tuple[str, str] | None:
        return self.db.execute(
            "SELECT en, ru FROM suggestions WHERE id = ? AND user_id = ?",
            (sugg_id, user_id),
        ).fetchone()

    # ----------------------------- Словарь -----------------------------

    def add_word(self, user_id: int, en: str, ru: str) -> bool:
        """True — слово добавлено, False — уже было (без учёта регистра)."""
        en = " ".join(en.split())
        exists = self.db.execute(
            "SELECT 1 FROM words WHERE user_id = ? AND lower(en) = lower(?)", (user_id, en)
        ).fetchone()
        if exists:
            return False
        with self.db:
            self.db.execute(
                "INSERT INTO words (user_id, en, ru, added) VALUES (?, ?, ?, ?)",
                (user_id, en, ru, int(time.time() * 1000)),
            )
        return True

    def delete_word(self, user_id: int, en: str) -> bool:
        with self.db:
            cur = self.db.execute(
                "DELETE FROM words WHERE user_id = ? AND lower(en) = lower(?)", (user_id, en.strip())
            )
        return cur.rowcount > 0

    def list_words(self, user_id: int) -> list[tuple[str, str]]:
        return self.db.execute(
            "SELECT en, ru FROM words WHERE user_id = ? ORDER BY added DESC", (user_id,)
        ).fetchall()

    def export_for_app(self, user_id: int) -> bytes:
        """JSON в формате резервной копии приложения «Мои слова» (кнопка «Импорт»)."""
        rows = self.db.execute(
            "SELECT en, ru, added FROM words WHERE user_id = ? ORDER BY added DESC", (user_id,)
        ).fetchall()
        words = [
            {
                "id": uuid.uuid4().hex[:12], "en": en, "ru": ru, "alts": [], "phon": "", "audio": "",
                "examples": None, "level": 0, "correct": 0, "wrong": 0,
                "added": added, "lastSeen": 0, "pending": False,
            }
            for en, ru, added in rows
        ]
        data = {"words": words, "history": {}, "settings": {}}
        return json.dumps(data, ensure_ascii=False, indent=1).encode()
