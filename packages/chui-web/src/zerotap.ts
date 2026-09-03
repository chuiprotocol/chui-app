/** 純語音循環 UI（三個前端共用）——照定稿設計圖實作。
 *
 * 兩個狀態：
 * 🅐 首次：只有一件事——「授權 N USDC 給你的點餐 Agent」（Slush 簽唯一一筆，
 *    錢進用戶自己的 Vault，agent 只拿 cap）。
 * 🅑 回訪：麥克風權限已授予 → 開頁自動開始聆聽；之後
 *    說話 → 靜音自動送出 → Agent 口頭覆誦並直接下單付款 → 口頭回報
 *    → 自動回到聆聽。全程零按鍵。
 *    （瀏覽器安全規定：權限「第一次」授予必須有一次點擊——之後永遠免按。）
 *
 * 期望元素 id：msg、authorize-screen、agent-status、topup-form、topup-usdc、
 * voice-screen、mic-circle、listen-status、quota-chip、transcript、
 * text-form、text-input（打字備援）、revoke-link（選配）。
 */

import { HubClient, type ParseResponse } from "./hub.js";
import { ChuiAgentSession } from "./session.js";
import { TapToTalkRecorder } from "./autovoice.js";
import { runAutoOrder } from "./autoflow.js";
import { signAndExecuteWithUserWallet } from "./pay.js";

const USDC = 1_000_000n;

export interface VoiceLoopConfig {
  hub: HubClient;
  merchantId?: string;
}

const $ = (id: string) => document.getElementById(id);
const need = (id: string): HTMLElement => {
  const el = $(id);
  if (!el) throw new Error(`頁面缺少 #${id}`);
  return el;
};

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-TW";
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
      setTimeout(resolve, Math.max(3000, text.length * 350)); // 合成器沒回呼時的保險
    } catch {
      resolve();
    }
  });
}

export async function wireVoiceLoop(config: VoiceLoopConfig): Promise<void> {
  const { hub, merchantId } = config;
  const msg = (kind: "error" | "info" | "ok", text: string) => {
    need("msg").innerHTML = `<div class="${kind}">${text}</div>`;
  };
  const clearMsg = () => { need("msg").innerHTML = ""; };

  const transcript = need("transcript");
  function bubble(kind: "user" | "agent", html: string) {
    const div = document.createElement("div");
    div.className = `bubble ${kind}`;
    div.innerHTML = html;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }
  function progressCard(html: string) {
    const div = document.createElement("div");
    div.className = "progress-card";
    div.innerHTML = html;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // ---- Hub 設定（package/module/幣別都由 Hub 提供，前端零硬編碼）----
  let health: Record<string, unknown>;
  try {
    health = await (await fetch(`${hub.baseUrl}/healthz`)).json();
  } catch (e) {
    msg("error", `連不上 Chui Hub：${(e as Error).message}`);
    return;
  }
  const network = String(health.network);
  const usdcCoinType = String(health.usdc_coin_type);
  const packageId = String(health.package_id ?? "");
  const moduleName = String(health.module ?? "vault");

  const session = await ChuiAgentSession.load(network);

  // ---- 畫面切換 ----
  const showAuthorize = () => { need("authorize-screen").classList.remove("hidden"); need("voice-screen").classList.add("hidden"); };
  const showVoice = () => { need("voice-screen").classList.remove("hidden"); need("authorize-screen").classList.add("hidden"); };

  async function refreshStatus(): Promise<"ready" | "unauthorized" | "unreachable"> {
    try {
      const status = await session.status();
      if (status.authorized && status.capActive && status.remainingUnits > 0n) {
        need("quota-chip").textContent =
          `🤖 額度 ${(Number(status.remainingUnits) / Number(USDC)).toFixed(2)} USDC`;
        return "ready";
      }
      const reason = !status.authorized ? ""
        : !status.capActive ? "（先前的授權已撤銷）"
        : "（額度已用完）";
      need("agent-status").innerHTML =
        `<div class="info">尚未有可用授權${reason}。授權後點餐全程零按鍵。<br/>` +
        `Agent 地址 <code>${session.address.slice(0, 10)}…${session.address.slice(-6)}</code></div>`;
      return "unauthorized";
    } catch (e) {
      need("agent-status").innerHTML = `<div class="error">${(e as Error).message}</div>`;
      return "unreachable";
    }
  }

  // ---- 🅐 一次性授權 ----
  need("topup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("topup-usdc") as HTMLInputElement;
    const usdcAmount = BigInt(Math.max(1, Math.floor(Number(input.value || "3"))));
    try {
      if (!packageId) throw new Error("合約尚未部署（Hub 未設定 CHUI_PACKAGE_ID）");
      msg("info", `請在 Slush 確認這「唯一一次」的授權（${usdcAmount} USDC 進你自己的 Vault＋0.05 SUI gas 給 Agent）…`);
      const tx = session.buildAuthorizeTransaction(
        packageId, moduleName, usdcCoinType,
        usdcAmount * USDC, usdcAmount * USDC, // 單筆上限預設＝全額
      );
      const { txDigest } = await signAndExecuteWithUserWallet(tx, network);
      msg("info", "授權交易已上鏈，讀取 Vault 資訊…");
      await session.completeAuthorize(txDigest, packageId, moduleName);
      clearMsg();
      const state = await refreshStatus();
      if (state === "ready") {
        showVoice();
        await speak("授權完成！之後開口說要點什麼，我會直接幫你下單付款。");
        void loop();
      }
    } catch (err) {
      msg("error", `授權沒有完成：${(err as Error).message}`);
    }
  });

  // ---- 🅑 語音循環 ----
  const recorder = new TapToTalkRecorder();
  let consecutiveErrors = 0;
  let looping = false;

  function setListening(on: boolean, label?: string) {
    need("mic-circle").classList.toggle("live", on);
    need("listen-status").textContent = label ?? (on ? "聆聽中⋯ 直接說就好" : "已暫停");
  }

  async function loop(): Promise<void> {
    if (looping || !recorder.isSupported) return;
    looping = true;
    while (looping) {
      let audio: Blob;
      try {
        setListening(true);
        audio = await recorder.record();
      } catch (err) {
        setListening(false, "麥克風無法使用——可改用下方打字備援");
        msg("error", (err as Error).message);
        looping = false;
        return;
      }
      setListening(false, "處理中⋯");
      if (audio.size < 1200) continue; // 太短視為噪音，直接回到聆聽
      const ok = await autoOrder({ audio });
      consecutiveErrors = ok ? 0 : consecutiveErrors;
      if (consecutiveErrors >= 2) {
        // 連續失敗就停下來，避免麥克風無限開著；點麥克風即可續播
        setListening(false, "連續失敗，已暫停——點一下麥克風繼續");
        looping = false;
        return;
      }
    }
  }

  async function autoOrder(input: { text: string } | { audio: Blob }): Promise<boolean> {
    let settledOk = false;
    await runAutoOrder(hub, session, input, {
      onProgress: (text) => msg("info", text),
      onQuote: (parsed: ParseResponse) => {
        clearMsg();
        bubble("user", parsed.intent.stt_text || "（語音輸入）");
        const routed = merchantId ? "" : `📍 ${parsed.merchant_name}｜`;
        bubble("agent", `${routed}${parsed.readback.text.replace("，確認嗎？", "")}，幫你下單付款 💳`);
        void speak(parsed.readback.text.replace("，確認嗎？", "，幫你下單付款"));
      },
      onClarify: async (question) => {
        bubble("agent", `🤔 ${question}`);
        await speak(question);
      },
      onSettled: async ({ parsed, merchantRef, amountUnits, settlement }) => {
        const verified = settlement.status === "settled_verified";
        progressCard(`
          <div class="step">✓ ${parsed.merchant_name} 已接單（取餐單號 <b>${merchantRef}</b>）</div>
          <div class="step">✓ Agent 自動付款 ${(amountUnits / 1_000_000).toFixed(2)} USDC（你沒按任何鍵）</div>
          <div class="step">${verified ? "✓ 鏈上驗證通過（digest／金額／店家相符）" : `⏳ 鏈上驗證中：${settlement.verify_reason ?? ""}`}</div>
          <a class="txlink" href="${settlement.explorer_url}" target="_blank" rel="noreferrer">🔗 在 Sui explorer 查看交易 ↗</a>`);
        bubble("agent", `付款完成！取餐單號 <b>${merchantRef}</b>，總共 ${parsed.quote.total} 元。還要什麼跟我說～`);
        clearMsg();
        settledOk = true;
        await refreshStatus().catch(() => undefined);
        await speak(`付款完成，取餐單號 ${merchantRef.split("-").pop()}，總共 ${parsed.quote.total} 元`);
      },
      onError: async (err) => {
        consecutiveErrors += 1;
        bubble("agent", `⚠️ ${err.message}`);
        msg("error", err.message);
        if (err.message.includes("額度不足") || err.message.includes("撤銷") || err.message.includes("尚未授權")) {
          showAuthorize();
          await refreshStatus().catch(() => undefined);
          looping = false;
        }
        await speak("這筆沒有成功，詳細原因顯示在畫面上");
      },
    }, merchantId);
    return settledOk;
  }

  // 麥克風圓圈：僅在「權限尚未授予」或「已暫停」時需要點一下
  need("mic-circle").addEventListener("click", () => {
    if (recorder.isRecording) { recorder.stop(); return; } // 提前送出
    consecutiveErrors = 0;
    void loop();
  });

  // 打字備援（麥克風不可用／沙箱測試用）
  need("text-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("text-input") as HTMLInputElement;
    if (!input.value.trim()) return;
    consecutiveErrors = 0;
    await autoOrder({ text: input.value.trim() });
    input.value = "";
  });

  // 撤銷（選配連結；由用戶 Slush 簽，單一交易生效）
  $("revoke-link")?.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      msg("info", "請在 Slush 確認撤銷交易（所有授權立即失效）…");
      const tx = session.buildRevokeTransaction(moduleName, usdcCoinType);
      await signAndExecuteWithUserWallet(tx, network);
      msg("ok", "已撤銷。剩餘金額可用「領回」交易取回。");
      looping = false;
      showAuthorize();
      await refreshStatus();
    } catch (err) {
      msg("error", `撤銷沒有完成：${(err as Error).message}`);
    }
  });

  // ---- 啟動：依授權狀態決定畫面；權限已授予就自動開始聆聽 ----
  const state = await refreshStatus();
  if (state === "ready") {
    showVoice();
    let granted = false;
    try {
      const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
      granted = perm.state === "granted";
    } catch { /* 不支援查詢的瀏覽器：等使用者點一下 */ }
    if (granted && recorder.isSupported) {
      void speak("歡迎回來！請說你要點什麼。");
      void loop();
    } else if (recorder.isSupported) {
      setListening(false, "點一下麥克風開始（只有第一次需要）");
    } else {
      setListening(false, "此環境無法錄音——請用下方打字備援");
    }
  } else {
    showAuthorize();
  }
}
