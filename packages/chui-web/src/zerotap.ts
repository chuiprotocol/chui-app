/** 零按鍵點餐 UI 佈線（三個前端共用）。
 *
 * 使用者體驗：
 * 1.（一次性）「授權 Chui Agent」——Slush 簽一筆撥款，之後再也不碰錢包。
 * 2. 點一下麥克風 → 說話 → 靜音自動送出 → 解析 → 下單 → Agent 自動付款
 *    → 收據。全程零確認鍵。
 * 3. 信心不足時唸出澄清問題並自動重新聆聽（最多連續 2 次，避免麥克風
 *    無限開著）。
 *
 * 期望頁面存在的元素 id：msg、talk-btn、text-form、text-input、
 * quote-card、readback、quote-lines、receipt-card、receipt、
 * agent-card、agent-status、topup-form、topup-usdc；
 * 選配：routed-merchant（語音入口顯示路由結果）。
 */

import { HubClient, type ParseResponse } from "./hub.js";
import { ChuiAgentSession } from "./session.js";
import { TapToTalkRecorder } from "./autovoice.js";
import { runAutoOrder } from "./autoflow.js";
import { signAndExecuteWithUserWallet } from "./pay.js";

const TOPUP_GAS_MIST = 50_000_000n; // 每次授權附 0.05 SUI 當 gas
const USDC_UNITS = 1_000_000n;

export interface ZeroTapConfig {
  hub: HubClient;
  merchantId?: string;
}

const $ = (id: string) => document.getElementById(id);
const need = (id: string): HTMLElement => {
  const el = $(id);
  if (!el) throw new Error(`頁面缺少 #${id}`);
  return el;
};
const show = (id: string) => $(id)?.classList.remove("hidden");
const hide = (id: string) => $(id)?.classList.add("hidden");

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-TW";
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
      // 保險：合成器沒回呼時 6 秒後放行
      setTimeout(resolve, 6000);
    } catch {
      resolve();
    }
  });
}

export async function wireZeroTap(config: ZeroTapConfig): Promise<void> {
  const { hub, merchantId } = config;
  const msg = (kind: "error" | "info" | "ok", text: string) => {
    need("msg").innerHTML = `<div class="${kind}">${text}</div>`;
  };
  const clearMsg = () => { need("msg").innerHTML = ""; };

  // Hub 告訴我們網路與 USDC coin type（前端零硬編碼）
  const health = await (await fetch(`${hub.baseUrl}/healthz`)).json();
  const network: string = health.network;
  const usdcCoinType: string = health.usdc_coin_type;

  const session = await ChuiAgentSession.load(network);

  // ---- Chui Agent 卡片：餘額與一次性授權 ----
  async function refreshAgent(): Promise<boolean> {
    const statusEl = need("agent-status");
    try {
      const { usdcUnits, suiMist } = await session.balances(usdcCoinType);
      const usdc = Number(usdcUnits) / Number(USDC_UNITS);
      const funded = usdcUnits > 0n && suiMist > TOPUP_GAS_MIST / 10n;
      statusEl.innerHTML = funded
        ? `<div class="ok">🤖 Chui Agent 已授權：可自動支付 <b>${usdc.toFixed(2)} USDC</b>` +
          `（gas ${(Number(suiMist) / 1e9).toFixed(3)} SUI）<br />` +
          `<code>${session.address.slice(0, 10)}…${session.address.slice(-6)}</code></div>`
        : `<div class="info">尚未授權：撥一筆小額給 Chui Agent，之後點餐就不再需要任何確認。<br />` +
          `Agent 地址 <code>${session.address.slice(0, 10)}…${session.address.slice(-6)}</code>` +
          `（目前 ${usdc.toFixed(2)} USDC）</div>`;
      return funded;
    } catch (e) {
      statusEl.innerHTML = `<div class="error">無法查詢 Agent 餘額：${(e as Error).message}</div>`;
      return false;
    }
  }

  need("topup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("topup-usdc") as HTMLInputElement;
    const usdcAmount = Math.max(1, Math.floor(Number(input.value || "5")));
    try {
      msg("info", `請在 Slush 確認這「唯一一次」的授權（${usdcAmount} USDC＋0.05 SUI gas）…`);
      const tx = session.buildTopUpTransaction(
        usdcCoinType, BigInt(usdcAmount) * USDC_UNITS, TOPUP_GAS_MIST,
      );
      const { txDigest } = await signAndExecuteWithUserWallet(tx, network);
      msg("ok", `授權完成（tx ${txDigest.slice(0, 10)}…）。之後點餐全自動，不再需要按任何鍵。`);
      await refreshAgent();
    } catch (err) {
      msg("error", `授權沒有完成：${(err as Error).message}`);
    }
  });

  // ---- 零按鍵下單流程 ----
  let autoListenBudget = 0; // 澄清後自動重新聆聽的剩餘次數

  async function autoOrder(input: { text: string } | { audio: Blob }): Promise<void> {
    await runAutoOrder(hub, session, input, {
      onProgress: (text) => msg("info", text),
      onQuote: (parsed: ParseResponse) => {
        const routed = $("routed-merchant");
        if (routed) routed.textContent =
          `${parsed.merchant_name}（協議自動路由，信心 ${parsed.intent.confidence.toFixed(2)}）`;
        need("readback").textContent = parsed.readback.text.replace("，確認嗎？", "");
        need("quote-lines").innerHTML = parsed.quote.lines.map((line) =>
          `<div class="quote-line"><span>${line.option_names.join("")}${line.name} × ${line.qty}</span>` +
          `<span>${line.line_total} 元</span></div>`,
        ).join("") + `<div class="quote-line"><b>總計</b><b>${parsed.quote.total} 元</b></div>`;
        hide("receipt-card");
        show("quote-card");
        void speak(parsed.readback.text.replace("，確認嗎？", "，自動付款中"));
      },
      onClarify: async (question) => {
        msg("info", `🤔 ${question}`);
        await speak(question);
        if (autoListenBudget > 0) {
          autoListenBudget -= 1;
          void listen(); // 說完澄清問題自動重新聆聽——仍然零按鍵
        }
      },
      onSettled: async ({ parsed, merchantRef, settlement }) => {
        hide("quote-card");
        const verified = settlement.status === "settled_verified";
        need("receipt").innerHTML = `
          <div class="${verified ? "ok" : "info"}">
            ${verified ? "✅ 鏈上驗證通過（digest／金額／店家皆相符）"
                       : `⏳ 交易已送出，Hub 暫時無法驗證：${settlement.verify_reason ?? ""}`}
          </div>
          <p>店家：${parsed.merchant_name}｜單號：<code>${merchantRef}</code></p>
          <p><a href="${settlement.explorer_url}" target="_blank" rel="noreferrer">在 Sui Testnet explorer 查看交易 ↗</a></p>
          <p class="hint">由 Chui Agent 自動付款——你沒有按任何確認鍵。鏈上只有訂單雜湊。</p>`;
        show("receipt-card");
        clearMsg();
        await refreshAgent();
        void speak(`付款完成，總共 ${parsed.quote.total} 元`);
      },
      onError: (err) => {
        msg("error", err.message);
        if (err.message.includes("餘額不足") || err.message.includes("gas")) show("agent-card");
      },
    }, merchantId);
  }

  // ---- 點一下說話（VAD 自動送出）----
  const recorder = new TapToTalkRecorder();
  const talkBtn = need("talk-btn");
  const talkIdleHtml = talkBtn.innerHTML;

  async function listen(): Promise<void> {
    if (recorder.isRecording) { // 再點一下＝提前送出
      recorder.stop();
      return;
    }
    try {
      talkBtn.classList.add("recording");
      talkBtn.innerHTML = talkIdleHtml.includes("<br") ? "🔴<br />聽你說…" : "🔴 聽你說…（說完自動送出）";
      const audio = await recorder.record();
      talkBtn.classList.remove("recording");
      talkBtn.innerHTML = talkIdleHtml;
      await autoOrder({ audio });
    } catch (err) {
      talkBtn.classList.remove("recording");
      talkBtn.innerHTML = talkIdleHtml;
      msg("error", (err as Error).message);
    }
  }

  if (!recorder.isSupported) {
    talkBtn.setAttribute("disabled", "true");
    talkBtn.innerHTML = talkIdleHtml.includes("<br") ? "🎙️<br />請用打字" : "🎙️ 此環境無法錄音（請用文字點餐）";
  }
  talkBtn.addEventListener("click", () => {
    autoListenBudget = 2; // 每次使用者主動點擊，重置澄清自動重聽額度
    void listen();
  });

  // 文字備援（同樣零確認：送出即下單付款）
  need("text-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("text-input") as HTMLInputElement;
    if (!input.value.trim()) return;
    autoListenBudget = 0;
    await autoOrder({ text: input.value.trim() });
    input.value = "";
  });

  await refreshAgent();
}
