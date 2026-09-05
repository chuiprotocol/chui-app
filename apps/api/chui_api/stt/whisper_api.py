"""OpenAI 相容的 Whisper 轉錄 API。

POST {STT_API_BASE}/audio/transcriptions（multipart），language=zh。
API 只回單一最佳結果，n-best 交由重排序層的語音距離比對彌補。
"""

import httpx

from .. import config


async def transcribe_via_api(audio_bytes: bytes, filename: str) -> list[str]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{config.STT_API_BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {config.STT_API_KEY}"},
            files={"file": (filename, audio_bytes)},
            data={
                "model": config.STT_API_MODEL,
                "language": "zh",
                # 提示模型輸出繁體中文（Whisper 對 initial prompt 敏感）
                "prompt": "以下是台灣小吃店的語音點餐對話，使用繁體中文。"
                          "內容可能是餐點名稱與規格，也可能是指令："
                          "確認下單、取消、結束對話。",
            },
        )
        resp.raise_for_status()
        text = resp.json().get("text", "").strip()
        if not text:
            raise RuntimeError("STT 回傳空白結果")
        return [text]
