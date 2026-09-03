/** 公版店面前端：語音／文字點餐 → 覆誦確認 → Slush USDC 結帳 → 收據。
 * 原生嘴付協議：所有訂單流程都走 Chui Hub，本店只提供菜單與接單。 */

import {
  ClarificationNeeded,
  HubClient,
  PressToTalkRecorder,
  payWithSuiWallet,
  type ParseResponse,
} from "@chui/web";

interface AppConfig {
  merchant_id: string;
  shop: { name: string; tagline: string; theme: { primary: string; accent: string; background: string } };
  hub_url: string;
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string) => $(id).classList.remove("hidden");
const hide = (id: string) => $(id).classList.add("hidden");
const msg = (kind: "error" | "info" | "ok", text: string) => {
  $("msg").innerHTML = `<div class="${kind}">${text}</div>`;
};

let hub: HubClient;
let config: AppConfig;
let currentOrder: ParseResponse | null = null;

async function boot() {
  config = await (await fetch("/app-config.json")).json();
  hub = new HubClient(config.hub_url);

  document.title = config.shop.name;
  $("shop-name").textContent = config.shop.name;
  $("shop-tagline").textContent = config.shop.tagline;
  const root = document.documentElement.style;
  root.setProperty("--primary", config.shop.theme.primary);
  root.setProperty("--accent", config.shop.theme.accent);
  root.setProperty("--bg", config.shop.theme.background);

  await renderMenu();
  setupVoice();
  setupText();
  setupConfirm();
}

async function renderMenu() {
  // 原生商家：自己的協議菜單就是展示來源
  const menu = await (await fetch("/chui/menu")).json();
  $("menu").innerHTML = menu.items.map((item: { name: string; base_price: number }) =>
    `<div class="menu-item"><b>${item.name}</b><span class="price">${item.base_price} 元起</span></div>`,
  ).join("");
}

function setupVoice() {
  const recorder = new PressToTalkRecorder();
  const btn = $("talk-btn");
  if (!recorder.isSupported) {
    btn.setAttribute("disabled", "true");
    btn.textContent = "🎙️ 此環境無法錄音（請用文字點餐）";
  }
  recorder.bindButton(btn, {
    onStart: () => {
      btn.classList.add("recording");
      btn.textContent = "🔴 放開送出";
    },
    onAudio: async (audio) => {
      btn.classList.remove("recording");
      btn.textContent = "🎙️ 按住說話";
      msg("info", "辨識中…");
      await submit(() => hub.parseAudio(audio, config.merchant_id));
    },
    onError: (err) => {
      btn.classList.remove("recording");
      btn.textContent = "🎙️ 按住說話";
      msg("error", err.message);
    },
  });
}

function setupText() {
  $("text-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("text-input") as HTMLInputElement;
    if (!input.value.trim()) return;
    msg("info", "解析中…");
    await submit(() => hub.parseText(input.value.trim(), config.merchant_id));
    input.value = "";
  });
}

async function submit(run: () => Promise<ParseResponse>) {
  try {
    const parsed = await run();
    currentOrder = parsed;
    $("msg").innerHTML = "";
    $("readback").textContent = parsed.readback.text;
    $("quote-lines").innerHTML = parsed.quote.lines.map((line) =>
      `<div class="quote-line"><span>${line.option_names.join("")}${line.name} × ${line.qty}</span>` +
      `<span>${line.line_total} 元</span></div>`,
    ).join("") + `<div class="quote-line"><b>總計</b><b>${parsed.quote.total} 元</b></div>`;
    hide("receipt-card");
    show("quote-card");
    speak(parsed.readback.text);
  } catch (err) {
    if (err instanceof ClarificationNeeded) {
      // 協議規定：不確定就必須問，絕不猜
      msg("info", `🤔 ${err.question}`);
      speak(err.question);
    } else {
      msg("error", (err as Error).message);
    }
  }
}

/** 覆誦：用瀏覽器內建語音唸出（demo 前端最輕量的做法；文字同步顯示） */
function speak(text: string) {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-TW";
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch { /* 無語音合成就只顯示文字 */ }
}

function setupConfirm() {
  $("cancel-btn").addEventListener("click", () => {
    currentOrder = null;
    hide("quote-card");
    msg("ok", "已取消。想喝什麼再跟我說！");
  });

  $("pay-btn").addEventListener("click", async () => {
    if (!currentOrder) return;
    const btn = $("pay-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      msg("info", "向店家確認訂單…");
      const confirmed = await hub.confirm(currentOrder.order_id);
      msg("info", `請在 Slush 錢包中確認交易（${(confirmed.checkout.amount_units / 1_000_000).toFixed(2)} USDC）…`);
      const { txDigest } = await payWithSuiWallet(confirmed.checkout);
      msg("info", "交易已送出，等待鏈上驗證…");
      const settlement = await hub.reportSettlement(currentOrder.order_id, txDigest);
      hide("quote-card");
      const verified = settlement.status === "settled_verified";
      $("receipt").innerHTML = `
        <div class="${verified ? "ok" : "info"}">
          ${verified ? "✅ 鏈上驗證通過（digest／金額／店家皆相符）"
                     : `⏳ 交易已送出，Hub 暫時無法驗證：${settlement.verify_reason ?? ""}`}
        </div>
        <p>單號：<code>${confirmed.merchant_ref}</code></p>
        <p><a href="${settlement.explorer_url}" target="_blank" rel="noreferrer">在 Sui Testnet explorer 查看交易 ↗</a></p>
        <p class="or">鏈上只看得到訂單雜湊，看不到你點了什麼。</p>`;
      show("receipt-card");
      $("msg").innerHTML = "";
      currentOrder = null;
    } catch (err) {
      msg("error", `付款沒有完成：${(err as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

boot().catch((err) => msg("error", `初始化失敗：${err.message}`));
