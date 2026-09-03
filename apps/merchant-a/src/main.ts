/** 快樂鹽酥雞官網前端（零按鍵版）。
 *
 * 「自家系統」的部分：菜單直接吃自家 legacy API（cents、英文欄位），
 * 由自家前端換算顯示。「嘴付協議」的部分：語音下單與 Chui Agent
 * 自動付款全走 Hub（經 adapter 翻譯接入）。
 */

import { HubClient, wireVoiceLoop } from "@chui/web";

interface LegacyProduct {
  sku: string;
  label: string;
  cents: number;
  mods: { code: string; label: string; extra_cents: number }[];
}

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const config = await (await fetch("/app-config.json")).json();

  // 自家格式：cents → 元 由自家前端換算
  const legacy = await (await fetch("/api/legacy/menu")).json();
  $("menu").innerHTML = (legacy.products as LegacyProduct[]).map((p) => `
    <div class="menu-row">
      <span>${p.label}
        <span class="mods">${p.mods.map((m) => m.label).join("・")}</span>
      </span>
      <span class="price">${p.cents / 100} 元</span>
    </div>`).join("");

  await wireVoiceLoop({
    hub: new HubClient(config.hub_url),
    merchantId: config.merchant_id,
  });
}

boot().catch((err) => {
  $("msg").innerHTML = `<div class="error">初始化失敗：${err.message}</div>`;
});
