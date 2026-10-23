"""Речь: распознавание (faster-whisper, локально) и озвучка (edge-tts) с перекодированием в OGG/Opus."""

import asyncio
from pathlib import Path

import edge_tts


class SpeechToText:
    def __init__(self, model_size: str, language: str | None):
        self.model_size = model_size
        self.language = language or None   # None — язык определяется автоматически
        self._model = None

    def _load(self):
        # Модель грузится один раз при первом голосовом (первый запуск скачивает её, ~0.5 ГБ для small)
        if self._model is None:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
        return self._model

    def _transcribe(self, path: Path) -> str:
        segments, _info = self._load().transcribe(
            str(path),
            language=self.language,
            beam_size=5,
            vad_filter=True,                    # отрезает тишину в начале и конце
            condition_on_previous_text=False,   # меньше «додумывания» текста
        )
        return " ".join(s.text.strip() for s in segments).strip()

    async def transcribe(self, path: Path) -> str:
        # Whisper работает синхронно и грузит CPU — уносим в отдельный поток, чтобы бот не зависал
        return await asyncio.to_thread(self._transcribe, path)


class TextToSpeech:
    def __init__(self, voice: str, rate: str):
        self.voice = voice
        self.rate = rate

    async def synthesize(self, text: str, out_ogg: Path) -> None:
        """Текст → MP3 (edge-tts) → OGG/Opus: только такой файл Telegram показывает как голосовое."""
        mp3 = out_ogg.with_suffix(".mp3")
        await edge_tts.Communicate(text, self.voice, rate=self.rate).save(str(mp3))
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3),
            "-c:a", "libopus", "-b:a", "48k", "-ac", "1", str(out_ogg),
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg: {err.decode(errors='replace')}")
