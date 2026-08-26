"""鏈上服務 client。

實際的 Sui 互動由 Node sidecar（apps/api/chain-service，使用官方
@mysten/sui SDK）執行；本模組只負責透過 localhost 內部呼叫轉發，
並把 sidecar 的錯誤翻成具名 API 錯誤。

sidecar 未設定 package ID 時會回 CHAIN_NOT_CONFIGURED——我們把它
原樣往上拋，絕不偽造結算結果。
"""

import httpx

from . import config
from .errors import ChainError, ChainNotConfiguredError


def _headers() -> dict:
    return {"Authorization": f"Bearer {config.CHAIN_SERVICE_TOKEN}"}


async def _post(path: str, payload: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{config.CHAIN_SERVICE_URL}{path}", json=payload, headers=_headers()
            )
    except httpx.HTTPError as exc:
        raise ChainError(f"無法連線 chain-service：{exc}") from exc
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code == 503 and body.get("code") == "CHAIN_NOT_CONFIGURED":
        raise ChainNotConfiguredError(body.get("message", "鏈上參數未設定"))
    if resp.status_code >= 400:
        # move_abort 帶回合約具名錯誤（E_OVER_PER_TX 等）
        raise ChainError(
            body.get("message", f"chain-service 錯誤（HTTP {resp.status_code}）"),
            move_abort=body.get("move_abort", ""),
            tx_digest=body.get("tx_digest", ""),
        )
    return body


async def verify_personal_message(address: str, message_b64: str, signature: str) -> bool:
    body = await _post("/internal/verify-signature", {
        "address": address, "messageB64": message_b64, "signature": signature,
    })
    return bool(body.get("valid"))


async def build_mandate_tx(consumer_address: str, per_tx_limit: int, total_limit: int,
                           deposit: int) -> dict:
    """建立 Mandate 的 sponsored tx bytes（消費者簽名用）。

    deposit：消費者存入 Mandate 的測試幣額度（元，整數），結算從這裡扣。
    """
    return await _post("/internal/mandate/build", {
        "consumer": consumer_address,
        "perTxLimit": per_tx_limit,
        "totalLimit": total_limit,
        "deposit": deposit,
    })


async def execute_sponsored_tx(tx_bytes_b64: str, user_signature: str) -> dict:
    return await _post("/internal/execute", {
        "txBytesB64": tx_bytes_b64,
        "userSignature": user_signature,
    })


async def build_revoke_tx(consumer_address: str, mandate_onchain_id: str) -> dict:
    return await _post("/internal/mandate/revoke/build", {
        "consumer": consumer_address,
        "mandateId": mandate_onchain_id,
    })


async def settle(mandate_onchain_id: str, merchant_address: str, amount: int,
                 digest_hex: str) -> dict:
    """鏈上結算：operator 對 Mandate 執行扣款，只上 digest 不上明細。"""
    return await _post("/internal/settle", {
        "mandateId": mandate_onchain_id,
        "merchant": merchant_address,
        "amount": amount,
        "digestHex": digest_hex,
    })


async def current_epoch() -> int:
    """目前 epoch（zkLogin maxEpoch 計算用）。"""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{config.CHAIN_SERVICE_URL}/internal/epoch", headers=_headers())
            resp.raise_for_status()
            return int(resp.json()["epoch"])
    except Exception as exc:
        raise ChainError(f"無法取得目前 epoch：{exc}") from exc


async def health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{config.CHAIN_SERVICE_URL}/internal/health", headers=_headers())
            return resp.json()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
