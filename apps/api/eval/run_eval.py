"""重排序評估 harness。

比較兩條路徑在同一份標註資料集上的表現：
1. 原始 STT 基線：直接信任 STT 文字，只做菜單「正式名稱」的精確子字串比對
   （這就是不做重排序時你能得到的東西）。
2. 封閉詞彙重排序：本專案的 RerankEngine。

指標：
- 品項辨識準確率：品項 id 集合完全正確的比例。
- 訂單完全正確率：品項、數量、選項全部與標註一致的比例。
- 澄清正確率：標註為「必須澄清」的樣本，引擎確實提出澄清問題
  （而不是無聲猜錯）的比例。

用法：python eval/run_eval.py [--markdown]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chui_api.rerank import RerankEngine  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MENU_PATH = ROOT.parent.parent / "examples" / "happy-pig" / "menu.json"
DATASET_PATH = Path(__file__).resolve().parent / "dataset.jsonl"


def naive_baseline(menu: dict, text: str) -> list[dict]:
    """基線解析器：菜單正式名稱的精確子字串比對，不做任何語音重排序。

    模擬「直接信任 STT」會發生的事：誤辨字、縮寫、台語全部對不到。
    """
    found: list[dict] = []
    for it in menu["items"]:
        if it["name"] in text:
            options: dict[str, str] = {}
            for opt in it.get("options", []):
                for ch in opt["choices"]:
                    if ch["name"] in text:
                        options[opt["id"]] = ch["id"]
                        break
                if opt.get("required") and opt["id"] not in options:
                    options[opt["id"]] = opt.get("default", opt["choices"][0]["id"])
            found.append({"item": it["id"], "qty": 1, "options": options})
    return found


def gold_key(items: list[dict]) -> list[tuple]:
    return sorted((i["item"], i["qty"], tuple(sorted(i["options"].items()))) for i in items)


def item_set(items: list[dict]) -> set[str]:
    return {i["item"] for i in items}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markdown", action="store_true", help="輸出 README 用的 markdown 表格")
    args = parser.parse_args()

    menu = json.loads(MENU_PATH.read_text())
    engine = RerankEngine(menu)
    rows = [json.loads(line) for line in DATASET_PATH.read_text().splitlines() if line.strip()]

    order_rows = [r for r in rows if "items" in r["gold"]]
    clarify_rows = [r for r in rows if r["gold"].get("clarify")]

    stats = {
        "baseline_item": 0, "baseline_order": 0,
        "rerank_item": 0, "rerank_order": 0,
        "clarify_ok": 0, "silent_wrong": 0,
    }
    failures: list[str] = []

    for r in order_rows:
        gold = r["gold"]["items"]
        base = naive_baseline(menu, r["stt"])
        if item_set(base) == item_set(gold):
            stats["baseline_item"] += 1
        if gold_key(base) == gold_key(gold):
            stats["baseline_order"] += 1

        result = engine.parse([r["stt"]])
        got = [{"item": i.item_id, "qty": i.qty, "options": i.options} for i in result.items]
        if result.ok and item_set(got) == item_set(gold):
            stats["rerank_item"] += 1
        if result.ok and gold_key(got) == gold_key(gold):
            stats["rerank_order"] += 1
        elif result.ok:
            failures.append(f"  #{r['id']} {r['stt']!r} → {got}（應為 {gold}）")
        else:
            failures.append(f"  #{r['id']} {r['stt']!r} → 澄清（應可直接解析）")

    for r in clarify_rows:
        result = engine.parse([r["stt"]])
        if not result.ok and result.clarification_question:
            stats["clarify_ok"] += 1
        else:
            stats["silent_wrong"] += 1
            failures.append(f"  #{r['id']} {r['stt']!r} → 無聲接受了（應澄清）")

    n = len(order_rows)
    nc = len(clarify_rows)

    def pct(x: int, total: int) -> str:
        return f"{100 * x / total:.1f}%" if total else "n/a"

    if args.markdown:
        print("| 指標 | 原始 STT（精確比對基線） | 封閉詞彙重排序後 |")
        print("|---|---|---|")
        print(f"| 品項辨識準確率（{n} 筆） | {pct(stats['baseline_item'], n)} | {pct(stats['rerank_item'], n)} |")
        print(f"| 訂單完全正確率（{n} 筆） | {pct(stats['baseline_order'], n)} | {pct(stats['rerank_order'], n)} |")
        print(f"| 應澄清即澄清（{nc} 筆） | — | {pct(stats['clarify_ok'], nc)} |")
    else:
        print(f"訂單樣本 {n} 筆、應澄清樣本 {nc} 筆")
        print(f"基線     品項 {pct(stats['baseline_item'], n)}  訂單 {pct(stats['baseline_order'], n)}")
        print(f"重排序   品項 {pct(stats['rerank_item'], n)}  訂單 {pct(stats['rerank_order'], n)}")
        print(f"澄清     {pct(stats['clarify_ok'], nc)}（無聲猜錯 {stats['silent_wrong']} 筆）")
        if failures:
            print("\n未通過樣本：")
            print("\n".join(failures))

    # 無聲猜錯是支付情境的紅線：任何一筆都讓 harness 以非零碼結束
    if stats["silent_wrong"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
