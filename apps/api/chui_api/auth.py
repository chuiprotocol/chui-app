"""驗證與授權：店家 API key、消費者 session、rate limit、防重放。"""

import secrets
import threading
import time

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import config
from .crypto import hash_api_key, verify_session
from .db import get_db
from .errors import AuthError, RateLimitedError, ReplayError
from .models import Consumer, Merchant, UsedNonce

# ---- Rate limit（單機記憶體滑動視窗；多實例部署需換 Redis）----

_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = {}


def check_rate_limit(key: str, limit_per_minute: int) -> None:
    now = time.monotonic()
    with _rate_lock:
        bucket = _rate_buckets.setdefault(key, [])
        cutoff = now - 60.0
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)
        if len(bucket) >= limit_per_minute:
            raise RateLimitedError("請求太頻繁，請稍後再試")
        bucket.append(now)


# ---- 店家 API key ----

def require_merchant(
    request: Request,
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Merchant:
    """Authorization: Bearer chui_sk_... → Merchant。同時套 rate limit。"""
    if not authorization.startswith("Bearer "):
        raise AuthError("缺少 API key（Authorization: Bearer chui_sk_...）")
    api_key = authorization.removeprefix("Bearer ").strip()
    merchant = db.scalar(select(Merchant).where(Merchant.api_key_hash == hash_api_key(api_key)))
    if merchant is None:
        raise AuthError("API key 無效")
    limit = (
        config.RATE_LIMIT_PARSE_PER_MINUTE
        if request.url.path.endswith("/orders/parse")
        else config.RATE_LIMIT_PER_MINUTE
    )
    check_rate_limit(f"mch:{merchant.id}:{'parse' if limit == config.RATE_LIMIT_PARSE_PER_MINUTE else 'all'}", limit)
    return merchant


# ---- 消費者 session（httpOnly cookie，絕不使用 localStorage）----

def require_consumer(
    chui_session: str = Cookie(default=""),
    db: Session = Depends(get_db),
) -> Consumer:
    if not config.SESSION_SECRET:
        raise AuthError("伺服器未設定 CHUI_SESSION_SECRET，消費者功能停用")
    if not chui_session:
        raise AuthError("尚未登入")
    payload = verify_session(config.SESSION_SECRET, chui_session)
    if not payload or payload.get("typ") != "consumer":
        raise AuthError("session 無效")
    if payload.get("exp", 0) < int(time.time()):
        raise AuthError("session 已過期，請重新登入")
    consumer = db.get(Consumer, payload.get("sub", ""))
    if consumer is None:
        raise AuthError("帳號不存在")
    check_rate_limit(f"csr:{consumer.id}", config.RATE_LIMIT_PER_MINUTE)
    return consumer


# ---- 防重放：nonce + timestamp ----

def verify_nonce_and_timestamp(db: Session, nonce: str, timestamp: str) -> None:
    """每個結算請求都要驗證：timestamp 在容許誤差內、nonce 未曾出現過。"""
    if not nonce or not timestamp:
        raise ReplayError("缺少 X-Chui-Nonce 或 X-Chui-Timestamp")
    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise ReplayError("X-Chui-Timestamp 必須是 Unix 秒數") from exc
    now = int(time.time())
    if abs(now - ts) > config.TIMESTAMP_TOLERANCE_SECONDS:
        raise ReplayError("timestamp 超出容許誤差，請校時後重試")
    if db.get(UsedNonce, nonce) is not None:
        raise ReplayError("nonce 已被使用過（重放攻擊防護）")
    db.add(UsedNonce(nonce=nonce, seen_at=now))
    # 順手清掉過期 nonce，資料表不會無限成長
    db.execute(delete(UsedNonce).where(UsedNonce.seen_at < now - 2 * config.TIMESTAMP_TOLERANCE_SECONDS))
    db.commit()


def new_challenge() -> str:
    return secrets.token_urlsafe(32)
