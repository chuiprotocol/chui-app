/** 嘴付語音入口 App（零按鍵版）。
 *
 * 一次性授權 Chui Agent 之後：點一下說話 → 協議跨商家自動路由
 * → 自動下單 → Agent 自動付款。全程沒有確認鍵。
 */

import { HubClient, wireZeroTap } from "@chui/web";

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const config = await (await fetch("/app-config.json")).json();
  const hub = new HubClient(config.hub_url);

  const { merchants } = await hub.merchants();
  $("merchants").innerHTML = merchants.map((m) => `
    <div class="merchant-row">
      <span>${m.name}</span>
      <span class="kind ${m.integration}">${m.integration === "native" ? "原生協議" : "adapter 接入"}</span>
    </div>`).join("");

  // 不帶 merchantId：由 Hub 依信心度跨商家路由
  await wireZeroTap({ hub });
}

boot().catch((err) => {
  $("msg").innerHTML = `<div class="error">初始化失敗：${err.message}</div>`;
});
