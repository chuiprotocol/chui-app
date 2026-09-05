"""鏈上結算驗證：查交易的 SettlementEvent，
比對 digest／amount／merchant 三者皆符才標記已結算。

查詢走官方 gRPC（Sui testnet 已停用公共節點 JSON-RPC；GraphQL 沒有
testnet 公開端點）——由一次性 Node 子行程（chain-service/src/txevents.js，
@mysten/sui 的 gRPC client，與手機前端同一套）代查，Hub 不需常駐 sidecar。

Hub 絕不憑空標記已付款：查不到、連不上一律 pending_verification。
"""

import asyncio
import base64
import json
import os
from pathlib import Path

SUI_NETWORK = os.environ.get("SUI_NETWORK", "testnet")
if SUI_NETWORK == "mainnet":  # 與整個專案一致的防呆
    raise RuntimeError("SUI_NETWORK=mainnet 目前被明確封鎖：只允許 testnet/devnet。")
CHUI_PACKAGE_ID = os.environ.get("CHUI_PACKAGE_ID", "")
# 合約 module／結算函式（自寫 vault 版預設值）
CHUI_MODULE = os.environ.get("CHUI_MODULE", "vault")
CHUI_FN_SETTLE = os.environ.get("CHUI_FN_SETTLE", "agent_settle")

# apps/hub/chui_hub/verify.py → repo 的 apps/ → api/chain-service/src/txevents.js
_TXEVENTS_JS = Path(__file__).resolve().parents[2] / "api" / "chain-service" / "src" / "txevents.js"


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


async def _fetch_tx_events(tx_digest: str) -> dict:
    """以 Node 子行程走 gRPC 查交易。回傳 txevents.js 的單行 JSON。"""
    proc = await asyncio.create_subprocess_exec(
        "node", str(_TXEVENTS_JS), tx_digest,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=25)
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "error": "gRPC 查詢逾時（25 秒）"}
    line = stdout.decode().strip().splitlines()[-1] if stdout.strip() else ""
    try:
        return json.loads(line)
    except Exception:
        err = stderr.decode().strip()[:200]
        return {"ok": False, "error": f"txevents 輸出無法解析：{err or line[:200]}"}


async def verify_settlement(tx_digest: str, expected_digest_hex: str,
                            expected_amount_units: int, expected_merchant: str) -> dict:
    """回傳 {verified: bool, reason: str}。查不到／連不上一律 verified=False。"""
    if not CHUI_PACKAGE_ID:
        return {"verified": False, "reason": "CHUI_PACKAGE_ID 未設定，無法核對事件型別"}
    event_type = f"{CHUI_PACKAGE_ID}::{CHUI_MODULE}::SettlementEvent"

    result = await _fetch_tx_events(tx_digest)
    if not result.get("ok"):
        return {"verified": False, "reason": f"鏈上查詢失敗：{result.get('error', '未知')}"}
    status = str(result.get("status", ""))
    if status != "SUCCESS":
        return {"verified": False, "reason": f"交易未成功（status={status or '未知'}）"}

    for event in result.get("events", []) or []:
        if event.get("type") != event_type:
            continue
        parsed = event.get("json", {}) or {}
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
        # owner＝鏈上事件裡的 Vault 擁有者（消費者錢包）——歷史查詢頁靠它
        # 對應「這筆訂單是誰的」，來源是鏈上事實而非前端自報
        return {"verified": True, "reason": "digest／amount／merchant 三者皆符",
                "owner": str(parsed.get("owner", ""))}
    return {"verified": False, "reason": "交易中沒有本協議的 SettlementEvent"}
