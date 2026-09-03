/** 嘴付語音入口 App。
 *
 * 「一支 App、一段語音，能對 A、B 兩家下單結帳」——
 * parse 不帶 merchant_id，Hub 對每家商家的封閉詞彙各解析一次、
 * 依信心度路由；之後的確認、Slush USDC 結帳流程與商家官網完全一致。
 */

import {
  ClarificationNeeded,
  HubClient,
  PressToTalkRecorder,
  payWithSuiWallet,
  type ParseResponse,
} from "@chui/web";

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string) => $(id).classList.remove("hidden");
const hide = (id: string) => $(id).classList.add("hidden");
const msg = (kind: "error" | "info" | "ok", text: string) => {
  $("msg").innerHTML = `<div class="${kind}">${text}</div>`;
};

let hub: HubClient;
let currentOrder: ParseResponse | null = null;

async function boot() {
  const config = await (await fetch("/app-config.json")).json();
  hub = new HubClient(config.hub_url);
  await renderMerchants();
  setupVoice();
  setupText();
  setupConfirm();
}

async function renderMerchants() {
  const { merchants } = await hub.merchants();
  $("merchants").innerHTML = merchants.map((m) => `
    <div class="merchant-row">
      <span>${m.name}</span>
      <span class="kind ${m.integration}">${m.integration === "native" ? "原生協議" : "adapter 接入"}</span>
    </div>`).join("");
}

function setupVoice() {
  const recorder = new PressToTalkRecorder();
  const btn = $("talk-btn");
  if (!recorder.isSupported) {
    btn.setAttribute("disabled", "true");
    btn.innerHTML = "🎙️<br />請用打字";
  }
  recorder.bindButton(btn, {
    onStart: () => {
      btn.classList.add("recording");
      btn.innerHTML = "🔴<br />放開送出";
    },
    onAudio: async (audio) => {
      btn.classList.remove("recording");
      btn.innerHTML = "🎙️<br />按住說話";
      msg("info", "辨識中…");
      await submit(() => hub.parseAudio(audio));
    },
    onError: (err) => {
      btn.classList.remove("recording");
      btn.innerHTML = "🎙️<br />按住說話";
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
    await submit(() => hub.parseText(input.value.trim()));
    input.value = "";
  });
}

async function submit(run: () => Promise<ParseResponse>) {
  try {
    const parsed = await run();
    currentOrder = parsed;
    $("msg").innerHTML = "";
    $("routed-merchant").textContent =
      `${parsed.merchant_name}（協議自動路由，信心 ${parsed.intent.confidence.toFixed(2)}）`;
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
    msg("ok", "已取消。想吃什麼直接說！");
  });

  $("pay-btn").addEventListener("click", async () => {
    if (!currentOrder) return;
    const btn = $("pay-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      msg("info", `向 ${currentOrder.merchant_name} 確認訂單…`);
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
        <p>店家：${currentOrder.merchant_name}｜單號：<code>${confirmed.merchant_ref}</code></p>
        <p><a href="${settlement.explorer_url}" target="_blank" rel="noreferrer">在 Sui Testnet explorer 查看交易 ↗</a></p>
        <p class="hint">鏈上只看得到訂單雜湊，看不到你點了什麼。</p>`;
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
