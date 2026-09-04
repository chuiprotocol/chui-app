"""Atlas Oracle 即時匯率（台幣定價 → USDC 扣款金額）。

菜單以台幣標價、鏈上以 USDC 結算——「1 元台幣值多少 USDC 最小單位」
這個數字，設定了 Atlas Oracle（贊助商，atlasoracle.io）就用它的
Pull API 即時簽章報價換算；沒設定或呼叫失敗，一律退回 .env 的
USDC_UNITS_PER_TWD 固定匯率（healthz 與封包面板誠實標示來源）。

環境變數：
- ATLAS_ORACLE_API_KEY：註冊後發的 API key（必填才啟用）
- ATLAS_FEED_ID：要拉的 feed（必填才啟用；用你有權限的 TWD 匯率 feed）
- ATLAS_FEED_MEANING：feed 報價的語意——
    TWD_USD（1 台幣值多少美元，預設）
    USD_TWD（1 美元值多少台幣）
    USDC_USD（1 USDC 值多少美元——Atlas 目前沒有台幣 feed 時用這個：
             加密腿走 oracle 即時價，台幣腿用 ATLAS_TWD_PER_USD 設定值）
- ATLAS_TWD_PER_USD：1 美元值多少台幣（預設 31.5；僅 USDC_USD 模式用，
  法幣腿為設定值、非即時——如實揭露，正式版可換台幣 feed）
- ATLAS_RATE_MULTIPLIER：換算後的縮放係數，預設 1.0。
  內部測試省測試幣可設 0.05（真實匯率的 5%），healthz 會如實顯示。
- ATLAS_ORACLE_BASE_URL：預設 https://api.atlasoracle.io/report

誠實聲明：回應帶簽章（簽章位址 0x59ed…c600），本模組目前「不」做
鏈下簽章驗證（需另引 keccak/secp256k1 相依）——簽章原文有保留在
快取內供事後稽核，驗章列為正式版 TODO。
"""

import json
import os
import time

import httpx

ATLAS_ORACLE_BASE_URL = os.environ.get(
    "ATLAS_ORACLE_BASE_URL", "https://api.atlasoracle.io/report").rstrip("/")
ATLAS_ORACLE_API_KEY = os.environ.get("ATLAS_ORACLE_API_KEY", "")
ATLAS_FEED_ID = os.environ.get("ATLAS_FEED_ID", "")
ATLAS_FEED_MEANING = os.environ.get("ATLAS_FEED_MEANING", "TWD_USD").upper()
ATLAS_RATE_MULTIPLIER = float(os.environ.get("ATLAS_RATE_MULTIPLIER", "1.0"))
ATLAS_TWD_PER_USD = float(os.environ.get("ATLAS_TWD_PER_USD", "31.5"))

_CACHE_TTL_SECONDS = 30
_cache: dict = {"at": 0.0, "units": None, "raw": None}


def enabled() -> bool:
    return bool(ATLAS_ORACLE_API_KEY and ATLAS_FEED_ID)


def units_per_twd_from_price(
    price: float, meaning: str, multiplier: float, twd_per_usd: float = 31.5,
) -> int:
    """feed 價格 → 1 台幣的 USDC 最小單位（6 位小數）。

    TWD_USD ：price＝1 TWD 值多少 USD → units = price × 1e6（視 USDC≈USD）
    USD_TWD ：price＝1 USD 值多少 TWD → units = 1e6 ÷ price（視 USDC≈USD）
    USDC_USD：price＝1 USDC 值多少 USD（Atlas 現有的 feed）→
              1 TWD = 1/twd_per_usd USD = (1/twd_per_usd)/price USDC
              加密腿即時、台幣腿為設定值（如實揭露）。
    金額全程整數：這裡是唯一的浮點運算點，出口即取整。
    """
    if price <= 0:
        raise ValueError(f"oracle 價格必須為正：{price}")
    if meaning == "TWD_USD":
        units = price * 1_000_000
    elif meaning == "USD_TWD":
        units = 1_000_000 / price
    elif meaning == "USDC_USD":
        if twd_per_usd <= 0:
            raise ValueError(f"ATLAS_TWD_PER_USD 必須為正：{twd_per_usd}")
        units = 1_000_000 / twd_per_usd / price
    else:
        raise ValueError(f"未知的 ATLAS_FEED_MEANING：{meaning}")
    units = int(round(units * multiplier))
    if units <= 0:
        raise ValueError(f"換算後匯率為零（price={price}, multiplier={multiplier}）")
    return units


def parse_latest_response(body: dict, feed_id: str) -> float:
    """Pull API 回應 → 該 feed 的價格（parsedPayload.price ÷ 1e18）。"""
    payload = json.loads(body["data"]["parsedPayload"])
    for entry in payload:
        if str(entry.get("feedId")) == str(feed_id):
            return int(entry["price"]) / 1e18
    raise ValueError(f"回應中沒有 feed {feed_id}")


async def units_per_twd() -> int | None:
    """回傳即時匯率（USDC 最小單位/元）；未啟用或失敗 → None（退回固定匯率）。"""
    if not enabled():
        return None
    now = time.monotonic()
    if _cache["units"] is not None and now - _cache["at"] < _CACHE_TTL_SECONDS:
        return _cache["units"]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{ATLAS_ORACLE_BASE_URL}/v1/price/latest",
                headers={"X-API-KEY": ATLAS_ORACLE_API_KEY,
                         "Content-Type": "application/json"},
                json={"feedIds": [ATLAS_FEED_ID], "signed": True},
            )
            resp.raise_for_status()
            body = resp.json()
        price = parse_latest_response(body, ATLAS_FEED_ID)
        units = units_per_twd_from_price(
            price, ATLAS_FEED_MEANING, ATLAS_RATE_MULTIPLIER, ATLAS_TWD_PER_USD)
    except Exception:
        return None  # 失敗退回固定匯率——絕不擋點餐主流程
    _cache.update(at=now, units=units, raw=body["data"])  # raw 含簽章，留供稽核
    return units
