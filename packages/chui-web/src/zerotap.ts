/** 純語音循環 UI（三個前端共用）——照定稿設計圖實作。
 *
 * 兩個狀態：
 * 🅐 首次：只有一件事——「授權 N USDC 給你的點餐 Agent」（Slush 簽唯一一筆，
 *    錢進用戶自己的 Vault，agent 只拿 cap）。已有 Vault 時同一顆按鈕改走
 *    vault::deposit「加值」——額度累計，不會另開新 Vault 把舊的錢丟下。
 * 🅑 回訪：麥克風權限已授予 → 開頁自動開始聆聽；之後
 *    說話 → 靜音自動送出 → Agent 口頭覆誦並「問你確認」→ 你說「確認」
 *    才下單付款 → 口頭回報 → 自動回到聆聽。全程零按鍵、隨時可按結束對話。
 *    （瀏覽器安全規定：權限「第一次」授予必須有一次點擊——之後永遠免按。）
 *
 * 期望元素 id：msg、authorize-screen、agent-status、topup-form、topup-usdc、
 * voice-screen、mic-circle、listen-status、quota-chip、transcript、
 * text-form、text-input（打字備援）、end-chat（結束對話）、revoke-link（選配）。
 */

import { ClarificationNeeded, HubClient, type ParseResponse } from "./hub.js";
import { ChuiAgentSession } from "./session.js";
import { TapToTalkRecorder } from "./autovoice.js";
import { runAutoOrder } from "./autoflow.js";
import { signAndExecuteWithUserWallet } from "./pay.js";

const USDC = 1_000_000n;
// 單筆上限（內部測試放寬到 50 USDC；實際可花上限永遠＝Vault 餘額本身）。
// 上限設太緊會讓「之後加值」被卡住——合約沒有調整上限的入口，重建 Vault 才能改。
const PER_TX_LIMIT_UNITS = 50_000_000n;
const MIN_GAS_MIST = 10_000_000n;

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

const YES_WORDS = ["確認", "確定", "沒錯", "下單", "付款", "可以", "好的", "好啊", "對", "好", "是", "嗯", "ok", "OK", "Ok"];
const NO_WORDS = ["取消", "不要", "不用", "算了", "不對", "錯了", "重來", "重新"];

/** 口頭確認判讀：明確肯定 / 明確否定 / 都不是（可能是新的點餐內容） */
function confirmIntent(raw: string): "yes" | "no" | "other" {
  const text = raw.replace(/[\s。，！？!?.,]/g, "");
  if (!text) return "other";
  if (NO_WORDS.some((w) => text.includes(w))) return "no";
  if (YES_WORDS.some((w) => text.includes(w))) return "yes";
  return "other";
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

  // ---- Hub 設定（package/module/幣別/匯率都由 Hub 提供，前端零硬編碼）----
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
  const unitsPerTwd = Number(health.usdc_units_per_twd ?? 0);
  const twdToUsdc = (twd: number) =>
    unitsPerTwd > 0 ? `≈ ${((twd * unitsPerTwd) / 1_000_000).toFixed(2)} USDC` : "";

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

  // ---- 🅐 一次性授權／後續加值（同一顆按鈕，依狀態自動選路）----
  need("topup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("topup-usdc") as HTMLInputElement;
    const usdcValue = Number(input.value || "1");
    try {
      if (!Number.isFinite(usdcValue) || usdcValue < 0.3) {
        throw new Error("授權額度最低 0.3 USDC");
      }
      // 轉成最小單位（6 位小數）後全程整數運算
      const usdcUnits = BigInt(Math.round(usdcValue * 1_000_000));
      if (!packageId) throw new Error("合約尚未部署（Hub 未設定 CHUI_PACKAGE_ID）");

      // 已有同一套合約的有效 Vault → 加值（deposit），額度累計
      let canDeposit = false;
      let gasLow = false;
      if (session.currentBinding?.packageId === packageId) {
        try {
          const status = await session.status();
          canDeposit = status.authorized && status.capActive;
          gasLow = status.gasMist < MIN_GAS_MIST;
        } catch { /* 鏈上查不到就走建新 Vault 的路 */ }
      }

      if (canDeposit) {
        msg("info", `請在 Slush 確認加值交易（${usdcValue} USDC 存進你「既有」的 Vault，額度累計）…`);
        const tx = session.buildDepositTransaction(moduleName, usdcCoinType, usdcUnits, gasLow);
        const { txDigest } = await signAndExecuteWithUserWallet(tx, network);
        msg("info", "加值交易已上鏈，刷新額度…");
        await session.waitForSettled(txDigest);
      } else {
        msg("info", `請在 Slush 確認這「唯一一次」的授權（${usdcValue} USDC 進你自己的 Vault＋0.05 SUI gas 給 Agent）…`);
        const tx = session.buildAuthorizeTransaction(
          packageId, moduleName, usdcCoinType,
          usdcUnits, PER_TX_LIMIT_UNITS,
        );
        const { txDigest } = await signAndExecuteWithUserWallet(tx, network);
        msg("info", "授權交易已上鏈，讀取 Vault 資訊…");
        await session.completeAuthorize(txDigest, packageId, moduleName);
      }
      clearMsg();
      const state = await refreshStatus();
      if (state === "ready") {
        showVoice();
        await speak(canDeposit
          ? "加值完成！請說你要點什麼。"
          : "授權完成！之後開口說要點什麼，我會先跟你確認再下單付款。");
        void loop();
      }
    } catch (err) {
      msg("error", `授權沒有完成：${(err as Error).message}`);
    }
  });

  // ---- 🅑 語音循環 ----
  const recorder = new TapToTalkRecorder();
  let consecutiveErrors = 0;
  let consecutiveMisses = 0; // 連續聽不懂（澄清）次數——防跳針
  let looping = false;
  /** 已覆誦、等使用者口頭「確認」的訂單 */
  let pendingParsed: ParseResponse | null = null;

  function setListening(on: boolean, label?: string) {
    need("mic-circle").classList.toggle("live", on);
    need("listen-status").textContent = label ?? (on ? "聆聽中⋯ 直接說就好" : "已暫停");
  }

  function pauseLoop(label: string) {
    looping = false;
    setListening(false, label);
  }

  async function loop(): Promise<void> {
    if (looping || !recorder.isSupported) return;
    looping = true;
    while (looping) {
      let audio: Blob;
      try {
        setListening(true, pendingParsed ? "聆聽中⋯ 說「確認」下單、「取消」放棄" : undefined);
        audio = await recorder.record();
      } catch (err) {
        pauseLoop("麥克風無法使用——可改用下方打字備援");
        msg("error", (err as Error).message);
        return;
      }
      if (!looping) return; // 錄音中按了「結束對話」——丟棄這段，不下單
      setListening(false, "處理中⋯");
      if (audio.size < 1200) continue; // 太短視為噪音，直接回到聆聽
      await handleInput({ audio });
      if (consecutiveErrors >= 2) {
        pauseLoop("連續失敗，已暫停——點一下麥克風繼續");
        return;
      }
      if (consecutiveMisses >= 2) {
        pauseLoop("連續沒聽清楚，先暫停休息——點一下麥克風繼續");
        return;
      }
    }
  }

  /** 語音／文字輸入的統一入口：確認階段判讀 yes/no，其餘當成新的點餐。 */
  async function handleInput(input: { text: string } | { audio: Blob }): Promise<void> {
    // ---- 確認階段：先聽懂使用者是「確認」「取消」還是換單 ----
    if (pendingParsed) {
      let said = "";
      let reparsed: ParseResponse | null = null;
      if ("text" in input) {
        said = input.text;
      } else {
        try {
          reparsed = await hub.parseAudio(input.audio, merchantId);
          said = reparsed.intent.stt_text || "";
        } catch (err) {
          if (err instanceof ClarificationNeeded) {
            said = err.sttText;
          } else {
            consecutiveErrors += 1;
            msg("error", (err as Error).message);
            return;
          }
        }
      }
      const intent = confirmIntent(said);
      if (intent === "yes") {
        const order = pendingParsed;
        pendingParsed = null;
        bubble("user", said || "（確認）");
        await settleOrder(order);
        return;
      }
      if (intent === "no") {
        pendingParsed = null;
        consecutiveMisses = 0;
        bubble("user", said || "（取消）");
        bubble("agent", "好的，這筆取消了。想點什麼再跟我說～");
        clearMsg();
        await speak("好的，取消了。想點什麼再跟我說。");
        return;
      }
      // 聽起來像新的點餐內容 → 換單重新覆誦
      if (reparsed) {
        pendingParsed = null;
        await propose(reparsed);
        return;
      }
      if ("text" in input) {
        pendingParsed = null;
        await parseAndPropose(input);
        return;
      }
      // 聽不清楚 → 重問一次（不重複覆誦整張訂單）
      consecutiveMisses += 1;
      bubble("agent", "🤔 沒聽清楚——說「確認」我就下單付款，說「取消」就放棄這筆。");
      await speak("沒聽清楚，說確認我就下單付款，說取消就放棄");
      return;
    }
    // ---- 新的點餐 ----
    await parseAndPropose(input);
  }

  /** 解析輸入 → 覆誦並「口頭問確認」（不直接付款）。 */
  async function parseAndPropose(input: { text: string } | { audio: Blob }): Promise<void> {
    msg("info", "辨識中…");
    let parsed: ParseResponse;
    try {
      parsed = "text" in input
        ? await hub.parseText(input.text, merchantId)
        : await hub.parseAudio(input.audio, merchantId);
    } catch (err) {
      if (err instanceof ClarificationNeeded) {
        consecutiveMisses += 1;
        clearMsg();
        if (err.sttText) bubble("user", err.sttText);
        bubble("agent", `🤔 ${err.question}`);
        await speak(err.question);
      } else {
        consecutiveErrors += 1;
        msg("error", (err as Error).message);
        await speak("這筆沒有成功，詳細原因顯示在畫面上");
      }
      return;
    }
    await propose(parsed);
  }

  /** 覆誦訂單並「口頭問確認」；等下一句話決定要不要付款。 */
  async function propose(parsed: ParseResponse): Promise<void> {
    consecutiveMisses = 0;
    consecutiveErrors = 0;
    clearMsg();
    bubble("user", parsed.intent.stt_text || "（語音輸入）");
    const routed = merchantId ? "" : `📍 ${parsed.merchant_name}｜`;
    const usdcNote = twdToUsdc(parsed.quote.total);
    const question = parsed.readback.text.replace("，確認嗎？", "");
    bubble("agent", `${routed}${question}${usdcNote ? `（${usdcNote}）` : ""}——確認就下單付款，取消就放棄 🎙️`);
    pendingParsed = parsed;
    await speak(`${question}，跟你確認一下，要幫你下單付款嗎？說確認或取消`);
  }

  /** 已確認的訂單 → 下單＋Agent 自動付款＋鏈上驗證。 */
  async function settleOrder(parsed: ParseResponse): Promise<void> {
    await runAutoOrder(hub, session, { parsed }, {
      onProgress: (text) => msg("info", text),
      onSettled: async ({ parsed: p, merchantRef, amountUnits, settlement }) => {
        const verified = settlement.status === "settled_verified";
        progressCard(`
          <div class="step">✓ ${p.merchant_name} 已接單（取餐單號 <b>${merchantRef}</b>）</div>
          <div class="step">✓ Agent 自動付款 ${(amountUnits / 1_000_000).toFixed(2)} USDC（口頭確認後零按鍵）</div>
          <div class="step">${verified ? "✓ 鏈上驗證通過（digest／金額／店家相符）" : `⏳ 鏈上驗證中：${settlement.verify_reason ?? ""}`}</div>
          <a class="txlink" href="${settlement.explorer_url}" target="_blank" rel="noreferrer">🔗 在 Sui explorer 查看交易 ↗</a>`);
        bubble("agent", `付款完成！取餐單號 <b>${merchantRef}</b>，總共 ${p.quote.total} 元（${twdToUsdc(p.quote.total) || "USDC"}）。還要什麼跟我說～`);
        clearMsg();
        consecutiveErrors = 0;
        consecutiveMisses = 0;
        await refreshStatus().catch(() => undefined);
        await speak(`付款完成，取餐單號 ${merchantRef.split("-").pop()}，總共 ${p.quote.total} 元`);
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
  }

  // 麥克風圓圈：僅在「權限尚未授予」或「已暫停」時需要點一下
  need("mic-circle").addEventListener("click", () => {
    if (recorder.isRecording) { recorder.stop(); return; } // 提前送出
    consecutiveErrors = 0;
    consecutiveMisses = 0;
    void loop();
  });

  // 結束對話：立刻停止聆聽（錄到一半的內容直接丟棄，不會下單）
  $("end-chat")?.addEventListener("click", (e) => {
    e.preventDefault();
    pendingParsed = null;
    pauseLoop("已結束對話——點一下麥克風重新開始");
    if (recorder.isRecording) recorder.stop();
    try { speechSynthesis.cancel(); } catch { /* 無合成器 */ }
    clearMsg();
  });

  // 打字備援（麥克風不可用／沙箱測試用）
  need("text-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = need("text-input") as HTMLInputElement;
    if (!input.value.trim()) return;
    consecutiveErrors = 0;
    consecutiveMisses = 0;
    await handleInput({ text: input.value.trim() });
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
      pendingParsed = null;
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
