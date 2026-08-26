"""TTS 合成，含三層降級：

1. 快取（build 階段由 scripts/prebuild-tts.py 預先合成）→ 零延遲、離線可用
2. ElevenLabs（3 秒 timeout，逾時視同失敗）
3. edge-tts 備援
4. 全部失敗時：把句子拆成片段逐一從快取撈出來拼接（完全離線也能覆誦）

任何路徑成功都會回寫快取，讓下一次直接命中。
"""

import asyncio
import hashlib

import httpx

from .. import config
from ..errors import ChuiError


class TtsUnavailableError(ChuiError):
    code = "TTS_UNAVAILABLE"
    status_code_default = 503


def _cache_path(text: str):
    # 快取鍵包含語音設定，換聲音不會撈到舊檔
    profile = f"{config.EDGE_TTS_VOICE}|{config.ELEVENLABS_VOICE_ID}"
    key = hashlib.sha1(f"{profile}|{text}".encode()).hexdigest()
    return config.TTS_CACHE_DIR / f"{key}.mp3"


def cache_get(text: str) -> bytes | None:
    p = _cache_path(text)
    if p.exists():
        return p.read_bytes()
    return None


def cache_put(text: str, audio: bytes) -> None:
    config.TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(text).write_bytes(audio)


async def _elevenlabs_tts(text: str) -> bytes:
    """ElevenLabs REST API，3 秒 timeout。"""
    if not config.ELEVENLABS_API_KEY or not config.ELEVENLABS_VOICE_ID:
        raise RuntimeError("未設定 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID")
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{config.ELEVENLABS_VOICE_ID}"
        "?output_format=mp3_44100_128"
    )
    async with httpx.AsyncClient(timeout=config.ELEVENLABS_TIMEOUT_SECONDS) as client:
        resp = await client.post(
            url,
            headers={"xi-api-key": config.ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={
                "text": text,
                "model_id": config.ELEVENLABS_MODEL_ID,
                "language_code": "zh",
            },
        )
        resp.raise_for_status()
        if not resp.content:
            raise RuntimeError("ElevenLabs 回傳空音檔")
        return resp.content


async def _edge_tts(text: str) -> bytes:
    """edge-tts 備援（台灣華語 voice）。"""
    import edge_tts

    communicate = edge_tts.Communicate(text, config.EDGE_TTS_VOICE)
    chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    if not chunks:
        raise RuntimeError("edge-tts 回傳空音檔")
    return b"".join(chunks)


async def synthesize(text: str) -> tuple[bytes, str]:
    """單句合成。回傳 (mp3 bytes, 來源標記)。"""
    cached = cache_get(text)
    if cached:
        return cached, "cache"

    try:
        audio = await asyncio.wait_for(
            _elevenlabs_tts(text), timeout=config.ELEVENLABS_TIMEOUT_SECONDS
        )
        cache_put(text, audio)
        return audio, "elevenlabs"
    except Exception:
        pass  # 依規格：逾時或失敗即刻 fallback，不重試不等待

    try:
        audio = await _edge_tts(text)
        cache_put(text, audio)
        return audio, "edge-tts"
    except Exception as exc:
        raise TtsUnavailableError(f"ElevenLabs 與 edge-tts 都失敗：{exc}") from exc


async def synthesize_readback(fragments: list[str]) -> tuple[bytes, str]:
    """覆誦合成：先試整句，全部線上路徑失敗時退回「快取片段拼接」。

    fragments 是覆誦句的組成片段（品項描述、金額句），與 prebuild 腳本
    產生的快取片段一一對應，斷網時仍能拼出完整覆誦。
    """
    full_text = "，".join(fragments)
    try:
        return await synthesize(full_text)
    except TtsUnavailableError:
        pieces: list[bytes] = []
        missing: list[str] = []
        for frag in fragments:
            audio = cache_get(frag)
            if audio is None:
                missing.append(frag)
            else:
                pieces.append(audio)
        if missing:
            raise TtsUnavailableError(
                "離線快取缺少片段：" + "、".join(missing) + "。請執行 scripts/prebuild-tts.py。"
            )
        # MP3 frame 串接：同一組 voice/取樣率的片段直接連接即可播放
        return b"".join(pieces), "cache-fragments"
