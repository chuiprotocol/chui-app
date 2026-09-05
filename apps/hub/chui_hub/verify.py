"""鏈上結算驗證：查交易的 SettlementEvent，
比對 digest／amount／merchant 三者皆符才標記已結算。

Sui 公共 fullnode 已停用 JSON-RPC（回報「Method not found… migrate to
gRPC or GraphQL」），這裡改走官方 GraphQL 端點；事件欄位在新版 schema
掛在 Event.contents 底下、舊版直接在 Event 上——兩種都試，誠實回報。

Hub 絕不憑空標記已付款：查不到、連不上一律 pending_verification。
"""

import base64
import os

import httpx

SUI_NETWORK = os.environ.get("SUI_NETWORK", "testnet")
if SUI_NETWORK == "mainnet":  # 與整個專案一致的防呆
    raise RuntimeError("SUI_NETWORK=mainnet 目前被明確封鎖：只允許 testnet/devnet。")
SUI_GRAPHQL_URL = os.environ.get(
    "SUI_GRAPHQL_URL", f"https://sui-{SUI_NETWORK}.mystenlabs.com/graphql")
CHUI_PACKAGE_ID = os.environ.get("CHUI_PACKAGE_ID", "")
# 合約 module／結算函式（自寫 vault 版預設值）
CHUI_MODULE = os.environ.get("CHUI_MODULE", "vault")
CHUI_FN_SETTLE = os.environ.get("CHUI_FN_SETTLE", "agent_settle")

# 新版 schema：事件內容在 Event.contents（MoveValue）
_QUERY_CONTENTS = """
query ($digest: String!) {
  transactionBlock(digest: $digest) {
    effects {
      status
      events { nodes { contents { type { repr } json } } }
    }
  }
}
"""
# 舊版 schema：type / json 直接在 Event 上
_QUERY_LEGACY = """
query ($digest: String!) {
  transactionBlock(digest: $digest) {
    effects {
      status
      events { nodes { type { repr } json } }
    }
  }
}
"""


def explorer_tx_url(digest: str) -> str:
    return f"https://suiscan.xyz/{SUI_NETWORK}/tx/{digest}"


def _digest_bytes_from_event(value) -> bytes:
    """事件裡的 vector<u8> 依節點版本可能是 int 陣列或 base64／hex 字串。"""
    if isinstance(value, list):
        return bytes(value)
    if isinstance(value, str):
        try:
            return base64.b64decode(value)
        except Exception:
            return bytes.fromhex(value)
    return b""


def _extract_events(tx_block: dict) -> tuple[str, list[tuple[str, dict]]]:
    """回傳（執行狀態, [(事件型別, 事件 json)]）——新舊 schema 通吃。"""
    effects = tx_block.get("effects") or {}
    status = str(effects.get("status", ""))
    events = []
    for node in ((effects.get("events") or {}).get("nodes") or []):
        holder = node.get("contents") or node  # 新版在 contents、舊版在自身
        type_repr = str(((holder.get("type") or {}).get("repr")) or "")
        events.append((type_repr, holder.get("json") or {}))
    return status, events


async def verify_settlement(tx_digest: str, expected_digest_hex: str,
                            expected_amount_units: int, expected_merchant: str) -> dict:
    """回傳 {verified: bool, reason: str}。連不上節點時 verified=False。"""
    if not CHUI_PACKAGE_ID:
        return {"verified": False, "reason": "CHUI_PACKAGE_ID 未設定，無法核對事件型別"}
    event_type = f"{CHUI_PACKAGE_ID}::{CHUI_MODULE}::SettlementEvent"

    body = None
    last_error = ""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            for query in (_QUERY_CONTENTS, _QUERY_LEGACY):
                resp = await client.post(SUI_GRAPHQL_URL, json={
                    "query": query, "variables": {"digest": tx_digest},
                })
                resp.raise_for_status()
                candidate = resp.json()
                if candidate.get("errors"):
                    # schema 不合（如 contents 欄位不存在）→ 換舊版查詢再試
                    last_error = str(candidate["errors"][0].get("message", ""))[:200]
                    continue
                body = candidate
                break
    except Exception as exc:
        return {"verified": False, "reason": f"無法連線 Sui GraphQL：{exc}"}
    if body is None:
        return {"verified": False, "reason": f"GraphQL 回報錯誤：{last_error or '未知'}"}

    tx_block = (body.get("data") or {}).get("transactionBlock")
    if not tx_block:
        return {"verified": False, "reason": "GraphQL 查無此交易（可能尚未索引，稍後重試）"}
    status, events = _extract_events(tx_block)
    if status.upper() != "SUCCESS":
        return {"verified": False, "reason": f"交易未成功（status={status or '未知'}）"}

    for type_repr, parsed in events:
        if type_repr != event_type:
            continue
        got_digest = _digest_bytes_from_event(parsed.get("order_digest")).hex()
        got_amount = int(str(parsed.get("amount", "0")))
        got_merchant = str(parsed.get("merchant", ""))
        if got_digest != expected_digest_hex:
            return {"verified": False, "reason": "事件中的 order_digest 與訂單不符"}
        if got_amount != expected_amount_units:
            return {"verified": False,
                    "reason": f"事件金額 {got_amount} ≠ 預期 {expected_amount_units}"}
        if got_merchant.lower() != expected_merchant.lower():
            return {"verified": False, "reason": "事件收款地址與店家不符"}
        return {"verified": True, "reason": "digest／amount／merchant 三者皆符"}
    return {"verified": False, "reason": "交易中沒有本協議的 SettlementEvent"}
