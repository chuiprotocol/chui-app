"""Chui Hub registry：菜單取得失敗必須是具名錯誤，且有舊快取時降級沿用。"""

import asyncio
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

# hub 模組（monorepo 內部相依）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "hub"))

from chui_hub.registry import MenuUnavailableError, MerchantEntry  # noqa: E402

VALID_MENU = {
    "menu_version": "t1",
    "currency": "TWD",
    "items": [{"id": "tea", "name": "紅茶", "base_price": 20, "synonyms": [], "options": []}],
}


class _MenuServer(BaseHTTPRequestHandler):
    payload: bytes = json.dumps(VALID_MENU).encode()
    status = 200

    def do_GET(self):
        self.send_response(_MenuServer.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(_MenuServer.payload)

    def log_message(self, *args):
        pass


def _entry(port: int) -> MerchantEntry:
    return MerchantEntry({
        "merchant_id": "t", "name": "測試店", "integration": "native",
        "chui_endpoint": f"http://127.0.0.1:{port}", "payout_address": "0x1",
    })


def test_unreachable_merchant_raises_named_error():
    entry = _entry(1)  # 沒人聽的 port
    with pytest.raises(MenuUnavailableError) as excinfo:
        asyncio.run(entry.menu())
    assert excinfo.value.detail["code"] == "MENU_UNAVAILABLE"


def test_bad_menu_raises_named_error():
    server = HTTPServer(("127.0.0.1", 0), _MenuServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _MenuServer.payload = json.dumps({"items": []}).encode()  # 空菜單：驗證必失敗
    try:
        with pytest.raises(MenuUnavailableError):
            asyncio.run(_entry(server.server_port).menu())
    finally:
        _MenuServer.payload = json.dumps(VALID_MENU).encode()
        server.shutdown()


def test_stale_cache_survives_merchant_outage(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), _MenuServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    entry = _entry(server.server_port)
    try:
        menu = asyncio.run(entry.menu())
        assert menu["menu_version"] == "t1"
        # 商家掛掉＋快取過期 → 應降級沿用舊菜單而不是整條路徑爆炸
        _MenuServer.status = 500
        entry._menu_fetched_at = time.monotonic() - 9999
        menu2 = asyncio.run(entry.menu())
        assert menu2["menu_version"] == "t1"
    finally:
        _MenuServer.status = 200
        server.shutdown()
