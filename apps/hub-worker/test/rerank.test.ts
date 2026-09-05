/** 重排序引擎 TS 移植版的對齊測試：
 * 案例與品質門檻完全複製 apps/api/tests/test_rerank.py——
 * Python 版與 Worker 版必須守住同一套行為。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensurePinyin } from "../src/phonetics.js";
import { RerankEngine, type Menu } from "../src/rerank.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MENU = JSON.parse(
  readFileSync(join(REPO, "examples", "happy-pig", "menu.json"), "utf8")) as Menu;
const DATASET = readFileSync(join(REPO, "eval", "dataset.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) as Array<{
    stt: string;
    gold: { items?: Array<{ item: string; qty: number; options: Record<string, string> }>; clarify?: boolean };
  }>;

let engine: RerankEngine;
beforeAll(async () => {
  await ensurePinyin();
  engine = new RerankEngine(MENU);
});

describe("關鍵行為（同 test_rerank.py）", () => {
  it("縮寫可還原：中冰奶 → 中杯冰奶茶", () => {
    const r = engine.parse(["中冰奶"]);
    expect(r.ok).toBe(true);
    expect(r.items[0].item_id).toBe("milk-tea");
    expect(r.items[0].options).toEqual({ size: "M", temp: "ICE" });
  });

  it("語音誤辨可還原：但餅 → 蛋餅", () => {
    const r = engine.parse(["給我但餅"]);
    expect(r.ok).toBe(true);
    expect(r.items[0].item_id).toBe("egg-pancake");
  });

  it("台語同義詞：菜頭粿加蛋", () => {
    const r = engine.parse(["菜頭粿加蛋"]);
    expect(r.ok).toBe(true);
    expect(r.items[0].item_id).toBe("radish-cake");
    expect(r.items[0].options.egg).toBe("YES");
  });

  it("亂句必問澄清，絕不無聲猜", () => {
    const r = engine.parse(["幫我叫一台計程車"]);
    expect(r.ok).toBe(false);
    expect(r.clarification_question).toBeTruthy();
  });

  it("多個 STT 候選挑最好的", () => {
    const r = engine.parse(["中並奈", "中冰奶"]);
    expect(r.ok).toBe(true);
    expect(r.items[0].item_id).toBe("milk-tea");
  });
});

describe("評估資料集品質門檻（README 數字的守門員）", () => {
  it("訂單正確率 ≥ 90%、應澄清樣本 0 無聲錯", () => {
    const orderRows = DATASET.filter((r) => r.gold.items);
    const clarifyRows = DATASET.filter((r) => r.gold.clarify);
    expect(orderRows.length + clarifyRows.length).toBeGreaterThanOrEqual(50);

    let correct = 0;
    const misses: string[] = [];
    for (const row of orderRows) {
      const result = engine.parse([row.stt]);
      const got = result.items
        .map((i) => `${i.item_id}|${i.qty}|${Object.entries(i.options).sort().map(([k, v]) => `${k}=${v}`).join(",")}`)
        .sort().join(";");
      const want = row.gold.items!
        .map((i) => `${i.item}|${i.qty}|${Object.entries(i.options).sort().map(([k, v]) => `${k}=${v}`).join(",")}`)
        .sort().join(";");
      if (result.ok && got === want) correct += 1;
      else misses.push(`${row.stt} → got=${got || "(none)"} want=${want}`);
    }
    if (correct / orderRows.length < 0.90) {
      throw new Error(`正確率 ${correct}/${orderRows.length} 低於 90%：\n${misses.join("\n")}`);
    }

    let silentWrong = 0;
    for (const row of clarifyRows) {
      const result = engine.parse([row.stt]);
      if (result.ok || !result.clarification_question) silentWrong += 1;
    }
    expect(silentWrong).toBe(0);
  });
});

// ---- 真機實測回歸（好喝奶茶店情境，同 test_rerank.py）----

const TEA_MENU: Menu = {
  items: [
    {
      id: "green-tea", name: "四季春青茶", base_price: 18,
      synonyms: ["青茶", "四季春", "清茶"],
      options: [
        {
          id: "sugar", name: "甜度", required: true, default: "FULL",
          choices: [
            { id: "FULL", name: "正常糖", synonyms: ["全糖"], price_delta: 0 },
            { id: "NONE", name: "無糖", synonyms: ["不要糖", "烏湯"], price_delta: 0 },
          ],
        },
        {
          id: "ice", name: "冰塊", required: true, default: "NORMAL",
          choices: [
            { id: "NORMAL", name: "正常冰", synonyms: [], price_delta: 0 },
            { id: "LESS", name: "少冰", synonyms: ["小冰"], price_delta: 0 },
          ],
        },
      ],
    },
  ],
};

describe("好喝奶茶店回歸", () => {
  let tea: RerankEngine;
  beforeAll(async () => {
    await ensurePinyin();
    tea = new RerankEngine(TEA_MENU);
  });

  it("「四」季春青茶的「四」不可被搶去當 4 份", () => {
    const r = tea.parse(["點一杯四季春青茶烏湯小冰"]);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].qty).toBe(1);
    expect(r.items[0].options).toEqual({ sugar: "NONE", ice: "LESS" });
  });

  it("同義詞拆兩段不可把同一品項拆成兩筆", () => {
    const r = tea.parse(["我要點一杯四季春青茶無糖少冰"]);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].qty).toBe(1);
  });

  it("沒明講的必填預設值靜默套用：explicit_options 不含它", () => {
    const r = tea.parse(["一杯四季春青茶"]);
    expect(r.ok).toBe(true);
    expect(r.items[0].options).toEqual({ sugar: "FULL", ice: "NORMAL" });
    expect(r.items[0].explicit_options).toEqual({});
  });
});
