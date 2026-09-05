/** 雲端版商家 registry：菜單與接單邏輯內建在 Worker（builtin 整合）。
 *
 * 本機版 Hub 走協議 HTTP 呼叫三個商家行程（legacy＋adapter 的整合故事
 * 保留在 apps/merchant-a／storefront-template）；雲端免費 Worker 版沒有
 * localhost 可打，兩家店的「協議端點」改為內建實作：
 * - 菜單＝靜態化的協議菜單（happy-chicken 為 adapter 翻譯輸出的快照）
 * - 接單＝Durable Object 發取餐單號（日期前綴＋持久化流水號，永不重複）
 * - 出餐通知＝寫進事件匯流排（店家看板本來就吃 Hub 的 SSE）
 */

import menuHappyChicken from "../data/menu-happy-chicken.json";
import menuGoodtea from "../data/menu-goodtea.json";
import type { Menu } from "./rerank.js";

export interface BuiltinMerchant {
  merchant_id: string;
  name: string;
  integration: string;       // 對外顯示用（native | adapter）
  payout_address: string;
  web_url: string;
  ticket_prefix: string;     // 取餐單號前綴（FC-0905-0001 / TEA-0905-0001）
  menu: Menu;
}

export const MERCHANTS: BuiltinMerchant[] = [
  {
    merchant_id: "happy-chicken",
    name: "快樂鹽酥雞",
    integration: "adapter",
    payout_address: "0x302a6ceb986888f1463fa60d51ec31c5e52638a73ec4631f38e6eb3af9ea44c6",
    web_url: "https://chui-happy-chicken.pages.dev",
    ticket_prefix: "FC",
    menu: menuHappyChicken as Menu,
  },
  {
    merchant_id: "goodtea",
    name: "好喝奶茶店",
    integration: "native",
    payout_address: "0x134f4889339f351792f07799eead4e84e6daacc2bd718441aadcc916cd5dbd81",
    web_url: "https://chui-portal.pages.dev/?m=goodtea",
    ticket_prefix: "TEA",
    menu: menuGoodtea as Menu,
  },
];

export function getMerchant(id: string): BuiltinMerchant | undefined {
  return MERCHANTS.find((m) => m.merchant_id === id);
}
