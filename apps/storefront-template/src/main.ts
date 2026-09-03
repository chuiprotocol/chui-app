/** 公版店面前端（零按鍵版）。
 *
 * 一次性用 Slush 授權撥款給 Chui Agent 之後：
 * 點一下說話 → 說完自動送出 → 自動下單 → Agent 自動付款 → 收據。
 * 全程沒有任何確認鍵；訂單流程全走嘴付協議（Chui Hub）。
 */

import { HubClient, wireVoiceLoop } from "@chui/web";

interface AppConfig {
  merchant_id: string;
  shop: { name: string; tagline: string; theme: { primary: string; accent: string; background: string } };
  hub_url: string;
}

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const config: AppConfig = await (await fetch("/app-config.json")).json();
  document.title = config.shop.name;
  $("shop-name").textContent = config.shop.name;
  $("shop-tagline").textContent = config.shop.tagline;
  const root = document.documentElement.style;
  root.setProperty("--primary", config.shop.theme.primary);
  root.setProperty("--accent", config.shop.theme.accent);
  root.setProperty("--bg", config.shop.theme.background);

  // 原生商家：自己的協議菜單就是展示來源
  const menu = await (await fetch("/chui/menu")).json();
  $("menu").innerHTML = menu.items.map((item: { name: string; base_price: number }) =>
    `<div class="menu-item"><b>${item.name}</b><span class="price">${item.base_price} 元起</span></div>`,
  ).join("");

  await wireVoiceLoop({
    hub: new HubClient(config.hub_url),
    merchantId: config.merchant_id,
  });
}

boot().catch((err) => {
  $("msg").innerHTML = `<div class="error">初始化失敗：${err.message}</div>`;
});
