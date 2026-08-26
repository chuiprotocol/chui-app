"""消費者面 API：登入（簽章驗證）、Mandate 建立／撤銷（sponsored tx）、收據。"""

import base64
import time

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import chain, config
from ..auth import new_challenge, require_consumer
from ..crypto import sign_session
from ..db import get_db
from ..errors import AuthError, NotFoundError, ValidationFailedError
from ..models import AuthChallenge, Consumer, Mandate, Merchant, Order

router = APIRouter(prefix="/v1", tags=["consumers"])


# ---- 登入：challenge → 錢包簽章（zkLogin 或 ed25519）→ session cookie ----

@router.post("/auth/challenge")
def create_challenge(db: Session = Depends(get_db)):
    challenge = new_challenge()
    db.add(AuthChallenge(challenge=challenge))
    db.commit()
    return {"challenge": challenge, "message_to_sign": f"Chui 登入驗證：{challenge}"}


class LoginRequest(BaseModel):
    address: str = Field(min_length=3)
    challenge: str
    signature: str = Field(description="對 message_to_sign 的個人訊息簽章（支援 zkLogin 與 ed25519）")


@router.post("/auth/login")
async def login(req: LoginRequest, response: Response, db: Session = Depends(get_db)):
    if not config.SESSION_SECRET:
        raise AuthError("伺服器未設定 CHUI_SESSION_SECRET")
    row = db.scalar(select(AuthChallenge).where(AuthChallenge.challenge == req.challenge))
    if row is None or row.used or row.created_at < int(time.time()) - 600:
        raise AuthError("challenge 無效或已過期")
    message = f"Chui 登入驗證：{req.challenge}"
    message_b64 = base64.b64encode(message.encode()).decode()
    valid = await chain.verify_personal_message(req.address, message_b64, req.signature)
    if not valid:
        raise AuthError("簽章驗證失敗")
    row.used = 1
    consumer = db.scalar(select(Consumer).where(Consumer.sui_address == req.address))
    if consumer is None:
        consumer = Consumer(sui_address=req.address)
        db.add(consumer)
    db.commit()
    token = sign_session(config.SESSION_SECRET, {
        "typ": "consumer", "sub": consumer.id, "exp": int(time.time()) + 7 * 24 * 3600,
    })
    response.set_cookie("chui_session", token, httponly=True, samesite="lax",
                        max_age=7 * 24 * 3600)
    return {"consumer_id": consumer.id, "address": consumer.sui_address}


class ZkLoginSaltRequest(BaseModel):
    jwt: str


@router.post("/auth/zklogin-salt")
def zklogin_salt(req: ZkLoginSaltRequest):
    """zkLogin salt 服務：驗證 OAuth JWT 後回傳決定性 salt。

    salt = HMAC-SHA256(master secret, iss|aud|sub) 取前 16 bytes。
    同一個 Google 帳號永遠拿到同一個 salt（地址才會固定）。
    Chui 營運方因此是 salt 保管者——這是明確寫在 README 的信任假設。
    """
    import hashlib as _hashlib
    import hmac as _hmac

    import jwt as pyjwt
    from jwt import PyJWKClient

    if not config.ZKLOGIN_SALT_MASTER_SECRET:
        raise AuthError("伺服器未設定 ZKLOGIN_SALT_MASTER_SECRET，zkLogin 停用")
    if not config.ZKLOGIN_ALLOWED_AUDIENCES:
        raise AuthError("伺服器未設定 ZKLOGIN_ALLOWED_AUDIENCES，zkLogin 停用")
    try:
        header = pyjwt.get_unverified_header(req.jwt)
        unverified = pyjwt.decode(req.jwt, options={"verify_signature": False})
        iss = unverified.get("iss", "")
        jwks_urls = {
            "https://accounts.google.com": "https://www.googleapis.com/oauth2/v3/certs",
        }
        if iss not in jwks_urls:
            raise AuthError(f"不支援的 OAuth issuer：{iss}")
        signing_key = PyJWKClient(jwks_urls[iss]).get_signing_key_from_jwt(req.jwt)
        claims = pyjwt.decode(
            req.jwt, signing_key.key, algorithms=[header.get("alg", "RS256")],
            audience=config.ZKLOGIN_ALLOWED_AUDIENCES,
        )
    except AuthError:
        raise
    except Exception as exc:
        raise AuthError(f"JWT 驗證失敗：{exc}") from exc
    material = f"{claims['iss']}|{claims['aud']}|{claims['sub']}".encode()
    digest = _hmac.new(config.ZKLOGIN_SALT_MASTER_SECRET.encode(), material, _hashlib.sha256).digest()
    # zkLogin salt 是 16-byte 整數（十進位字串）
    salt_int = int.from_bytes(digest[:16], "big")
    return {"salt": str(salt_int)}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie("chui_session")
    return {"ok": True}


@router.get("/auth/me")
def me(consumer: Consumer = Depends(require_consumer)):
    return {"consumer_id": consumer.id, "address": consumer.sui_address}


# ---- Mandate：兩段式（build → 瀏覽器簽名 → submit），gas 由贊助者支付 ----

class CreateMandateRequest(BaseModel):
    per_tx_limit: int = Field(gt=0, description="單筆上限（元，整數）")
    total_limit: int = Field(default=0, ge=0, description="總額上限（元，整數；0 表示不設）")
    deposit: int = Field(gt=0, description="存入 Mandate 的測試幣額度（元，整數），結算從這裡扣")


@router.post("/mandates")
async def create_mandate(req: CreateMandateRequest, consumer: Consumer = Depends(require_consumer),
                         db: Session = Depends(get_db)):
    """第一步：建立 sponsored tx bytes，交給瀏覽器用消費者錢包簽名。"""
    if req.deposit < req.per_tx_limit:
        raise ValidationFailedError("deposit 必須大於等於 per_tx_limit，否則授權一筆都扣不了")
    built = await chain.build_mandate_tx(
        consumer.sui_address, req.per_tx_limit, req.total_limit, req.deposit,
    )
    mandate = Mandate(
        consumer_id=consumer.id,
        per_tx_limit=req.per_tx_limit,
        total_limit=req.total_limit,
        status="pending",
    )
    db.add(mandate)
    db.commit()
    return {"mandate_id": mandate.id, "tx_bytes_b64": built["txBytesB64"]}


class SubmitMandateRequest(BaseModel):
    mandate_id: str
    tx_bytes_b64: str = Field(description="第一步回傳的 tx bytes（原樣帶回）")
    signature: str = Field(description="消費者錢包對 tx bytes 的簽章（zkLogin 或 ed25519）")


@router.post("/mandates/submit")
async def submit_mandate(req: SubmitMandateRequest, consumer: Consumer = Depends(require_consumer),
                         db: Session = Depends(get_db)):
    """第二步：帶消費者簽章執行 sponsored tx，回填鏈上 Mandate 物件 ID。"""
    mandate = db.get(Mandate, req.mandate_id)
    if mandate is None or mandate.consumer_id != consumer.id:
        raise NotFoundError("授權不存在")
    if mandate.status != "pending":
        raise ValidationFailedError(f"授權狀態為 {mandate.status}，不可重複提交")
    result = await chain.execute_sponsored_tx(req.tx_bytes_b64, req.signature)
    mandate.onchain_id = result.get("mandateId", "")
    mandate.create_tx_digest = result["txDigest"]
    mandate.status = "active" if mandate.onchain_id else "pending"
    db.add(mandate)
    db.commit()
    if not mandate.onchain_id:
        raise ValidationFailedError(
            "交易已執行但找不到鏈上 Mandate 物件 ID，請檢查 chain-service 設定",
        )
    return {
        "mandate_id": mandate.id,
        "onchain_id": mandate.onchain_id,
        "status": mandate.status,
        "tx_digest": mandate.create_tx_digest,
        "explorer_url": config.explorer_tx_url(mandate.create_tx_digest),
    }


@router.get("/mandates/me")
def my_mandates(consumer: Consumer = Depends(require_consumer), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Mandate).where(Mandate.consumer_id == consumer.id)
        .order_by(Mandate.created_at.desc())
    ).all()
    return {
        "mandates": [
            {
                "mandate_id": m.id,
                "onchain_id": m.onchain_id,
                "per_tx_limit": m.per_tx_limit,
                "total_limit": m.total_limit,
                "status": m.status,
                "explorer_url": config.explorer_object_url(m.onchain_id) if m.onchain_id else None,
                "created_at": m.created_at,
            }
            for m in rows
        ]
    }


class RevokeRequest(BaseModel):
    mandate_id: str


@router.post("/mandates/revoke")
async def revoke_mandate(req: RevokeRequest, consumer: Consumer = Depends(require_consumer),
                         db: Session = Depends(get_db)):
    """第一步：建立撤銷交易 bytes。撤銷在單一交易內生效。"""
    mandate = db.get(Mandate, req.mandate_id)
    if mandate is None or mandate.consumer_id != consumer.id:
        raise NotFoundError("授權不存在")
    if mandate.status != "active" or not mandate.onchain_id:
        raise ValidationFailedError("只有 active 且已上鏈的授權可以撤銷")
    built = await chain.build_revoke_tx(consumer.sui_address, mandate.onchain_id)
    return {"mandate_id": mandate.id, "tx_bytes_b64": built["txBytesB64"]}


class SubmitRevokeRequest(BaseModel):
    mandate_id: str
    tx_bytes_b64: str
    signature: str


@router.post("/mandates/revoke/submit")
async def submit_revoke(req: SubmitRevokeRequest, consumer: Consumer = Depends(require_consumer),
                        db: Session = Depends(get_db)):
    mandate = db.get(Mandate, req.mandate_id)
    if mandate is None or mandate.consumer_id != consumer.id:
        raise NotFoundError("授權不存在")
    result = await chain.execute_sponsored_tx(req.tx_bytes_b64, req.signature)
    mandate.status = "revoked"
    mandate.revoke_tx_digest = result["txDigest"]
    db.add(mandate)
    db.commit()
    return {
        "mandate_id": mandate.id,
        "status": "revoked",
        "tx_digest": result["txDigest"],
        "explorer_url": config.explorer_tx_url(result["txDigest"]),
    }


@router.get("/chain/epoch")
async def chain_epoch():
    """目前的 Sui epoch（前端 zkLogin 計算 maxEpoch 用）。"""
    return {"epoch": await chain.current_epoch(), "network": config.SUI_NETWORK}


# ---- 收據 ----

@router.get("/receipts")
def my_receipts(consumer: Consumer = Depends(require_consumer), db: Session = Depends(get_db)):
    """消費者的訂單收據。明細是密文，由前端以消費者持有的金鑰解密。"""
    rows = db.scalars(
        select(Order).where(Order.consumer_id == consumer.id)
        .order_by(Order.created_at.desc()).limit(200)
    ).all()
    merchant_names = {
        m.id: m.name
        for m in db.scalars(select(Merchant).where(Merchant.id.in_({r.merchant_id for r in rows}))).all()
    }
    return {
        "receipts": [
            {
                "order_id": o.id,
                "merchant_name": merchant_names.get(o.merchant_id, ""),
                "status": o.status,
                "total": o.total_amount,
                "currency": "TWD",
                "digest": o.digest_hex,
                "salt": o.salt_hex,
                "details_ciphertext": o.details_ciphertext,
                "details_nonce": o.details_nonce,
                "tx_digest": o.settle_tx_digest,
                "explorer_url": config.explorer_tx_url(o.settle_tx_digest) if o.settle_tx_digest else None,
                "created_at": o.created_at,
            }
            for o in rows
        ]
    }
