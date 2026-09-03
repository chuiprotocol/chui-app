/** 快樂鹽酥雞官網前端。
 *
 * 「自家系統」的部分：菜單直接吃自家 legacy API（cents、英文欄位），
 * 由自家前端換算顯示——證明這家店原本就有自己的資料格式。
 * 「嘴付協議」的部分：語音點餐與 USDC 結帳全部走 Chui Hub，
 * Hub 透過 adapter 讀到的是翻譯後的協議菜單。
 */

import {
  ClarificationNeeded,
  HubClient,
  PressToTalkRecorder,
  payWithSuiWallet,
  type ParseResponse,
} from "@chui/web";

interface LegacyProduct {
  sku: string;
  label: string;
  cents: number;
  mods: { code: string; label: string; extra_cents: number }[];
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string) => $(id).classList.remove("hidden");
const hide = (id: string) => $(id).classList.add("hidden");
const msg = (kind: "error" | "info" | "ok", text: string) => {
  $("msg").innerHTML = `<div class="${kind}">${text}</div>`;
};

let hub: HubClient;
let merchantId = "";
let currentOrder: ParseResponse | null = null;

async function boot() {
  const config = await (await fetch("/app-config.json")).json();
  hub = new HubClient(config.hub_url);
  merchantId = config.merchant_id;
  await renderLegacyMenu();
  setupVoice();
  setupText();
  setupConfirm();
}

async function renderLegacyMenu() {
  // 自家格式：cents → 元 由自家前端換算
  const legacy = await (await fetch("/api/legacy/menu")).json();
  $("menu").innerHTML = (legacy.products as LegacyProduct[]).map((p) => `
    <div class="menu-row">
      <span>${p.label}
        <span class="mods">${p.mods.map((m) => m.label).join("・")}</span>
      </span>
      <span class="price">${p.cents / 100} 元</span>
    </div>`).join("");
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
      await submit(() => hub.parseAudio(audio, merchantId));
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
    await submit(() => hub.parseText(input.value.trim(), merchantId));
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
      msg("info", `🤔 ${err.question}`);
      speak(err.question);
    } else {
      msg("error", (err as Error).message);
    }
  }
}

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
    msg("ok", "已取消。想吃什麼再喊一聲！");
  });

  $("pay-btn").addEventListener("click", async () => {
    if (!currentOrder) return;
    const btn = $("pay-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      msg("info", "向店家確認訂單（經 adapter 開單）…");
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
        <p>取餐單號：<code>${confirmed.merchant_ref}</code>（自家系統的單號）</p>
        <p><a href="${settlement.explorer_url}" target="_blank" rel="noreferrer">在 Sui Testnet explorer 查看交易 ↗</a></p>`;
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
