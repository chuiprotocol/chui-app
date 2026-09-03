"""鏈上結算驗證：向 fullnode 查交易的 SettlementEvent，
比對 digest／amount／merchant 三者皆符才標記已結算。

Hub 絕不憑空標記已付款：查不到、連不上一律 pending_verification。
"""

import base64
import os

import httpx

SUI_NETWORK = os.environ.get("SUI_NETWORK", "testnet")
if SUI_NETWORK == "mainnet":  # 與整個專案一致的防呆
    raise RuntimeError("SUI_NETWORK=mainnet 目前被明確封鎖：只允許 testnet/devnet。")
SUI_FULLNODE_URL = os.environ.get("SUI_FULLNODE_URL", f"https://fullnode.{SUI_NETWORK}.sui.io:443")
CHUI_PACKAGE_ID = os.environ.get("CHUI_PACKAGE_ID", "")


def explorer_tx_url(digest: str) -> str:
    return f"https://suiscan.xyz/{SUI_NETWORK}/tx/{digest}"


def _digest_bytes_from_event(value) -> bytes:
    """事件裡的 vector<u8> 依節點版本可能是 int 陣列或 base64 字串。"""
    if isinstance(value, list):
        return bytes(value)
    if isinstance(value, str):
        try:
            return base64.b64decode(value)
        except Exception:
            return bytes.fromhex(value)
    return b""


async def verify_settlement(tx_digest: str, expected_digest_hex: str,
                            expected_amount_units: int, expected_merchant: str) -> dict:
    """回傳 {verified: bool, reason: str}。連不上 fullnode 時 verified=False。"""
    if not CHUI_PACKAGE_ID:
        return {"verified": False, "reason": "CHUI_PACKAGE_ID 未設定，無法核對事件型別"}
    event_type = f"{CHUI_PACKAGE_ID}::pay::SettlementEvent"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(SUI_FULLNODE_URL, json={
                "jsonrpc": "2.0", "id": 1,
                "method": "sui_getTransactionBlock",
                "params": [tx_digest, {"showEvents": True, "showEffects": True}],
            })
            resp.raise_for_status()
            body = resp.json()
    except Exception as exc:
        return {"verified": False, "reason": f"無法連線 fullnode：{exc}"}

    if "error" in body:
        return {"verified": False, "reason": f"fullnode 回報錯誤：{body['error'].get('message')}"}
    result = body.get("result", {})
    status = (result.get("effects", {}).get("status", {}) or {}).get("status", "")
    if status != "success":
        return {"verified": False, "reason": f"交易未成功（status={status or '未知'}）"}

    for event in result.get("events", []) or []:
        if event.get("type") != event_type:
            continue
        parsed = event.get("parsedJson", {}) or {}
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
