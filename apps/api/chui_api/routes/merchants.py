"""店家面 API：註冊、菜單、webhook、結算紀錄、console 登入。"""

import json
import secrets
import time

from fastapi import APIRouter, Cookie, Depends, Header, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import config
from ..auth import check_rate_limit
from ..crypto import generate_api_key, hash_api_key, sign_session, verify_session
from ..db import get_db
from ..errors import AuthError, ValidationFailedError
from ..menu import validate_menu
from ..models import Merchant, Settlement, WebhookEndpoint
from ..rerank import RerankEngine

router = APIRouter(prefix="/v1", tags=["merchants"])

# 菜單引擎快取：菜單更新時重建（key: merchant_id + menu_version）
_engine_cache: dict[str, RerankEngine] = {}


def get_engine(merchant: Merchant) -> RerankEngine:
    if not merchant.menu_json:
        raise ValidationFailedError("店家尚未上傳菜單，請先 PUT /v1/merchants/me/menu")
    key = f"{merchant.id}:{merchant.menu_version}"
    if key not in _engine_cache:
        _engine_cache.clear()  # 只留最新版本，避免記憶體無限成長
        _engine_cache[key] = RerankEngine(json.loads(merchant.menu_json))
    return _engine_cache[key]


class RegisterMerchantRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    payout_address: str = Field(default="", description="店家收款的 Sui 地址（可之後再設定）")


@router.post("/merchants")
def register_merchant(req: RegisterMerchantRequest, request: Request, db: Session = Depends(get_db)):
    """註冊店家。api_key 明文只在這個回應出現一次，之後只存 hash。"""
    check_rate_limit(f"reg:{request.client.host if request.client else 'unknown'}", 10)
    api_key, key_hash = generate_api_key()
    merchant = Merchant(name=req.name, api_key_hash=key_hash, payout_address=req.payout_address)
    db.add(merchant)
    db.commit()
    return {
        "merchant_id": merchant.id,
        "api_key": api_key,
        "notice": "請立即保存 api_key，之後無法再次取得（伺服器只儲存雜湊）。",
    }


def merchant_from_bearer_or_cookie(
    authorization: str = Header(default=""),
    chui_mch_session: str = Cookie(default=""),
    db: Session = Depends(get_db),
) -> Merchant:
    """console 用 cookie、機器用 Bearer，兩者皆可。"""
    if authorization.startswith("Bearer "):
        api_key = authorization.removeprefix("Bearer ").strip()
        merchant = db.scalar(select(Merchant).where(Merchant.api_key_hash == hash_api_key(api_key)))
        if merchant:
            return merchant
        raise AuthError("API key 無效")
    if chui_mch_session and config.SESSION_SECRET:
        payload = verify_session(config.SESSION_SECRET, chui_mch_session)
        if payload and payload.get("typ") == "merchant" and payload.get("exp", 0) > int(time.time()):
            merchant = db.get(Merchant, payload.get("sub", ""))
            if merchant:
                return merchant
    raise AuthError("需要 API key 或 console 登入")


class ConsoleLoginRequest(BaseModel):
    api_key: str


@router.post("/merchants/console-login")
def console_login(req: ConsoleLoginRequest, response: Response, db: Session = Depends(get_db)):
    """店家後台登入：驗證 API key 後改用 httpOnly cookie（絕不落地 localStorage）。"""
    if not config.SESSION_SECRET:
        raise AuthError("伺服器未設定 CHUI_SESSION_SECRET")
    merchant = db.scalar(select(Merchant).where(Merchant.api_key_hash == hash_api_key(req.api_key)))
    if merchant is None:
        raise AuthError("API key 無效")
    token = sign_session(config.SESSION_SECRET, {
        "typ": "merchant", "sub": merchant.id, "exp": int(time.time()) + 12 * 3600,
    })
    response.set_cookie("chui_mch_session", token, httponly=True, samesite="lax", max_age=12 * 3600)
    return {"merchant_id": merchant.id, "name": merchant.name}


@router.get("/merchants/me")
def get_me(merchant: Merchant = Depends(merchant_from_bearer_or_cookie)):
    return {
        "merchant_id": merchant.id,
        "name": merchant.name,
        "payout_address": merchant.payout_address,
        "menu_version": merchant.menu_version,
        "menu": json.loads(merchant.menu_json) if merchant.menu_json else None,
    }


class UpdateMerchantRequest(BaseModel):
    payout_address: str | None = None
    name: str | None = None


@router.put("/merchants/me")
def update_me(req: UpdateMerchantRequest, merchant: Merchant = Depends(merchant_from_bearer_or_cookie),
              db: Session = Depends(get_db)):
    if req.payout_address is not None:
        merchant.payout_address = req.payout_address
    if req.name:
        merchant.name = req.name
    db.add(merchant)
    db.commit()
    return {"ok": True}


@router.put("/merchants/me/menu")
def put_menu(menu: dict, merchant: Merchant = Depends(merchant_from_bearer_or_cookie),
             db: Session = Depends(get_db)):
    """上傳／更新菜單（品項、價格、選項、同義詞）。"""
    validate_menu(menu)
    merchant.menu_json = json.dumps(menu, ensure_ascii=False)
    merchant.menu_version = menu.get("menu_version") or str(int(time.time()))
    db.add(merchant)
    db.commit()
    return {"ok": True, "menu_version": merchant.menu_version, "items": len(menu["items"])}


@router.get("/merchants/me/settlements")
def list_settlements(merchant: Merchant = Depends(merchant_from_bearer_or_cookie),
                     db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Settlement).where(Settlement.merchant_id == merchant.id)
        .order_by(Settlement.created_at.desc()).limit(200)
    ).all()
    return {
        "settlements": [
            {
                "id": s.id, "order_id": s.order_id, "amount": s.amount,
                "tx_digest": s.tx_digest,
                "explorer_url": config.explorer_tx_url(s.tx_digest),
                "created_at": s.created_at,
            }
            for s in rows
        ]
    }


class RegisterWebhookRequest(BaseModel):
    url: str = Field(pattern=r"^https?://")


@router.post("/webhooks")
def register_webhook(req: RegisterWebhookRequest,
                     merchant: Merchant = Depends(merchant_from_bearer_or_cookie),
                     db: Session = Depends(get_db)):
    """註冊 webhook。secret 用來驗證 X-Chui-Signature，只在這裡回傳一次。"""
    secret = "whsec_" + secrets.token_urlsafe(32)
    ep = WebhookEndpoint(merchant_id=merchant.id, url=req.url, secret=secret)
    db.add(ep)
    db.commit()
    return {"webhook_id": ep.id, "url": ep.url, "secret": secret}


@router.get("/webhooks")
def list_webhooks(merchant: Merchant = Depends(merchant_from_bearer_or_cookie),
                  db: Session = Depends(get_db)):
    rows = db.scalars(select(WebhookEndpoint).where(WebhookEndpoint.merchant_id == merchant.id)).all()
    return {"webhooks": [{"webhook_id": w.id, "url": w.url} for w in rows]}
