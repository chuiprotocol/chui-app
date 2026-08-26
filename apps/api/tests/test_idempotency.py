"""冪等性：同一筆訂單 confirm N 次只扣款一次。

鏈上呼叫以「計數樁」取代（單元測試只驗證應用層的冪等防線；
真正的鏈上行為由 TESTING.md 的 Testnet 腳本驗證）。
"""

import threading
import time
import uuid

import pytest

from chui_api import chain
from chui_api.db import db_session
from chui_api.models import Consumer, Mandate


class SettleCounter:
    """記錄 chain.settle 被真正呼叫幾次的樁。"""

    def __init__(self, fail_with: str = ""):
        self.calls = 0
        self.lock = threading.Lock()
        self.fail_with = fail_with

    async def __call__(self, mandate_onchain_id, merchant_address, amount, digest_hex):
        with self.lock:
            self.calls += 1
        if self.fail_with:
            from chui_api.errors import ChainError

            raise ChainError("鏈上結算被合約拒絕", move_abort=self.fail_with)
        return {"txDigest": f"FAKE_TX_{digest_hex[:8]}", "deduped": False}


@pytest.fixture()
def consumer_with_mandate():
    """直接在資料庫種一個有 active mandate 的消費者。"""
    db = db_session()
    consumer = Consumer(sui_address="0x" + uuid.uuid4().hex)
    db.add(consumer)
    db.commit()
    mandate = Mandate(
        consumer_id=consumer.id, per_tx_limit=100, total_limit=0,
        status="active", onchain_id="0x" + "cd" * 32,
    )
    db.add(mandate)
    db.commit()
    db.close()
    return consumer


def _parse(client, headers, consumer, text="中冰奶"):
    r = client.post(
        "/v1/orders/parse",
        data={"text": text, "consumer_address": consumer.sui_address},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _confirm(client, headers, order_id):
    return client.post(
        "/v1/orders/confirm",
        json={"order_id": order_id},
        headers={
            **headers,
            "X-Chui-Nonce": uuid.uuid4().hex,
            "X-Chui-Timestamp": str(int(time.time())),
        },
    )


def test_confirm_three_times_settles_once(client, merchant, consumer_with_mandate, monkeypatch):
    _mid, _key, headers = merchant
    counter = SettleCounter()
    monkeypatch.setattr(chain, "settle", counter)

    order = _parse(client, headers, consumer_with_mandate)
    receipts = [_confirm(client, headers, order["order_id"]) for _ in range(3)]

    assert all(r.status_code == 200 for r in receipts), [r.text for r in receipts]
    digests = {r.json()["tx_digest"] for r in receipts}
    assert len(digests) == 1, "三次 confirm 必須回同一張收據"
    assert counter.calls == 1, f"鏈上結算必須只執行一次，實際 {counter.calls} 次"


def test_concurrent_confirms_settle_once(client, merchant, consumer_with_mandate, monkeypatch):
    _mid, _key, headers = merchant
    counter = SettleCounter()
    monkeypatch.setattr(chain, "settle", counter)

    order = _parse(client, headers, consumer_with_mandate)
    results = []

    def worker():
        results.append(_confirm(client, headers, order["order_id"]))

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 每個請求最終都要拿到結果：200（同一張收據）或 409（結算進行中，可重試）
    assert all(r.status_code in (200, 409) for r in results), [r.text for r in results]
    assert counter.calls == 1, f"並發 confirm 也只能結算一次，實際 {counter.calls} 次"
    ok = [r for r in results if r.status_code == 200]
    assert len({r.json()["tx_digest"] for r in ok}) == 1


def test_move_abort_surfaces_named_error(client, merchant, consumer_with_mandate, monkeypatch):
    _mid, _key, headers = merchant
    monkeypatch.setattr(chain, "settle", SettleCounter(fail_with="E_OVER_PER_TX"))

    order = _parse(client, headers, consumer_with_mandate, text="兩杯大冰奶")
    r = _confirm(client, headers, order["order_id"])
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["code"] == "CHAIN_SETTLEMENT_FAILED"
    assert detail["move_abort"] == "E_OVER_PER_TX"

    # 訂單標記 failed 並保留 fail_code
    r2 = client.get(f"/v1/orders/{order['order_id']}", headers=headers)
    assert r2.json()["status"] == "failed"
    assert r2.json()["fail_code"] == "E_OVER_PER_TX"


def test_nonce_replay_rejected(client, merchant, consumer_with_mandate, monkeypatch):
    _mid, _key, headers = merchant
    monkeypatch.setattr(chain, "settle", SettleCounter())

    order = _parse(client, headers, consumer_with_mandate)
    nonce = uuid.uuid4().hex
    ts = str(int(time.time()))
    fixed = {**headers, "X-Chui-Nonce": nonce, "X-Chui-Timestamp": ts}
    r1 = client.post("/v1/orders/confirm", json={"order_id": order["order_id"]}, headers=fixed)
    assert r1.status_code == 200
    r2 = client.post("/v1/orders/confirm", json={"order_id": order["order_id"]}, headers=fixed)
    assert r2.status_code == 401
    assert r2.json()["detail"]["code"] == "REPLAY_REJECTED"


def test_stale_timestamp_rejected(client, merchant, consumer_with_mandate):
    _mid, _key, headers = merchant
    order = _parse(client, headers, consumer_with_mandate)
    r = client.post(
        "/v1/orders/confirm",
        json={"order_id": order["order_id"]},
        headers={**headers, "X-Chui-Nonce": uuid.uuid4().hex,
                 "X-Chui-Timestamp": str(int(time.time()) - 3600)},
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "REPLAY_REJECTED"
