"""Собеседник на Claude: исправляет ошибки, отвечает, переводит, выбирает слова для словаря."""

import anthropic
from pydantic import BaseModel, Field

SYSTEM_PROMPT = """\
You are Chatty, a friendly English conversation partner for a Russian-speaking learner.
The learner talks to you in a Telegram chat, usually by voice: their messages are speech-to-text
transcripts, and your reply is read aloud by text-to-speech.

For every learner message:
1. Find real language mistakes: grammar, word choice, word order, wrong tense, unnatural phrasing.
   Ignore punctuation, capitalisation and obvious transcription glitches — these are not the
   learner's fault. If the message is fine, return an empty list of mistakes.
   Explain each mistake briefly in Russian, the way a good teacher would (one sentence).
2. Write the learner's whole message as a natural, corrected English version.
3. Reply in English and keep the conversation going: 2–4 short spoken-style sentences, then one
   question back. Match the learner's level: simple words for beginners, richer language if they
   are fluent. No lists, emoji, markdown or anything that sounds odd when read aloud.
   If the learner writes in Russian, answer in simple English and gently encourage them to try
   in English.
4. Translate your reply into natural Russian.
"""

WORDS_PROMPT = """\
From the English text below, pick the words and phrases (phrasal verbs, collocations, idioms)
that are most useful for an intermediate learner to save to a vocabulary list. Skip the very basic
ones (I, the, go, good…). Give each in its dictionary form with a short Russian translation that
fits this context. Return at most {limit} items, the most useful first.

Text:
{text}"""

TRANSLATE_PROMPT = """\
Translate this English word or phrase into Russian for a learner's vocabulary list.
Give the dictionary form of the English item and one or two of the most common Russian translations.

Item: {item}"""


class Mistake(BaseModel):
    wrong: str = Field(description="The learner's wrong fragment, quoted from their message")
    right: str = Field(description="The corrected fragment")
    why: str = Field(description="One-sentence explanation in Russian")


class Turn(BaseModel):
    corrected: str = Field(description="The learner's whole message, corrected")
    mistakes: list[Mistake]
    reply: str = Field(description="Your spoken reply in English")
    reply_ru: str = Field(description="Russian translation of the reply")


class WordItem(BaseModel):
    en: str
    ru: str


class WordList(BaseModel):
    items: list[WordItem]


class TutorError(Exception):
    """Ответ не получен: модель отказалась или обрезала ответ."""


class Tutor:
    def __init__(self, model: str, effort: str = "low"):
        # Ключ берётся из ANTHROPIC_API_KEY
        self.client = anthropic.AsyncAnthropic()
        self.model = model
        self.effort = effort

    async def _parse(self, messages: list[dict], schema: type[BaseModel], system: str | None = None):
        kwargs = {"system": system} if system else {}
        response = await self.client.beta.messages.parse(
            model=self.model,
            max_tokens=16000,
            messages=messages,
            output_format=schema,
            # для живого диалога важна скорость: low — меньше раздумий, быстрее ответ
            output_config={"effort": self.effort},
            # если модель отклонит запрос, API сам повторит его на запасной модели
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **kwargs,
        )
        if response.stop_reason == "refusal" or response.parsed_output is None:
            raise TutorError(f"stop_reason={response.stop_reason}")
        return response.parsed_output

    async def respond(self, history: list[dict], user_text: str) -> Turn:
        messages = history + [{"role": "user", "content": user_text}]
        return await self._parse(messages, Turn, system=SYSTEM_PROMPT)

    async def pick_words(self, text: str, limit: int = 8) -> list[WordItem]:
        prompt = WORDS_PROMPT.format(text=text, limit=limit)
        result = await self._parse([{"role": "user", "content": prompt}], WordList)
        return result.items[:limit]

    async def translate(self, item: str) -> WordItem:
        prompt = TRANSLATE_PROMPT.format(item=item)
        return await self._parse([{"role": "user", "content": prompt}], WordItem)
