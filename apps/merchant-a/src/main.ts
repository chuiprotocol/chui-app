/** 快樂鹽酥雞官網前端（雲端版：自家網址，**只串嘴付協議 API**）。
 *
 * 部署在 Cloudflare Pages（純靜態）：菜單展示、語音下單、Agent 自動付款
 * 全部只連 Chui Hub 一個端點——連菜單都是 Hub 從 adapter 翻譯來的協議菜單。
 * 自家 legacy 後端與 adapter 跑在 Hub 旁邊，網站完全不需要碰它們。
 */

import { HubClient, resolveRuntimeConfig, wireVoiceLoop } from "@chui/web";

const MERCHANT_ID = "happy-chicken";

const $ = (id: string) => document.getElementById(id)!;

interface ProtocolMenuItem {
  name: string;
  base_price: number;
  options: { choices: { name: string; price_delta: number }[] }[];
}

async function boot() {
  const config = await resolveRuntimeConfig();
  const hub = new HubClient(config.hubUrl);

  // 菜單：走協議（Hub ← adapter ← 自家 legacy 系統），官網零後端相依
  try {
    const resp = await fetch(`${hub.baseUrl}/v1/merchants/${MERCHANT_ID}/menu`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.detail?.message ?? `菜單取得失敗（${resp.status}）`);
    $("menu").innerHTML = (body.menu.items as ProtocolMenuItem[]).map((item) => `
      <div class="menu-row">
        <span>${item.name}
          <span class="mods">${item.options.flatMap((o) => o.choices.filter((c) => c.price_delta > 0 || c.name.startsWith("加")).map((c) => c.name)).join("・")}</span>
        </span>
        <span class="price">${item.base_price} 元</span>
      </div>`).join("");
  } catch (e) {
    $("menu").innerHTML = `<div class="error">${(e as Error).message}</div>`;
  }

  await wireVoiceLoop({ hub, merchantId: MERCHANT_ID });
}

boot().catch((err) => {
  $("msg").innerHTML = `<div class="error">初始化失敗：${err.message}</div>`;
});
