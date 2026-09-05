/** 嘴付公版商家入口。
 *
 * 兩層：
 * 1. 入口（無 ?m 參數）：列出接上協議的商家——公版店面（如好喝奶茶店）
 *    點了直接進店；自家官網（如快樂鹽酥雞）給連結前往其網址。
 * 2. 店內（?m=goodtea）：標準零按鍵流程（一次性授權 → 純語音下單付款）。
 */

import {
  ChuiAgentSession, HubClient, findSuiWallet, hubDownMessage,
  resolveRuntimeConfig, sealogFromHealth, signPersonalMessageWithUserWallet,
  wireVoiceLoop, type SealLogVault,
} from "@chui/web";

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
  const params = new URLSearchParams(location.search);

  if (params.get("history")) {
    await renderHistory(hub);
    return;
  }
  const dashId = params.get("dash");
  if (dashId) {
    await renderDash(hub, dashId);
    return;
  }
  const merchantId = params.get("m");
  if (!merchantId) {
    await renderList(hub);
    return;
  }
  await enterStore(hub, merchantId);
}

// ---- 共用：訂單列渲染＋Seal 解密（鑰匙只在當事人錢包） ----

interface OrderRow {
  order_id: string; merchant_id: string; merchant_name: string;
  merchant_address: string; merchant_ref: string; total: number;
  amount_units: number; status: string; tx_digest: string;
  log_blob_id: string; owner_address: string; created_at: number;
  explorer_url?: string;
}

const STATUS_LABEL: Record<string, string> = {
  quoted: "已報價", confirmed: "已接單", paid_submitted: "已付款（驗證中）",
  settled_verified: "✅ 已付款・鏈上已驗證", pending_verification: "⏳ 鏈上驗證中",
};

function orderCard(o: OrderRow): string {
  const ts = o.created_at ? new Date(o.created_at * 1000).toLocaleString("zh-TW") : "";
  return `
    <div class="card order-row" data-order="${o.order_id}">
      <div class="order-head">
        <b>${o.merchant_name}</b>
        <span class="order-ref">${o.merchant_ref || o.order_id}</span>
      </div>
      <div class="order-meta">${ts}｜${o.total} 元｜${(o.amount_units / 1_000_000).toFixed(2)} USDC｜${STATUS_LABEL[o.status] ?? o.status}</div>
      <div class="order-links">
        ${o.explorer_url ? `<a class="txlink" href="${o.explorer_url}" target="_blank" rel="noreferrer">🔗 鏈上交易 ↗</a>` : ""}
        ${o.log_blob_id ? `<a class="txlink unseal" href="#" data-blob="${o.log_blob_id}">🔐 用錢包解密對話紀錄</a>` : `<span class="usdc-note">（無加密紀錄）</span>`}
      </div>
      <div class="order-log hidden"></div>
    </div>`;
}

function wireDecryptLinks(container: HTMLElement, vault: SealLogVault | null,
                          requesterAddr: string) {
  container.querySelectorAll<HTMLAnchorElement>(".unseal").forEach((a) => {
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const holder = a.closest(".order-row")!.querySelector(".order-log") as HTMLElement;
      holder.classList.remove("hidden");
      if (!vault) { holder.innerHTML = `<div class="error">Hub 未提供 Seal 設定</div>`; return; }
      holder.innerHTML = `<div class="info">請在 Slush 簽署個人訊息（向 Seal key server 證明你是當事人）…</div>`;
      try {
        const log = await vault.fetchAndDecrypt(a.dataset.blob!, requesterAddr, signPersonalMessageWithUserWallet);
        holder.innerHTML = `<div class="ok">🔓 解密成功（此錢包是這筆訂單的當事人）</div>` +
          log.entries.map((l) => `<div class="logline">${l.role === "user" ? "🗣" : l.role === "agent" ? "🤖" : "⚙️"} ${l.text}</div>`).join("");
      } catch (err) {
        holder.innerHTML = `<div class="error">解密失敗：${(err as Error).message}<br/>（不是這筆訂單的當事人錢包，key server 就是不發鑰——這正是隱私設計）</div>`;
      }
    });
  });
}

async function connectWalletAddress(): Promise<string> {
  const wallet = await findSuiWallet();
  const { accounts } = await wallet.features["standard:connect"].connect();
  if (!accounts[0]) throw new Error("錢包沒有可用帳戶");
  return accounts[0].address;
}

// ---- 用戶歷史頁（?history=1） ----

async function renderHistory(hub: HubClient) {
  show("history-view");
  const health = await (await fetch(`${hub.baseUrl}/healthz`)).json().catch(() => null);
  if (!health) { $("msg").innerHTML = `<div class="error">${hubDownMessage(hub.baseUrl)}</div>`; return; }
  $("history-connect-btn").addEventListener("click", async () => {
    try {
      const addr = await connectWalletAddress();
      $("history-connect").innerHTML =
        `<p class="bullet">👛 <code>${addr.slice(0, 10)}…${addr.slice(-6)}</code> 的鏈上訂單</p>`;
      const resp = await fetch(`${hub.baseUrl}/v1/logs?owner=${encodeURIComponent(addr)}`);
      const body = await resp.json();
      const orders = (body.orders ?? []) as OrderRow[];
      const list = $("history-list");
      list.innerHTML = orders.length
        ? orders.map(orderCard).join("")
        : `<div class="card center">這個錢包還沒有已驗證的訂單。<br/>
           <span class="usdc-note">（訂單要完成鏈上驗證後，才會依 SettlementEvent 的 owner 歸戶）</span></div>`;
      const session = await ChuiAgentSession.load(String(health.network));
      wireDecryptLinks(list, sealogFromHealth(session.grpcClient, health), addr);
    } catch (e) {
      $("msg").innerHTML = `<div class="error">${(e as Error).message}</div>`;
    }
  });
}

// ---- 店家後台（?dash=merchant_id）：即時接單＋歷史流水 ----

async function renderDash(hub: HubClient, merchantId: string) {
  show("dash-view");
  const health = await (await fetch(`${hub.baseUrl}/healthz`)).json().catch(() => null);
  if (!health) { $("msg").innerHTML = `<div class="error">${hubDownMessage(hub.baseUrl)}</div>`; return; }

  let merchantAddr = "";
  async function refresh() {
    const resp = await fetch(`${hub.baseUrl}/v1/merchants/${merchantId}/orders`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.detail?.message ?? `讀取失敗（${resp.status}）`);
    const orders = (body.orders ?? []) as OrderRow[];
    merchantAddr = orders[0]?.merchant_address ?? merchantAddr;
    const paid = orders.filter((o) => o.status === "settled_verified");
    const usdc = paid.reduce((sum, o) => sum + o.amount_units, 0) / 1_000_000;
    $("dash-summary").innerHTML =
      `<b>${orders.length}</b> 筆訂單｜已收 <b>${usdc.toFixed(2)} USDC</b>（鏈上已驗證 ${paid.length} 筆）` +
      (merchantAddr ? `<div class="usdc-note">收款地址 <code>${merchantAddr.slice(0, 12)}…${merchantAddr.slice(-6)}</code></div>` : "");
    const list = $("dash-list");
    list.innerHTML = orders.length ? orders.map(orderCard).join("") : `<div class="card center">還沒有訂單——用手機下一單試試！</div>`;
    const session = await ChuiAgentSession.load(String(health.network));
    // 店家解密：requester＝店家收款錢包（在 Slush 匯入店家錢包後點解密）
    wireDecryptLinks(list, sealogFromHealth(session.grpcClient, health),
      merchantAddr || (await connectWalletAddress().catch(() => "")));
  }

  try {
    const nameResp = await fetch(`${hub.baseUrl}/v1/merchants`);
    const merchants = (await nameResp.json()).merchants as { merchant_id: string; name: string }[];
    $("dash-title").textContent = `${merchants.find((m) => m.merchant_id === merchantId)?.name ?? merchantId}・接單看板`;
    await refresh();
  } catch (e) {
    $("dash-list").innerHTML = `<div class="error">${(e as Error).message}</div>`;
    return;
  }

  // 即時：訂 Hub 的 SSE 封包流，這家店的事件一來就刷新
  //（用戶 5 秒反悔期結束送單 → chui.order → 立刻出現在看板）
  try {
    const es = new EventSource(`${hub.baseUrl}/v1/events`);
    let booted = false;
    setTimeout(() => { booted = true; }, 1500); // 略過歷史回放，只對新事件刷新
    es.onmessage = (ev) => {
      if (!booted) return;
      try {
        const event = JSON.parse(ev.data);
        const mine = String(event.from).includes(merchantId) || String(event.to).includes(merchantId);
        if (mine && ["chui.order", "chui.order.accepted", "chui.paid", "chain.verified"].includes(event.kind)) {
          void refresh();
        }
      } catch { /* 非 JSON 行忽略 */ }
    };
    es.onerror = () => { $("dash-live").textContent = "○ 連線中斷，改用手動重新整理"; };
  } catch { $("dash-live").textContent = "○ 此環境不支援即時串流"; }
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
    }).join("") + `
      <div class="card dashlinks">
        <b>🏪 店家後台</b>（接單看板＋流水＋錢包解密）：
        ${(merchants as MerchantRow[]).map((m) =>
          `<a href="?dash=${m.merchant_id}">${m.name}</a>`).join("　")}
      </div>`;
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
