"""EastRouter LLM 備援（低信心救援）。

封閉詞彙重排序信心不足時，把 STT 原文交給 EastRouter（OpenAI 相容
API）重述成「只含菜單詞彙的標準點餐句」，再走一次封閉詞彙解析。

安全邊界：
- LLM 只做「重述」，重述句仍要通過封閉詞彙解析、口頭確認、5 秒防呆
  倒數才會扣款——LLM 永遠碰不到金流決策。
- 三個環境變數（EASTROUTER_BASE_URL / EASTROUTER_API_KEY /
  EASTROUTER_MODEL）齊了才啟用；缺任何一個就完全跳過（不猜端點）。
- 呼叫失敗／逾時一律回 None，走原本的澄清流程——備援絕不擋主流程。
"""

import os

import httpx

# 通用 OpenAI 相容供應商：EastRouter／GMI Cloud／AMD 的 LLM API 都可插。
# 先讀通用 LLM_*，沒有再退回舊名 EASTROUTER_*（相容既有設定）。
EASTROUTER_BASE_URL = (os.environ.get("LLM_BASE_URL")
                       or os.environ.get("EASTROUTER_BASE_URL", "")).rstrip("/")
EASTROUTER_API_KEY = (os.environ.get("LLM_API_KEY")
                      or os.environ.get("EASTROUTER_API_KEY", ""))
EASTROUTER_MODEL = (os.environ.get("LLM_MODEL")
                    or os.environ.get("EASTROUTER_MODEL", ""))
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "eastrouter")


def enabled() -> bool:
    return bool(EASTROUTER_BASE_URL and EASTROUTER_API_KEY and EASTROUTER_MODEL)


def build_prompt(text: str, menu_names: list[str]) -> str:
    """組重述提示（獨立函式方便單元測試）。"""
    vocab = "、".join(menu_names[:60])
    return (
        "你是台灣手搖飲／小吃店的點餐聽寫員。顧客的語音辨識原文可能有"
        "錯字或口語贅詞。請把它重述成一句「只使用下列菜單詞彙」的標準"
        f"點餐句，保留數量與選項；無法對應菜單就輸出「無法對應」。\n"
        f"菜單詞彙：{vocab}\n"
        f"辨識原文：{text}\n"
        "只輸出重述句，不要任何解釋。"
    )


async def rephrase_order(text: str, menu_names: list[str]) -> str | None:
    """回傳重述句；未啟用／失敗／模型說無法對應 → None。"""
    if not enabled() or not text.strip():
        return None
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(
                f"{EASTROUTER_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {EASTROUTER_API_KEY}"},
                json={
                    "model": EASTROUTER_MODEL,
                    "temperature": 0,
                    "messages": [{"role": "user", "content": build_prompt(text, menu_names)}],
                },
            )
            resp.raise_for_status()
            out = str(resp.json()["choices"][0]["message"]["content"]).strip()
    except Exception:
        return None
    if not out or "無法對應" in out or out == text:
        return None
    return out
