"""重排序引擎：關鍵行為測試＋整份評估資料集的品質門檻。"""

import json
from pathlib import Path

import pytest

from chui_api.rerank import RerankEngine

ROOT = Path(__file__).resolve().parent.parent
MENU = json.loads((ROOT.parent.parent / "examples" / "happy-pig" / "menu.json").read_text())
DATASET = [
    json.loads(line)
    for line in (ROOT / "eval" / "dataset.jsonl").read_text().splitlines()
    if line.strip()
]


@pytest.fixture(scope="module")
def engine():
    return RerankEngine(MENU)


def test_abbreviation_recovers(engine):
    r = engine.parse(["中冰奶"])
    assert r.ok
    assert r.items[0].item_id == "milk-tea"
    assert r.items[0].options == {"size": "M", "temp": "ICE"}


def test_phonetic_error_recovers(engine):
    r = engine.parse(["給我但餅"])
    assert r.ok
    assert r.items[0].item_id == "egg-pancake"


def test_taiwanese_synonym(engine):
    r = engine.parse(["菜頭粿加蛋"])
    assert r.ok
    assert r.items[0].item_id == "radish-cake"
    assert r.items[0].options.get("egg") == "YES"


def test_garbage_asks_clarification_never_guesses(engine):
    r = engine.parse(["幫我叫一台計程車"])
    assert not r.ok
    assert r.clarification_question  # 必須提出澄清問題，絕不無聲猜錯


def test_multiple_stt_candidates_picks_best(engine):
    # 第二個候選比較乾淨，應被採用
    r = engine.parse(["中並奈", "中冰奶"])
    assert r.ok
    assert r.items[0].item_id == "milk-tea"


def test_dataset_quality_gate(engine):
    """整份資料集的品質門檻：這是 README 數字的守門員。"""
    order_rows = [r for r in DATASET if "items" in r["gold"]]
    clarify_rows = [r for r in DATASET if r["gold"].get("clarify")]
    assert len(order_rows) + len(clarify_rows) >= 50, "資料集必須至少 50 筆"

    correct = 0
    for row in order_rows:
        result = engine.parse([row["stt"]])
        got = sorted(
            (i.item_id, i.qty, tuple(sorted(i.options.items()))) for i in result.items
        )
        want = sorted(
            (i["item"], i["qty"], tuple(sorted(i["options"].items())))
            for i in row["gold"]["items"]
        )
        if result.ok and got == want:
            correct += 1
    assert correct / len(order_rows) >= 0.90, f"重排序訂單正確率 {correct}/{len(order_rows)} 低於 90%"

    silent_wrong = 0
    for row in clarify_rows:
        result = engine.parse([row["stt"]])
        if result.ok or not result.clarification_question:
            silent_wrong += 1
    assert silent_wrong == 0, "應澄清樣本絕不允許無聲接受"
