"""TTS 降級鏈：ElevenLabs 失敗 → edge-tts → 快取片段拼接 → 明確報錯。"""

import asyncio

import pytest

from chui_api import tts

FAKE_MP3_A = b"\xff\xfb\x90\x00" + b"A" * 64
FAKE_MP3_B = b"\xff\xfb\x90\x00" + b"B" * 64


async def _fail(*_args, **_kwargs):
    raise RuntimeError("模擬失敗")


async def _hang(*_args, **_kwargs):
    await asyncio.sleep(10)  # 超過 3 秒 timeout


def test_elevenlabs_failure_falls_back_to_edge(monkeypatch):
    monkeypatch.setattr(tts, "_elevenlabs_tts", _fail)

    async def fake_edge(_text):
        return FAKE_MP3_A

    monkeypatch.setattr(tts, "_edge_tts", fake_edge)
    audio, source = asyncio.run(tts.synthesize("測試句一"))
    assert audio == FAKE_MP3_A
    assert source == "edge-tts"


def test_elevenlabs_timeout_falls_back(monkeypatch):
    # ElevenLabs 卡住超過 3 秒 → 視同失敗，立刻走 edge-tts
    monkeypatch.setattr(tts, "_elevenlabs_tts", _hang)

    async def fake_edge(_text):
        return FAKE_MP3_B

    monkeypatch.setattr(tts, "_edge_tts", fake_edge)
    audio, source = asyncio.run(tts.synthesize("測試句二"))
    assert source == "edge-tts"
    assert audio == FAKE_MP3_B


def test_cache_hit_short_circuits(monkeypatch):
    tts.cache_put("快取句", FAKE_MP3_A)
    # 兩個線上路徑都炸掉也無所謂——快取先命中
    monkeypatch.setattr(tts, "_elevenlabs_tts", _fail)
    monkeypatch.setattr(tts, "_edge_tts", _fail)
    audio, source = asyncio.run(tts.synthesize("快取句"))
    assert source == "cache"
    assert audio == FAKE_MP3_A


def test_offline_fragment_concatenation(monkeypatch):
    """完全離線（兩個 TTS 都失敗）時，用預建快取片段拼出完整覆誦。"""
    monkeypatch.setattr(tts, "_elevenlabs_tts", _fail)
    monkeypatch.setattr(tts, "_edge_tts", _fail)
    fragments = ["中杯", "冰", "奶茶", "總共 25 元，確認嗎？"]
    for frag in fragments:
        tts.cache_put(frag, FAKE_MP3_A)
    audio, source = asyncio.run(tts.synthesize_readback("中杯冰奶茶，總共 25 元，確認嗎？", fragments))
    assert source == "cache-fragments"
    assert audio == FAKE_MP3_A * len(fragments)


def test_all_paths_dead_raises_named_error(monkeypatch):
    monkeypatch.setattr(tts, "_elevenlabs_tts", _fail)
    monkeypatch.setattr(tts, "_edge_tts", _fail)
    with pytest.raises(tts.TtsUnavailableError):
        asyncio.run(tts.synthesize_readback("沒快取的句子", ["沒快取的片段"]))
