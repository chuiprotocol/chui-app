/** 嘴付公版商家入口。
 *
 * 兩層：
 * 1. 入口（無 ?m 參數）：列出接上協議的商家——公版店面（如好喝奶茶店）
 *    點了直接進店；自家官網（如快樂鹽酥雞）給連結前往其網址。
 * 2. 店內（?m=goodtea）：標準零按鍵流程（一次性授權 → 純語音下單付款）。
 */

import { HubClient, hubDownMessage, resolveRuntimeConfig, wireVoiceLoop } from "@chui/web";

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string) => $(id).classList.remove("hidden");

interface MerchantRow {
  merchant_id: string;
  name: string;
  integration: string;
  web_url: string;
}

async function boot() {
  const config = await resolveRuntimeConfig();
  const hub = new HubClient(config.hubUrl);
  const merchantId = new URLSearchParams(location.search).get("m");

  if (!merchantId) {
    await renderList(hub);
    return;
  }
  await enterStore(hub, merchantId);
}

const SHOP_EMOJI: Record<string, string> = { "happy-chicken": "🍗", goodtea: "🧋" };

async function renderList(hub: HubClient) {
  show("list-view");
  try {
    const resp = await hub.merchants();
    const merchants = (resp?.merchants ?? []) as MerchantRow[];
    if (!merchants.length) throw new Error("Hub 回應裡沒有商家清單（fetch）");
    $("merchant-cards").innerHTML = merchants.map((m) => {
      const emoji = SHOP_EMOJI[m.merchant_id] ?? "🍽️";
      if (m.integration === "native") {
        // 公版店面：留在本站進店（保留 ?hub= 覆寫參數）
        const params = new URLSearchParams(location.search);
        params.set("m", m.merchant_id);
        return `<a class="merchant-card native" href="?${params}">
          <span class="memoji">${emoji}</span>
          <span class="mname">${m.name}</span>
          <span class="kind native">公版店面</span>
          <span class="go">進入點餐 →</span></a>`;
      }
      return `<a class="merchant-card adapter" href="${m.web_url}" target="_blank" rel="noreferrer">
        <span class="memoji">${emoji}</span>
        <span class="mname">${m.name}</span>
        <span class="kind adapter">自家官網</span>
        <span class="go">前往官網 ↗</span></a>`;
    }).join("");
  } catch (e) {
    const raw = (e as Error).message;
    $("merchant-cards").innerHTML =
      `<div class="error">${raw.includes("fetch") ? hubDownMessage(hub.baseUrl) : `載入商家清單失敗：${raw}`}</div>`;
  }
}

const ITEM_EMOJI: Record<string, string> = {
  珍珠奶茶: "🧋", 奶茶: "🥤", 四季春青茶: "🍵", 檸檬紅茶: "🍋",
  鹽酥雞: "🍗", 甜不辣: "🍢", 雞皮: "🍘", 魷魚鬚: "🦑", 地瓜薯條: "🍠", 米血: "🍡",
};

async function enterStore(hub: HubClient, merchantId: string) {
  show("store-view");
  // 店名與菜單走協議取得
  try {
    const resp = await fetch(`${hub.baseUrl}/v1/merchants/${merchantId}/menu`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.detail?.message ?? `菜單取得失敗（${resp.status}）`);
    $("page-title").textContent = body.name;
    $("page-tagline").textContent = "嘴付公版店面 · 用說的就能點";
    document.title = body.name;
    const health = await (await fetch(`${hub.baseUrl}/healthz`)).json().catch(() => ({}));
    const unitsPerTwd = Number(health.usdc_units_per_twd ?? 0);
    const usdc = (twd: number) => unitsPerTwd > 0
      ? `<span class="usdc-note">≈ ${((twd * unitsPerTwd) / 1_000_000).toFixed(2)} USDC</span>` : "";
    $("store-menu").innerHTML = (body.menu.items as { name: string; base_price: number }[])
      .map((item) => `
        <div class="menu-card">
          <div class="thumb">${ITEM_EMOJI[item.name] ?? "🥤"}</div>
          <div class="info">
            <div class="name">${item.name}</div>
            <div class="mods">統一大杯</div>
            <div class="pricerow"><span class="price">${item.base_price} 元起</span>${usdc(item.base_price)}</div>
          </div>
        </div>`)
      .join("");
  } catch (e) {
    const raw = (e as Error).message;
    $("msg").innerHTML =
      `<div class="error">${raw.includes("fetch") ? hubDownMessage(hub.baseUrl) : raw}</div>`;
  }

  $("back-link").addEventListener("click", (e) => {
    e.preventDefault();
    const params = new URLSearchParams(location.search);
    params.delete("m");
    location.search = params.toString();
  });

  await wireVoiceLoop({ hub, merchantId });
}

boot().catch((err) => {
  $("msg").innerHTML = `<div class="error">初始化失敗：${err.message}</div>`;
});
