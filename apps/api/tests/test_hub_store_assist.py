"""Hub 訂單儲存層與 EastRouter 備援的單元測試。

誠實聲明：MongoDB Atlas 實連與 EastRouter 實呼叫需要外部服務金鑰，
沙箱無法出網——這裡驗證的是「未設定時的退回行為」與純函式邏輯；
Atlas／EastRouter 的線上路徑由部署後的 healthz（order_store／
llm_assist 欄位）與真機流程驗證。
"""

import asyncio
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "hub"))


def test_order_store_memory_roundtrip(monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    from chui_hub.store import OrderStore

    store = OrderStore()
    assert store.backend == "memory"
    assert store.get("ord_x") is None
    order = {"order_id": "ord_x", "status": "quoted", "total": 32}
    store.save(order)
    got = store.get("ord_x")
    assert got == order
    # 記憶體模式回傳同一物件：就地修改後再 save 仍一致（沿用既有寫法）
    got["status"] = "confirmed"
    store.save(got)
    assert store.get("ord_x")["status"] == "confirmed"


def test_order_store_bad_uri_fails_fast(monkeypatch):
    """設定了壞的 MONGODB_URI 必須「啟動就炸」，不可無聲退回記憶體。"""
    monkeypatch.setenv("MONGODB_URI", "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200")
    from chui_hub.store import OrderStore

    with pytest.raises(Exception):
        OrderStore()


def test_assist_disabled_without_full_config(monkeypatch):
    for key in ("EASTROUTER_BASE_URL", "EASTROUTER_API_KEY", "EASTROUTER_MODEL"):
        monkeypatch.delenv(key, raising=False)
    import chui_hub.assist as assist
    importlib.reload(assist)
    assert assist.enabled() is False
    # 未啟用時 rephrase 必須立即回 None（不打任何網路）
    out = asyncio.run(assist.rephrase_order("一杯珍奶", ["珍珠奶茶"]))
    assert out is None


def test_assist_prompt_contains_vocab_and_text():
    import chui_hub.assist as assist

    prompt = assist.build_prompt("點一杯真奶半糖", ["珍珠奶茶", "半糖", "去冰"])
    assert "珍珠奶茶" in prompt and "點一杯真奶半糖" in prompt
    assert "無法對應" in prompt  # 模型的「拒答」出口必須寫在提示裡


def test_order_store_mongo_path_with_mongomock(monkeypatch):
    """用 mongomock 驗證 Atlas 程式路徑（upsert／讀回／_id 剝除／更新覆寫）。

    誠實聲明：這驗的是我們的程式邏輯，不是真 Atlas 網路連線——
    真連線由部署後 healthz 的 order_store=mongodb-atlas 驗證。
    """
    mongomock = pytest.importorskip("mongomock")
    import pymongo

    monkeypatch.setattr(pymongo, "MongoClient", mongomock.MongoClient)
    monkeypatch.setenv("MONGODB_URI", "mongodb://mongomock/")
    monkeypatch.setenv("MONGODB_DB", "chui_test")
    from chui_hub.store import OrderStore

    store = OrderStore()
    assert store.backend == "mongodb-atlas"
    order = {"order_id": "ord_m1", "status": "quoted", "total": 65, "tx_digest": ""}
    store.save(order)
    got = store.get("ord_m1")
    assert got == order and "_id" not in got
    # Mongo 模式 get 回傳的是「複本」：改完必須 save 才會落庫
    got["status"] = "settled_verified"
    got["tx_digest"] = "0xabc"
    store.save(got)
    again = store.get("ord_m1")
    assert again["status"] == "settled_verified" and again["tx_digest"] == "0xabc"
    assert store.get("ord_none") is None


# ---- Atlas Oracle 匯率換算 ----

def test_oracle_units_conversion():
    import chui_hub.oracle as oracle

    # TWD_USD：1 台幣 ≈ 0.0325 USD → 32500 units/元
    assert oracle.units_per_twd_from_price(0.0325, "TWD_USD", 1.0) == 32500
    # USD_TWD：1 美元 ≈ 30.77 台幣 → 1e6/30.77 ≈ 32499
    assert oracle.units_per_twd_from_price(30.77, "USD_TWD", 1.0) == 32499
    # 內部測試縮放（真實匯率的 5%）
    assert oracle.units_per_twd_from_price(0.0325, "TWD_USD", 0.05) == 1625
    with pytest.raises(ValueError):
        oracle.units_per_twd_from_price(0, "TWD_USD", 1.0)
    with pytest.raises(ValueError):
        oracle.units_per_twd_from_price(1.0, "WAT", 1.0)


def test_oracle_parse_latest_response():
    import chui_hub.oracle as oracle

    body = {"data": {"parsedPayload":
            '[{"feedId":"624","price":999832025250886479,"timestampSeconds":"1780993491"}]'}}
    price = oracle.parse_latest_response(body, "624")
    assert abs(price - 0.999832) < 1e-4
    with pytest.raises(ValueError):
        oracle.parse_latest_response(body, "999")


def test_oracle_disabled_returns_none(monkeypatch):
    for key in ("ATLAS_ORACLE_API_KEY", "ATLAS_FEED_ID"):
        monkeypatch.delenv(key, raising=False)
    import chui_hub.oracle as oracle
    importlib.reload(oracle)
    assert oracle.enabled() is False
    assert asyncio.run(oracle.units_per_twd()) is None  # 不打任何網路


def test_oracle_usdc_usd_mode():
    """Atlas 目前只有 USDC/USD feed：加密腿即時、台幣腿設定值。"""
    import chui_hub.oracle as oracle

    # 1 USDC = 0.9998 USD、1 USD = 31.5 TWD → 1 TWD ≈ 0.031753 USDC
    units = oracle.units_per_twd_from_price(0.9998, "USDC_USD", 1.0, 31.5)
    assert units == 31752
    # 內部測試縮放 5%
    assert oracle.units_per_twd_from_price(0.9998, "USDC_USD", 0.05, 31.5) == 1588
    with pytest.raises(ValueError):
        oracle.units_per_twd_from_price(0.9998, "USDC_USD", 1.0, 0)
