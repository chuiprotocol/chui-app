"""本地 faster-whisper STT（離線備援）。

faster-whisper 不暴露 n-best，因此用兩種 temperature 各取一個候選，
交由重排序層挑選。模型第一次使用會自動下載，之後完全離線。
"""

import asyncio
import tempfile
from pathlib import Path

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        # small + int8：CPU 可即時處理短句點餐音檔
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    return _model


def _transcribe_sync(audio_path: str) -> list[str]:
    model = _get_model()
    candidates: list[str] = []
    for temperature in (0.0, 0.4):
        segments, _info = model.transcribe(
            audio_path,
            language="zh",
            beam_size=5,
            temperature=temperature,
            vad_filter=True,
            initial_prompt="以下是台灣的早餐店點餐內容，使用繁體中文。",
        )
        text = "".join(seg.text for seg in segments).strip()
        if text and text not in candidates:
            candidates.append(text)
    if not candidates:
        raise RuntimeError("本地 STT 沒有辨識出任何文字")
    return candidates


async def transcribe_local(audio_bytes: bytes, filename: str) -> list[str]:
    suffix = Path(filename).suffix or ".m4a"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    try:
        # CPU 密集工作丟到 thread pool，避免卡住 event loop
        return await asyncio.to_thread(_transcribe_sync, tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
