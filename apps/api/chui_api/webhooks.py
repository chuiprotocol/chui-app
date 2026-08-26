"""Webhook 送達：簽章、送出、指數退避重試。

送達紀錄落地在 webhook_deliveries，背景工作每秒掃一次到期的 pending
紀錄。伺服器重啟不會弄丟未送達的事件。
"""

import asyncio
import json
import time

import httpx
from sqlalchemy import select

from . import config
from .crypto import sign_webhook_payload
from .db import db_session
from .models import WebhookDelivery, WebhookEndpoint


def enqueue_event(db, merchant_id: str, event_type: str, data: dict) -> None:
    """把事件排入該店家所有 webhook endpoint 的送達佇列。"""
    endpoints = db.scalars(
        select(WebhookEndpoint).where(WebhookEndpoint.merchant_id == merchant_id)
    ).all()
    payload = json.dumps(
        {"type": event_type, "created_at": int(time.time()), "data": data},
        ensure_ascii=False, sort_keys=True,
    )
    for ep in endpoints:
        db.add(WebhookDelivery(endpoint_id=ep.id, event_type=event_type, payload_json=payload))
    db.commit()


async def _deliver_one(db, delivery: WebhookDelivery) -> None:
    endpoint = db.get(WebhookEndpoint, delivery.endpoint_id)
    if endpoint is None:
        delivery.status = "failed"
        delivery.last_error = "endpoint 已刪除"
        db.commit()
        return
    body = delivery.payload_json.encode()
    timestamp = str(int(time.time()))
    signature = sign_webhook_payload(endpoint.secret, timestamp, body)
    try:
        async with httpx.AsyncClient(timeout=config.WEBHOOK_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                endpoint.url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Chui-Timestamp": timestamp,
                    "X-Chui-Signature": f"v1={signature}",
                    "X-Chui-Event": delivery.event_type,
                },
            )
        if 200 <= resp.status_code < 300:
            delivery.status = "delivered"
            db.commit()
            return
        error = f"HTTP {resp.status_code}"
    except Exception as exc:
        error = str(exc)

    delivery.attempts += 1
    delivery.last_error = error
    if delivery.attempts >= config.WEBHOOK_MAX_RETRIES:
        delivery.status = "failed"
    else:
        # 指數退避：2, 4, 8, 16... 秒
        delivery.next_attempt_at = int(time.time()) + 2 ** delivery.attempts
    db.commit()


async def delivery_worker(stop_event: asyncio.Event) -> None:
    """背景送達迴圈。"""
    while not stop_event.is_set():
        db = db_session()
        try:
            due = db.scalars(
                select(WebhookDelivery)
                .where(WebhookDelivery.status == "pending")
                .where(WebhookDelivery.next_attempt_at <= int(time.time()))
                .limit(20)
            ).all()
            for d in due:
                await _deliver_one(db, d)
        finally:
            db.close()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass
