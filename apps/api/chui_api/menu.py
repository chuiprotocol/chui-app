"""菜單驗證與報價計算。金額一律整數（元）。"""

from .errors import ValidationFailedError
from .rerank.engine import ParsedItem


def validate_menu(menu: dict) -> dict:
    """驗證店家上傳的菜單結構；金額必須是非負整數。"""
    if not isinstance(menu, dict) or not isinstance(menu.get("items"), list) or not menu["items"]:
        raise ValidationFailedError("菜單必須包含非空的 items 陣列")
    seen_ids: set[str] = set()
    for it in menu["items"]:
        for field in ("id", "name", "base_price"):
            if field not in it:
                raise ValidationFailedError(f"品項缺少必要欄位 {field}：{it}")
        if not isinstance(it["base_price"], int) or isinstance(it["base_price"], bool) or it["base_price"] < 0:
            raise ValidationFailedError(f"品項 {it['id']} 的 base_price 必須是非負整數（元），不可用浮點數")
        if it["id"] in seen_ids:
            raise ValidationFailedError(f"品項 id 重複：{it['id']}")
        seen_ids.add(it["id"])
        for opt in it.get("options", []):
            for field in ("id", "name", "choices"):
                if field not in opt:
                    raise ValidationFailedError(f"品項 {it['id']} 的選項缺少欄位 {field}")
            if opt.get("required") and not opt.get("default"):
                raise ValidationFailedError(f"品項 {it['id']} 的必填選項 {opt['id']} 必須提供 default")
            choice_ids = set()
            for ch in opt["choices"]:
                if "id" not in ch or "name" not in ch:
                    raise ValidationFailedError(f"品項 {it['id']} 選項 {opt['id']} 的 choice 缺少 id/name")
                delta = ch.get("price_delta", 0)
                if not isinstance(delta, int) or isinstance(delta, bool):
                    raise ValidationFailedError(
                        f"品項 {it['id']} 選項 {opt['id']} 的 price_delta 必須是整數（元）"
                    )
                choice_ids.add(ch["id"])
            if opt.get("default") and opt["default"] not in choice_ids:
                raise ValidationFailedError(f"品項 {it['id']} 選項 {opt['id']} 的 default 不在 choices 中")
    return menu


def quote_items(menu: dict, items: list[ParsedItem]) -> tuple[list[dict], int]:
    """計算報價。回傳（明細行, 總金額）。全部整數運算。"""
    items_by_id = {it["id"]: it for it in menu["items"]}
    lines: list[dict] = []
    total = 0
    for parsed in items:
        menu_item = items_by_id[parsed.item_id]
        unit = menu_item["base_price"]
        option_names: list[str] = []
        for opt in menu_item.get("options", []):
            cid = parsed.options.get(opt["id"])
            if not cid:
                continue
            choice = next((c for c in opt["choices"] if c["id"] == cid), None)
            if choice is None:
                raise ValidationFailedError(f"品項 {parsed.item_id} 沒有選項值 {cid}")
            unit += choice.get("price_delta", 0)
            option_names.append(choice["name"])
        line_total = unit * parsed.qty
        total += line_total
        lines.append({
            "item_id": parsed.item_id,
            "name": menu_item["name"],
            "qty": parsed.qty,
            "options": parsed.options,
            "option_names": option_names,
            "unit_price": unit,
            "line_total": line_total,
        })
    return lines, total


def readback_fragments(lines: list[dict], total: int) -> list[str]:
    """組出覆誦片段（與 prebuild 快取片段對應）。

    範例：「中杯 冰 奶茶」「2 份」「總共 50 元，確認嗎？」
    """
    fragments: list[str] = []
    for line in lines:
        desc = "".join(line["option_names"]) + line["name"]
        fragments.append(desc)
        if line["qty"] > 1:
            fragments.append(f"{line['qty']} 份")
    fragments.append(f"總共 {total} 元，確認嗎？")
    return fragments
