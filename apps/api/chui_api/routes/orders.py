"""訂單：解析（語音／文字 → OrderIntent + Quote）、冪等結算、查詢。"""

import base64
import json
import time

from fastapi import APIRouter, Depends, File, Form, Header, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import chain, config, stt, tts
from ..auth import require_merchant, verify_nonce_and_timestamp
from ..crypto import encrypt_order_details, new_salt, order_digest
from ..db import get_db
from ..errors import (
    ChainError,
    ChuiError,
    ClarificationNeededError,
    NotFoundError,
    SettlementInProgressError,
    ValidationFailedError,
)
from ..menu import quote_items, readback_fragments
from ..models import Consumer, Mandate, Merchant, Order, Settlement
from ..webhooks import enqueue_event
from .merchants import get_engine

router = APIRouter(prefix="/v1/orders", tags=["orders"])


class MandateRequiredError(ChuiError):
    code = "MANDATE_REQUIRED"
    status_code_default = 402


@router.post("/parse")
async def parse_order(
    merchant: Merchant = Depends(require_merchant),
    db: Session = Depends(get_db),
    text: str | None = Form(default=None),
    consumer_address: str | None = Form(default=None),
    audio: UploadFile | None = File(default=None),
):
    """語音或文字 → OrderIntent + Quote。

    信心度不足時回 422 CLARIFICATION_NEEDED（帶澄清問題），不建立訂單，
    絕不猜。成功時建立 quoted 訂單：明細以消費者金鑰加密落地，
    金鑰只在本回應出現一次，伺服器不留存。
    """
    engine = get_engine(merchant)

    if audio is not None:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise ValidationFailedError("音檔是空的")
        candidates = await stt.transcribe(audio_bytes, audio.filename or "audio.m4a")
    elif text:
        candidates = [text]
    else:
        raise ValidationFailedError("需要 text 或 audio 其中之一")

    result = engine.parse(candidates)
    if not result.ok:
        # 澄清不是失敗，是語音介面的正常回合；用 422 + 結構化內容表達
        raise ClarificationNeededError(
            result.clarification_question or "請再說一次",
            question=result.clarification_question,
            candidates=result.clarification_candidates or [],
            confidence=round(result.confidence, 3),
            stt_text=result.source_text,
        )
    menu = json.loads(merchant.menu_json)
    lines, total = quote_items(menu, result.items)
    fragments = readback_fragments(lines, total)
    readback_text = "，".join(fragments)

    # 加密明細落地；金鑰回傳給消費者後即丟棄
    details = {
        "merchant_id": merchant.id,
        "menu_version": merchant.menu_version,
        "lines": lines,
        "total": total,
        "created_at": int(time.time()),
    }
    salt = new_salt()
    digest_hex = order_digest(details, salt)
    ciphertext_b64, nonce_b64, key_b64 = encrypt_order_details(details)

    consumer_id = ""
    if consumer_address:
        consumer = db.scalar(select(Consumer).where(Consumer.sui_address == consumer_address))
        if consumer:
            consumer_id = consumer.id

    order = Order(
        merchant_id=merchant.id,
        consumer_id=consumer_id,
        details_ciphertext=ciphertext_b64,
        details_nonce=nonce_b64,
        salt_hex=salt.hex(),
        digest_hex=digest_hex,
        total_amount=total,
        readback_text=readback_text,
    )
    db.add(order)
    db.commit()

    return {
        "order_id": order.id,
        "intent": {
            "items": [
                {"item_id": i.item_id, "name": i.name, "qty": i.qty, "options": i.options}
                for i in result.items
            ],
            "confidence": round(result.confidence, 3),
            "stt_text": result.source_text,
        },
        "quote": {"lines": lines, "total": total, "currency": "TWD"},
        "readback": {"text": readback_text, "fragments": fragments},
        "order_key": key_b64,
        "digest": digest_hex,
        "key_notice": "order_key 請交給消費者保存；伺服器不留存，遺失即無法解密明細。",
    }


@router.get("/{order_id}/readback.mp3")
async def readback_audio(order_id: str, merchant: Merchant = Depends(require_merchant),
                         db: Session = Depends(get_db)):
    """覆誦音檔：快取 → ElevenLabs（3 秒逾時）→ edge-tts → 快取片段拼接。"""
    order = db.get(Order, order_id)
    if order is None or order.merchant_id != merchant.id:
        raise NotFoundError("訂單不存在")
    fragments = order.readback_text.split("，")
    audio, source = await tts.synthesize_readback(fragments)
    return Response(content=audio, media_type="audio/mpeg", headers={"X-Chui-Tts-Source": source})


class ConfirmRequest(BaseModel):
    order_id: str
    mandate_id: str | None = None  # 未指定時用消費者目前有效的 mandate


def _receipt(order: Order, settlement: Settlement) -> dict:
    return {
        "order_id": order.id,
        "status": "settled",
        "amount": settlement.amount,
        "currency": "TWD",
        "tx_digest": settlement.tx_digest,
        "explorer_url": config.explorer_tx_url(settlement.tx_digest),
        "digest": order.digest_hex,
        "settled_at": order.settled_at,
        "network": config.SUI_NETWORK,
    }


@router.post("/confirm")
async def confirm_order(
    req: ConfirmRequest,
    merchant: Merchant = Depends(require_merchant),
    db: Session = Depends(get_db),
    x_chui_nonce: str = Header(default=""),
    x_chui_timestamp: str = Header(default=""),
):
    """鏈上結算。冪等：同一個 order_id 重複 confirm N 次只扣款一次。

    冪等防線（由外而內）：
    1. 已結算 → 直接回同一張收據。
    2. 結算中 → 409 SETTLEMENT_IN_PROGRESS（SDK 會退避重試拿到收據）。
    3. 資料庫的原子狀態轉移（quoted/failed → settling）確保單一執行者。
    4. settlements.order_id UNIQUE 約束是最後一道防線。
    5. chain-service 以訂單 digest 為鍵去重，API 崩潰後重試也不會重複上鏈。
    """
    verify_nonce_and_timestamp(db, x_chui_nonce, x_chui_timestamp)

    order = db.get(Order, req.order_id)
    if order is None or order.merchant_id != merchant.id:
        raise NotFoundError("訂單不存在")

    # 冪等捷徑：已有結算紀錄就回同一張收據
    existing = db.scalar(select(Settlement).where(Settlement.order_id == order.id))
    if existing is not None:
        return _receipt(order, existing)
    if order.status == "settling":
        raise SettlementInProgressError("這筆訂單的結算正在進行中，請稍後用同一個 confirm 重試")

    # 原子認領：只有一個請求能把訂單轉入 settling
    claimed = db.execute(
        update(Order)
        .where(Order.id == order.id, Order.status.in_(["quoted", "failed"]))
        .values(status="settling", fail_code="")
    )
    db.commit()
    if claimed.rowcount != 1:
        raise SettlementInProgressError("這筆訂單的結算正在進行中，請稍後用同一個 confirm 重試")

    def _release(status: str, fail_code: str = "") -> None:
        db.execute(update(Order).where(Order.id == order.id).values(status=status, fail_code=fail_code))
        db.commit()

    # 找出消費者的有效授權
    if not order.consumer_id:
        _release("quoted")
        raise MandateRequiredError("訂單未綁定消費者，無法找到授權（parse 時請帶 consumer_address）")
    query = select(Mandate).where(Mandate.consumer_id == order.consumer_id, Mandate.status == "active")
    if req.mandate_id:
        query = query.where(Mandate.id == req.mandate_id)
    mandate = db.scalar(query.order_by(Mandate.created_at.desc()))
    if mandate is None or not mandate.onchain_id:
        _release("quoted")
        raise MandateRequiredError("消費者沒有有效的鏈上授權（Mandate），請先到後台建立授權")
    if not merchant.payout_address:
        _release("quoted")
        raise ValidationFailedError("店家尚未設定收款地址（payout_address）")

    try:
        chain_result = await chain.settle(
            mandate.onchain_id, merchant.payout_address, order.total_amount, order.digest_hex,
        )
    except ChainError as exc:
        move_abort = (exc.detail or {}).get("move_abort", "") if isinstance(exc.detail, dict) else ""
        # 鏈上明確拒絕（超限、已撤銷）→ failed；網路類錯誤 → 放回 quoted 可重試
        if move_abort:
            _release("failed", move_abort)
            enqueue_event(db, merchant.id, "order.failed", {
                "order_id": order.id, "fail_code": move_abort, "amount": order.total_amount,
            })
        else:
            _release("quoted")
        raise
    except Exception:
        _release("quoted")
        raise

    settlement = Settlement(
        order_id=order.id, merchant_id=merchant.id,
        amount=order.total_amount, tx_digest=chain_result["txDigest"],
    )
    db.add(settlement)
    db.execute(
        update(Order).where(Order.id == order.id)
        .values(status="settled", settle_tx_digest=chain_result["txDigest"], settled_at=int(time.time()))
    )
    db.commit()
    db.refresh(order)
    enqueue_event(db, merchant.id, "order.settled", {
        "order_id": order.id,
        "amount": order.total_amount,
        "tx_digest": settlement.tx_digest,
        "explorer_url": config.explorer_tx_url(settlement.tx_digest),
        "digest": order.digest_hex,
    })
    return _receipt(order, settlement)


@router.get("/{order_id}")
def get_order(order_id: str, merchant: Merchant = Depends(require_merchant),
              db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if order is None or order.merchant_id != merchant.id:
        raise NotFoundError("訂單不存在")
    body = {
        "order_id": order.id,
        "status": order.status,
        "total": order.total_amount,
        "currency": "TWD",
        "digest": order.digest_hex,
        "salt": order.salt_hex,
        "details_ciphertext": order.details_ciphertext,
        "details_nonce": order.details_nonce,
        "readback_text": order.readback_text,
        "fail_code": order.fail_code,
        "created_at": order.created_at,
    }
    if order.settle_tx_digest:
        body["tx_digest"] = order.settle_tx_digest
        body["explorer_url"] = config.explorer_tx_url(order.settle_tx_digest)
    return body
