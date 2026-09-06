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
  payout_address?: string;
}

async function boot() {
  const config = await resolveRuntimeConfig();
  const hub = new HubClient(config.hubUrl);
  const params = new URLSearchParams(location.search);

  if (params.get("history")) {
    await renderHistory(hub);
    return;
  }
  if (params.get("dash")) {
    await renderDash(hub);
    return;
  }
  if (params.get("open")) {
    renderOpenShop(hub);
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

interface OrderLine {
  name: string; option_names: string[]; qty: number; line_total: number;
}
interface OrderRow {
  order_id: string; merchant_id: string; merchant_name: string;
  merchant_address: string; merchant_ref: string; total: number;
  amount_units: number; status: string; tx_digest: string;
  log_blob_id: string; owner_address: string; created_at: number;
  lines: OrderLine[];
  explorer_url?: string;
}

const STATUS_LABEL: Record<string, string> = {
  quoted: "已報價", confirmed: "已接單", paid_submitted: "已付款（驗證中）",
  settled_verified: "✅ 已付款・鏈上已驗證", pending_verification: "⏳ 鏈上驗證中",
};

function orderCard(o: OrderRow): string {
  const ts = o.created_at ? new Date(o.created_at * 1000).toLocaleString("zh-TW") : "";
  // 品項明細逐行：名稱（規格）× 數量　小計
  const items = (o.lines ?? []).map((ln) => `
      <li>
        <span class="item-name">${ln.name}</span>
        ${ln.option_names?.length ? `<span class="item-spec">（${ln.option_names.join("・")}）</span>` : ""}
        <span class="item-qty">× ${ln.qty}</span>
        <span class="item-sub">${ln.line_total} 元</span>
      </li>`).join("");
  return `
    <div class="card order-row" data-order="${o.order_id}">
      <div class="order-head">
        <b>${o.merchant_name}</b>
        <span class="order-ref">${o.merchant_ref || o.order_id}</span>
      </div>
      <div class="order-meta">🕐 ${ts}｜${STATUS_LABEL[o.status] ?? o.status}</div>
      ${items ? `<ul class="order-items">${items}</ul>` : ""}
      <div class="order-meta">合計 ${o.total} 元｜${(o.amount_units / 1_000_000).toFixed(2)} USDC</div>
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

// ---- 店家後台（?dash=1）：錢包即身分 ----
// 不列店家清單——連上錢包後用「收款地址」辨識是哪家店，直接進自家看板；
// 非任何店家的錢包則顯示未註冊訊息（開通請聯繫 k66）。

async function renderDash(hub: HubClient) {
  show("dash-view");
  const health = await (await fetch(`${hub.baseUrl}/healthz`)).json().catch(() => null);
  if (!health) { $("msg").innerHTML = `<div class="error">${hubDownMessage(hub.baseUrl)}</div>`; return; }

  $("dash-connect-btn").addEventListener("click", async () => {
    let addr = "";
    try {
      addr = await connectWalletAddress();
      const resp = await fetch(`${hub.baseUrl}/v1/merchants`);
      const merchants = ((await resp.json()).merchants ?? []) as MerchantRow[];
      // 一個錢包可以開多家店——全部列出來，一家就直接進
      const mine = merchants.filter(
        (m) => (m.payout_address ?? "").toLowerCase() === addr.toLowerCase());
      if (!mine.length) {
        $("dash-connect").innerHTML = `
          <div class="bigicon">🚫</div>
          <p class="bullet">此錢包 <code class="addr-full">${addr}</code> 非註冊的店家。</p>
          <p class="bullet">若您為嘴付平台店家，請使用正確錢包；<br/>
             若您還沒註冊，請私訊聯繫 <b>k66</b> 為您開通店家權限。</p>`;
        return;
      }
      const enter = async (m: MerchantRow) => {
        $("dash-connect").classList.add("hidden");
        $("dash-summary").classList.remove("hidden");
        await enterDash(hub, health, m, addr);
      };
      if (mine.length === 1) {
        await enter(mine[0]);
        return;
      }
      $("dash-connect").innerHTML = `
        <p class="bullet">這個錢包名下有 <b>${mine.length}</b> 家店——選一家進看板：</p>
        <div id="dash-shop-list"></div>`;
      const list = $("dash-shop-list");
      for (const m of mine) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "primary";
        btn.style.margin = "4px 0";
        btn.textContent = `🏪 ${m.name}`;
        btn.addEventListener("click", () => void enter(m));
        list.appendChild(btn);
      }
    } catch (e) {
      $("msg").innerHTML = `<div class="error">${(e as Error).message}</div>`;
    }
  });
}

async function enterDash(hub: HubClient, health: Record<string, unknown>,
                         merchant: MerchantRow, walletAddr: string) {
  const merchantId = merchant.merchant_id;
  $("dash-title").textContent = `${merchant.name}・接單看板`;
  $("dash-live").textContent = "● 即時連線中";
  async function refresh() {
    const resp = await fetch(`${hub.baseUrl}/v1/merchants/${merchantId}/orders`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.detail?.message ?? `讀取失敗（${resp.status}）`);
    const orders = (body.orders ?? []) as OrderRow[];
    const paid = orders.filter((o) => o.status === "settled_verified");
    const usdc = paid.reduce((sum, o) => sum + o.amount_units, 0) / 1_000_000;
    $("dash-summary").innerHTML =
      `<b>${orders.length}</b> 筆訂單｜已收 <b>${usdc.toFixed(2)} USDC</b>（鏈上已驗證 ${paid.length} 筆）` +
      `<div class="usdc-note">👛 已用店家錢包登入 <code>${walletAddr.slice(0, 12)}…${walletAddr.slice(-6)}</code></div>`;
    const list = $("dash-list");
    list.innerHTML = orders.length ? orders.map(orderCard).join("") : `<div class="card center">還沒有訂單——用手機下一單試試！</div>`;
    const session = await ChuiAgentSession.load(String(health.network));
    // 店家解密：requester＝剛登入的店家收款錢包（另一把鑰匙在消費者手上）
    wireDecryptLinks(list, sealogFromHealth(session.grpcClient, health), walletAddr);
  }

  try {
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

// ---- 開店頁（?open=1）：店家用自己的 Slush 錢包自助入駐 ----

// 預設的「客製化-選擇」組（勾了就整組掛到該品項；語音直接說得出來）
const PRESET_OPTIONS: Record<string, { name: string; def: string;
  choices: Array<{ id: string; name: string; synonyms: string[] }> }> = {
  spice: {
    name: "辣度", def: "NONE",
    choices: [
      { id: "NONE", name: "不辣", synonyms: ["免辣"] },
      { id: "MILD", name: "小辣", synonyms: ["微辣"] },
      { id: "MED", name: "中辣", synonyms: [] },
      { id: "HOT", name: "大辣", synonyms: ["特辣", "重辣"] },
    ],
  },
  ice: {
    name: "冰塊", def: "NORMAL",
    choices: [
      { id: "FREE", name: "去冰", synonyms: ["完全去冰"] },
      { id: "MICRO", name: "微冰", synonyms: [] },
      { id: "LESS", name: "少冰", synonyms: ["小冰"] },
      { id: "NORMAL", name: "正常冰", synonyms: ["全冰"] },
    ],
  },
  sugar: {
    name: "糖度", def: "FULL",
    choices: [
      { id: "NONE", name: "無糖", synonyms: ["不要糖"] },
      { id: "HALF", name: "半糖", synonyms: [] },
      { id: "FULL", name: "正常糖", synonyms: ["全糖"] },
    ],
  },
};

function renderOpenShop(hub: HubClient) {
  show("open-view");
  const rows = $("menu-rows");
  const addRow = () => {
    const div = document.createElement("div");
    div.className = "menu-row";
    div.innerHTML = `
      <div class="menu-row-main">
        <input class="mi-name" placeholder="品項名（例：豆花）" required />
        <input class="mi-price" type="number" min="1" step="1" placeholder="價格(元)" required />
        <button type="button" class="mi-del" aria-label="刪除品項">✕</button>
      </div>
      <div class="menu-row-opts">
        <span class="opt-label">客製化-選擇</span>
        <label><input type="checkbox" class="mi-opt" value="spice" />辣度</label>
        <label><input type="checkbox" class="mi-opt" value="ice" />冰塊</label>
        <label><input type="checkbox" class="mi-opt" value="sugar" />糖度</label>
        <input class="mi-extra" placeholder="客製化-特殊：加蒜, 菜多, 不要洋蔥（逗號分隔，選填）" />
      </div>`;
    div.querySelector(".mi-del")!.addEventListener("click", () => div.remove());
    rows.appendChild(div);
  };
  addRow();
  $("add-item").addEventListener("click", () => addRow());

  $("open-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("open-result");
    try {
      const name = ($("shop-name") as HTMLInputElement).value.trim();
      const prefix = ($("shop-prefix") as HTMLInputElement).value.trim().toUpperCase();
      const items = [...rows.querySelectorAll(".menu-row")].map((row, i) => {
        const itemName = (row.querySelector(".mi-name") as HTMLInputElement).value.trim();
        const price = parseInt((row.querySelector(".mi-price") as HTMLInputElement).value, 10);
        if (!itemName || !Number.isInteger(price) || price <= 0) {
          throw new Error(`第 ${i + 1} 個品項的名稱或價格不完整`);
        }
        // 客製化-選擇：勾選的預設組整組掛上（必填＋預設值，沒明講就靜默套用）
        const options = [...row.querySelectorAll<HTMLInputElement>(".mi-opt:checked")]
          .map((cb) => {
            const preset = PRESET_OPTIONS[cb.value];
            return {
              id: cb.value, name: preset.name, required: true, default: preset.def,
              choices: preset.choices.map((c) => ({ ...c, price_delta: 0 })),
            };
          });
        // 客製化-特殊：每個詞一個開關選項（語音說出該詞＝要；預設不加價）
        const extras = (row.querySelector(".mi-extra") as HTMLInputElement).value
          .split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        extras.forEach((word, k) => {
          options.push({
            id: `extra-${k + 1}`, name: word, required: false, default: "NO",
            choices: [
              // 「照常」不會被語音誤觸；覆誦只唸明講的選項所以也不會被唸出
              { id: "NO", name: word.startsWith("不") ? "照常" : `不${word}`, synonyms: [], price_delta: 0 },
              { id: "YES", name: word, synonyms: [], price_delta: 0 },
            ],
          });
        });
        return { id: `item-${i + 1}`, name: itemName, base_price: price, synonyms: [], options };
      });
      if (!items.length) throw new Error("至少要有一個品項");

      result.innerHTML = `<div class="info">請在 Slush 連線並簽署開店訊息（證明收款地址是你的）…</div>`;
      const address = await connectWalletAddress();
      // 簽名內容綁「地址＋店名」：簽得出來＝私鑰在店家手上，平台零代管
      const message = new TextEncoder().encode(
        `chui-open-shop:v1:${address.toLowerCase()}:${name}`);
      const signature = await signPersonalMessageWithUserWallet(message);

      const resp = await fetch(`${hub.baseUrl}/v1/merchants/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, ticket_prefix: prefix, payout_address: address,
          menu: { menu_version: "self-serve-1", currency: "TWD", items },
          signature,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body?.detail?.message ?? `開店失敗（${resp.status}）`);
      $("open-form-card").classList.add("hidden");
      result.innerHTML = `
        <div class="card center">
          <div class="bigicon">🎉</div>
          <h2>「${body.name}」開店成功！</h2>
          <p class="bullet">🛍 你的店面：<a href="/?m=${body.merchant_id}">立刻試點一單 →</a></p>
          <p class="bullet">🏪 接單看板：<a href="/?dash=1">用同一顆錢包進店家後台 →</a></p>
          <p class="bullet">💰 收款直達 <code>${address.slice(0, 10)}…${address.slice(-6)}</code>，平台不經手</p>
          <p class="bullet">🤖 已有自己的品牌網站？<a href="/developers/agent.html">用 AI 五分鐘把嘴付串進你的官網 →</a></p>
        </div>`;
    } catch (err) {
      result.innerHTML = `<div class="error">${(err as Error).message}</div>`;
    }
  });
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
        <b>🏪 店家專區</b>：
        <a href="?dash=1">後台（錢包登入）→</a>
        <a href="?open=1">我要開店 →</a>
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
