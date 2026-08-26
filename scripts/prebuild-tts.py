#!/usr/bin/env python3
"""prebuild-tts.py —— build 階段預先合成常見覆誦片段並快取。

產生內容（與 chui_api.menu.readback_fragments 的細粒度一一對應）：
- 菜單所有品項名稱與選項名稱
- 「N 份」（2～10）
- 「總共 N 元，確認嗎？」（1～上限，預設 300）
- 常用固定句（澄清、失敗提示）

執行時 TTS 會優先讀這些快取；會場斷網時靠片段拼接完成覆誦。

用法：
  python scripts/prebuild-tts.py --menu examples/happy-pig/menu.json
  python scripts/prebuild-tts.py --menu ... --max-amount 500 --concurrency 4

聲音來源：預設 edge-tts（免金鑰）。設定 ELEVENLABS_API_KEY 與
ELEVENLABS_VOICE_ID 時改用 ElevenLabs（較貴但音質好）。
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# 讓腳本能 import chui_api（不透過安裝）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from chui_api import config, tts  # noqa: E402

FIXED_PHRASES = [
    "不好意思，我沒有聽清楚，請再說一次您要點什麼。",
    "不好意思，我沒有對到菜單上的品項，請再說一次您要點什麼。",
    "好的，已取消這筆訂單。",
    "付款完成！",
    "付款沒有成功，請稍後再試。",
]


def collect_phrases(menu: dict, max_amount: int) -> list[str]:
    phrases: set[str] = set(FIXED_PHRASES)
    for item in menu["items"]:
        phrases.add(item["name"])
        for opt in item.get("options", []):
            for choice in opt["choices"]:
                phrases.add(choice["name"])
    for n in range(2, 11):
        phrases.add(f"{n} 份")
    for amount in range(1, max_amount + 1):
        phrases.add(f"總共 {amount} 元，確認嗎？")
    return sorted(phrases)


async def synth_one(sem: asyncio.Semaphore, phrase: str) -> tuple[str, str]:
    async with sem:
        if tts.cache_get(phrase) is not None:
            return phrase, "已存在"
        try:
            _audio, source = await tts.synthesize(phrase)
            return phrase, source
        except Exception as exc:
            return phrase, f"失敗：{exc}"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--menu", required=True, help="菜單 JSON 路徑")
    parser.add_argument("--max-amount", type=int, default=300, help="金額句上限（元）")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    menu = json.loads(Path(args.menu).read_text())
    phrases = collect_phrases(menu, args.max_amount)
    print(f"共 {len(phrases)} 個片段，快取目錄：{config.TTS_CACHE_DIR.resolve()}")

    sem = asyncio.Semaphore(args.concurrency)
    results = await asyncio.gather(*(synth_one(sem, p) for p in phrases))

    ok = sum(1 for _, s in results if not s.startswith("失敗"))
    failed = [(p, s) for p, s in results if s.startswith("失敗")]
    print(f"完成 {ok}/{len(phrases)}")
    if failed:
        print("失敗清單（重跑本腳本會自動補齊）：")
        for p, s in failed[:20]:
            print(f"  {p!r}: {s}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
