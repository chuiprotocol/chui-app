"""測試共用設施：獨立資料庫、TestClient、已註冊店家。"""

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 測試環境變數要在 import chui_api 前設定
_tmpdir = tempfile.mkdtemp(prefix="chui-test-")
os.environ["CHUI_DATABASE_URL"] = f"sqlite:///{_tmpdir}/test.db"
os.environ["CHUI_SESSION_SECRET"] = "test-session-secret"
os.environ["TTS_CACHE_DIR"] = f"{_tmpdir}/tts_cache"
os.environ.setdefault("SUI_NETWORK", "testnet")

from fastapi.testclient import TestClient  # noqa: E402

from chui_api.main import app  # noqa: E402

MENU_PATH = ROOT.parent.parent / "examples" / "happy-pig" / "menu.json"


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def merchant(client):
    """已註冊、已上菜單、已設定收款地址的店家。回傳 (merchant_id, api_key, headers)。"""
    r = client.post("/v1/merchants", json={"name": "測試快樂豬"})
    assert r.status_code == 200, r.text
    body = r.json()
    headers = {"Authorization": f"Bearer {body['api_key']}"}
    menu = json.loads(MENU_PATH.read_text())
    assert client.put("/v1/merchants/me/menu", json=menu, headers=headers).status_code == 200
    assert client.put("/v1/merchants/me", json={"payout_address": "0x" + "ab" * 32},
                      headers=headers).status_code == 200
    return body["merchant_id"], body["api_key"], headers
