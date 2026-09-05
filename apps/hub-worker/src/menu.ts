/** 菜單報價與覆誦（TypeScript 移植版，行為對齊 apps/api/chui_api/menu.py）。全部整數運算。 */

import type { Menu, MenuItem, ParsedItem } from "./rerank.js";

export class ValidationFailedError extends Error {
  code = "VALIDATION_FAILED";
  status = 422;
}

export interface QuoteLine {
  item_id: string;
  name: string;
  qty: number;
  options: Record<string, string>;
  option_names: string[];
  spoken_option_names: string[];
  unit_price: number;
  line_total: number;
}

/** 計算報價。回傳（明細行, 總金額）。 */
export function quoteItems(menu: Menu, items: ParsedItem[]): [QuoteLine[], number] {
  const itemsById = new Map<string, MenuItem>(menu.items.map((it) => [it.id, it]));
  const lines: QuoteLine[] = [];
  let total = 0;
  for (const parsed of items) {
    const menuItem = itemsById.get(parsed.item_id);
    if (!menuItem) throw new ValidationFailedError(`菜單沒有品項 ${parsed.item_id}`);
    let unit = menuItem.base_price;
    const optionNames: string[] = [];
    const spokenOptionNames: string[] = [];
    const explicit = parsed.explicit_options ?? {};
    for (const opt of menuItem.options ?? []) {
      const cid = parsed.options[opt.id];
      if (!cid) continue;
      const choice = opt.choices.find((c) => c.id === cid);
      if (!choice) throw new ValidationFailedError(`品項 ${parsed.item_id} 沒有選項值 ${cid}`);
      unit += choice.price_delta ?? 0;
      optionNames.push(choice.name);
      // 覆誦只唸使用者「明講」的選項；沒說的預設值（如預設冰塊）
      // 靜默套用，不對用戶強行宣告
      if (explicit[opt.id] === cid) spokenOptionNames.push(choice.name);
    }
    const lineTotal = unit * parsed.qty;
    total += lineTotal;
    lines.push({
      item_id: parsed.item_id,
      name: menuItem.name,
      qty: parsed.qty,
      options: parsed.options,
      option_names: optionNames,
      spoken_option_names: spokenOptionNames,
      unit_price: unit,
      line_total: lineTotal,
    });
  }
  return [lines, total];
}

function spokenNames(line: QuoteLine): string[] {
  return line.spoken_option_names ?? line.option_names;
}

/** 覆誦整句（線上 TTS 用）：「半糖去冰珍珠奶茶，總共 65 元，確認嗎？」 */
export function readbackText(lines: QuoteLine[], total: number): string {
  const parts: string[] = [];
  for (const line of lines) {
    let desc = spokenNames(line).join("") + line.name;
    if (line.qty > 1) desc += ` ${line.qty} 份`;
    parts.push(desc);
  }
  return parts.join("，") + `，總共 ${total} 元，確認嗎？`;
}

/** 協議菜單基本驗證：id／名稱／整數價格必須齊。 */
export function validateMenu(menu: Menu): void {
  if (!Array.isArray(menu.items) || !menu.items.length) {
    throw new ValidationFailedError("菜單缺 items");
  }
  for (const it of menu.items) {
    if (!it.id || !it.name || !Number.isInteger(it.base_price)) {
      throw new ValidationFailedError(`品項格式不符：${JSON.stringify(it).slice(0, 80)}`);
    }
    for (const opt of it.options ?? []) {
      if (!opt.id || !Array.isArray(opt.choices) || !opt.choices.length) {
        throw new ValidationFailedError(`品項 ${it.id} 的選項組格式不符`);
      }
      for (const ch of opt.choices) {
        if (!ch.id || !ch.name || !Number.isInteger(ch.price_delta ?? 0)) {
          throw new ValidationFailedError(`品項 ${it.id} 的選項值格式不符`);
        }
      }
    }
  }
}
