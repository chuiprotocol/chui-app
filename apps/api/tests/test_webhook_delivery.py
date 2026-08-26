"""Webhook 送達：簽章正確、成功送達、失敗重試排程。"""

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from sqlalchemy import select

from chui_api.crypto import verify_webhook_signature
from chui_api.db import db_session
from chui_api.models import WebhookDelivery, WebhookEndpoint
from chui_api.webhooks import _deliver_one, enqueue_event


class _Receiver(BaseHTTPRequestHandler):
    received: list[dict] = []
    respond_with = 200

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        _Receiver.received.append({
            "body": body,
            "timestamp": self.headers.get("X-Chui-Timestamp", ""),
            "signature": self.headers.get("X-Chui-Signature", ""),
            "event": self.headers.get("X-Chui-Event", ""),
        })
        self.send_response(_Receiver.respond_with)
        self.end_headers()

    def log_message(self, *args):
        pass


def _start_server():
    server = HTTPServer(("127.0.0.1", 0), _Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_delivery_signed_and_received(merchant):
    merchant_id, _key, _headers = merchant
    server = _start_server()
    _Receiver.received.clear()
    _Receiver.respond_with = 200
    url = f"http://127.0.0.1:{server.server_port}/hook"

    db = db_session()
    endpoint = WebhookEndpoint(merchant_id=merchant_id, url=url, secret="whsec_test")
    db.add(endpoint)
    db.commit()

    enqueue_event(db, merchant_id, "order.settled", {"order_id": "ord_x", "amount": 25})
    delivery = db.scalar(
        select(WebhookDelivery).where(WebhookDelivery.endpoint_id == endpoint.id)
    )
    asyncio.run(_deliver_one(db, delivery))

    assert delivery.status == "delivered"
    assert len(_Receiver.received) == 1
    got = _Receiver.received[0]
    # 收端要能用 secret 驗證簽章（SDK onWebhook 的驗法一致）
    sig = got["signature"].removeprefix("v1=")
    assert verify_webhook_signature("whsec_test", got["timestamp"], got["body"], sig)
    payload = json.loads(got["body"])
    assert payload["type"] == "order.settled"
    assert payload["data"]["amount"] == 25
    db.close()
    server.shutdown()


def test_failed_delivery_schedules_retry(merchant):
    merchant_id, _key, _headers = merchant
    server = _start_server()
    _Receiver.respond_with = 500
    url = f"http://127.0.0.1:{server.server_port}/hook"

    db = db_session()
    endpoint = WebhookEndpoint(merchant_id=merchant_id, url=url, secret="whsec_retry")
    db.add(endpoint)
    db.commit()
    enqueue_event(db, merchant_id, "order.failed", {"order_id": "ord_y"})
    delivery = db.scalar(
        select(WebhookDelivery).where(WebhookDelivery.endpoint_id == endpoint.id)
    )

    before = int(time.time())
    asyncio.run(_deliver_one(db, delivery))
    assert delivery.status == "pending"          # 尚未放棄
    assert delivery.attempts == 1
    assert delivery.next_attempt_at >= before + 2  # 指數退避：第一次重試至少 2 秒後

    # 連續失敗到達上限 → failed
    for _ in range(10):
        if delivery.status != "pending":
            break
        delivery.next_attempt_at = 0
        db.commit()
        asyncio.run(_deliver_one(db, delivery))
    assert delivery.status == "failed"
    db.close()
    server.shutdown()
