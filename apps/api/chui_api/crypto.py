"""加密與雜湊工具。

- 訂單明細：AES-256-GCM 加密後才落地，金鑰回傳給消費者後伺服器即丟棄。
- 上鏈內容：只有 SHA-256(canonical_json ‖ salt) 的 digest，salt 為每筆訂單
  全新的 32 bytes CSPRNG 隨機值。
- API key：只儲存 SHA-256 雜湊。
"""

import base64
import hashlib
import hmac
import json
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

API_KEY_PREFIX = "chui_sk_"


def generate_api_key() -> tuple[str, str]:
    """產生 API key。回傳 (明文 key, 儲存用 hash)。明文只在註冊當下回傳一次。"""
    raw = API_KEY_PREFIX + secrets.token_urlsafe(32)
    return raw, hash_api_key(raw)


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def canonical_json(obj) -> bytes:
    """決定性序列化：鍵排序、無多餘空白、UTF-8。digest 的可重現性靠這個。"""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def new_salt() -> bytes:
    """每筆訂單全新的 32 bytes CSPRNG salt。"""
    return secrets.token_bytes(32)


def order_digest(details: dict, salt: bytes) -> str:
    """上鏈用 digest：SHA-256(canonical_json(details) ‖ salt)，hex 字串。"""
    return hashlib.sha256(canonical_json(details) + salt).hexdigest()


def encrypt_order_details(details: dict) -> tuple[str, str, str]:
    """以全新隨機金鑰加密訂單明細。

    回傳 (ciphertext_b64, nonce_b64, key_b64)。
    key_b64 交給消費者保管，伺服器「不儲存」——這是隱私設計的核心。
    """
    key = AESGCM.generate_key(bit_length=256)
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, canonical_json(details), None)
    return (
        base64.b64encode(ct).decode(),
        base64.b64encode(nonce).decode(),
        base64.b64encode(key).decode(),
    )


def decrypt_order_details(ciphertext_b64: str, nonce_b64: str, key_b64: str) -> dict:
    """解密訂單明細（消費者端 verify 流程用；伺服器沒有金鑰所以自己解不開）。"""
    key = base64.b64decode(key_b64)
    nonce = base64.b64decode(nonce_b64)
    ct = base64.b64decode(ciphertext_b64)
    return json.loads(AESGCM(key).decrypt(nonce, ct, None))


def sign_webhook_payload(secret: str, timestamp: str, body: bytes) -> str:
    """Webhook 簽章：v1=HMAC-SHA256(secret, f"{timestamp}.{body}")。"""
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256)
    return mac.hexdigest()


def verify_webhook_signature(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign_webhook_payload(secret, timestamp, body), signature)


def sign_session(secret: str, payload: dict) -> str:
    """極簡 session token：base64(json).hmac。避免引入 JWT 相依。"""
    body = base64.urlsafe_b64encode(canonical_json(payload)).decode().rstrip("=")
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def verify_session(secret: str, token: str) -> dict | None:
    try:
        body, mac = token.rsplit(".", 1)
        expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, mac):
            return None
        padded = body + "=" * (-len(body) % 4)
        return json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return None
