/** 指令詞判讀的回歸測試（真機實測踩過的雷都收進來）。
 *
 * 背景：封閉詞彙引擎只認識菜單，「結束對話」曾被以 0.625 信心
 * 誤配成「地瓜薯條」、「取消下單」也被反問成點餐——所以前端
 * 拿到 STT 原文必須先過 intents 判讀，指令詞永遠優先於菜單比對。
 */

import { describe, expect, it } from "vitest";
import { confirmIntent, exitIntent } from "../../../packages/chui-web/src/intents.js";

describe("exitIntent（結束對話）", () => {
  it.each([
    "結束對話", "結束", "我要結束對話", "先這樣", "掰掰", "不點了",
    "結速對話", "傑束", // STT 同音誤辨
  ])("「%s」→ 離場", (s) => {
    expect(exitIntent(s)).toBe(true);
  });

  it.each(["一杯珍珠奶茶", "我不點鹽酥雞改點甜不辣", "地瓜薯條", ""])(
    "「%s」→ 不是離場", (s) => {
      expect(exitIntent(s)).toBe(false);
    });
});

describe("confirmIntent（確認／取消）", () => {
  it.each(["取消下單", "取消", "我要取消", "不要下單了", "娶消下單", "算了不要"])(
    "「%s」→ no（取消優先於「下單」肯定詞）", (s) => {
      expect(confirmIntent(s)).toBe("no");
    });

  it.each(["確認下單", "確認", "雀認", "下單", "好的", "對"])(
    "「%s」→ yes", (s) => {
      expect(confirmIntent(s)).toBe("yes");
    });

  it.each(["再給我一份米血", "珍珠奶茶半糖"])(
    "「%s」→ other（當成新點餐）", (s) => {
      expect(confirmIntent(s)).toBe("other");
    });
});
