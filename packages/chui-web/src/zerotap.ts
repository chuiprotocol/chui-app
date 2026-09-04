/** 純語音循環 UI（三個前端共用）。
 *
 * 流程（foodpanda 式改版後）：
 * 首頁常駐菜單，頂部「🎙 嘴付下單」按鈕開啟語音面板（overlay）。
 * 🅐 首次：授權 N USDC 給點餐 Agent（Slush 簽唯一一筆；已有 Vault 則走
 *    deposit 加值累計）。
 * 🅑 之後：說話 → Agent 覆誦並口頭問確認 → 說「確認」→ **5 秒防呆倒數**
 *    （期間可一鍵「反悔棄單」）→ 倒數走完才自動下單付款 → 口頭回報。
 * 每筆完成的訂單，整段對話 log 會在瀏覽器內用 Seal 加密、上傳 Walrus——
 * 只有用戶錢包與店家能解密，嘴付平台無權看。
 *
 * 期望元素 id：msg、authorize-screen、agent-status、topup-form、topup-usdc、
 * voice-screen、mic-circle、listen-status、quota-chip、transcript、
 * text-form、text-input、end-chat；選配：open-voice、voice-overlay、
 * close-voice、revoke-link。
 */

import { ClarificationNeeded, HubClient, type CheckoutParams, type ParseResponse } from "./hub.js";
import { hubDownMessage } from "./config.js";
import { ChuiAgentSession } from "./session.js";
import { TapToTalkRecorder } from "./autovoice.js";
import { runAutoOrder } from "./autoflow.js";
import { signAndExecuteWithUserWallet, signPersonalMessageWithUserWallet } from "./pay.js";
import { SealLogVault, type LogEntry } from "./sealog.js";

const USDC = 1_000_000n;
// 單筆上限（內部測試放寬到 50 USDC；實際可花上限永遠＝Vault 餘額本身）。
const PER_TX_LIMIT_UNITS = 50_000_000n;
const MIN_GAS_MIST = 10_000_000n;
// 防呆倒數秒數：確認後、扣款前的反悔窗口
const REGRET_SECONDS = 5;

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
  // 對話 log：加密存證的原始素材（settle 後上傳、之後歸零重新累積）
  let convo: LogEntry[] = [];
  const logLine = (role: LogEntry["role"], text: string) => {
    convo.push({ role, text, ts: Date.now() });
  };
  function bubble(kind: "user" | "agent", html: string) {
    const div = document.createElement("div");
    div.className = `bubble ${kind}`;
    div.innerHTML = html;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
    logLine(kind, div.textContent ?? "");
  }
  function progressCard(html: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "progress-card";
    div.innerHTML = html;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
    return div;
  }

  // ---- Hub 設定（package/module/幣別/匯率/Seal/Walrus 全由 Hub 提供）----
  let health: Record<string, unknown>;
  try {
    health = await (await fetch(`${hub.baseUrl}/healthz`)).json();
  } catch {
    msg("error", hubDownMessage(hub.baseUrl));
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
  // Seal 存證（設定不齊時 sealVault 為 null，存證失敗會誠實顯示、不擋付款流程）
  let sealVault: SealLogVault | null = null;
  try {
    sealVault = new SealLogVault(session.grpcClient, {
      packageId,
      keyServerIds: (health.seal_key_servers as string[] | undefined) ?? [],
      walrusPublisher: String(health.walrus_publisher ?? ""),
      walrusAggregator: String(health.walrus_aggregator ?? ""),
    });
  } catch { /* 沒設定就不做存證 */ }

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
  /** 倒數中的棄單控制（防呆窗口） */
  let regretAbort: (() => void) | null = null;

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
      // 全程沒偵測到人聲 → 不送辨識、不算失敗，直接回到聆聽
      if (!recorder.voiceDetected || audio.size < 1200) { continue; }
      setListening(false, "處理中⋯");
      await handleInput({ audio });
      if (consecutiveErrors >= 2) {
        pauseLoop("連續失敗，已暫停——點一下麥克風繼續");
        return;
      }
      if (consecutiveMisses >= 3) {
        pauseLoop("連續沒聽清楚，先暫停休息——點一下麥克風繼續");
        return;
      }
    }
  }

  /** 語音／文字輸入的統一入口：確認階段判讀 yes/no，其餘當成新的點餐。 */
  async function handleInput(input: { text: string } | { audio: Blob }): Promise<void> {
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
        // ---- 防呆倒數：說了確認也還有 5 秒可以整單反悔 ----
        const proceed = await regretCountdown(order);
        if (!proceed) return;
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
      consecutiveMisses += 1;
      bubble("agent", "🤔 沒聽清楚——說「確認」我就下單付款，說「取消」就放棄這筆。");
      await speak("沒聽清楚，說確認我就下單付款，說取消就放棄");
      return;
    }
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

  /**
   * 防呆倒數：確認後、真正扣款前的 5 秒反悔窗口。
   * 回傳 true＝倒數走完照常下單；false＝用戶按了「反悔棄單」。
   */
  function regretCountdown(order: ParseResponse): Promise<boolean> {
    setListening(false, "最後確認中⋯");
    const card = progressCard(`
      <div class="regret">
        <div class="regret-title">⏳ <b><span class="regret-count">${REGRET_SECONDS}</span> 秒</b>後自動下單付款</div>
        <div class="regret-sub">${order.quote.lines.map((l) => l.name).join("、")}｜${order.quote.total} 元</div>
        <button type="button" class="regret-btn">✋ 反悔棄單</button>
      </div>`);
    const countEl = card.querySelector(".regret-count") as HTMLElement;
    const btn = card.querySelector(".regret-btn") as HTMLButtonElement;
    logLine("system", `防呆倒數 ${REGRET_SECONDS} 秒開始`);
    return new Promise<boolean>((resolve) => {
      let left = REGRET_SECONDS;
      const timer = window.setInterval(() => {
        left -= 1;
        countEl.textContent = String(left);
        if (left <= 0) {
          window.clearInterval(timer);
          regretAbort = null;
          btn.disabled = true;
          card.classList.add("regret-done");
          logLine("system", "倒數結束，開始下單付款");
          resolve(true);
        }
      }, 1000);
      const abort = () => {
        window.clearInterval(timer);
        regretAbort = null;
        card.remove();
        bubble("agent", "🛑 已棄單，一毛錢都沒扣。想重點再跟我說～");
        clearMsg();
        void speak("已棄單，沒有扣款。想重點再跟我說。");
        resolve(false);
      };
      regretAbort = abort;
      btn.addEventListener("click", abort);
    });
  }

  /** 已確認＋倒數走完的訂單 → 下單＋Agent 自動付款＋鏈上驗證＋加密存證。 */
  async function settleOrder(parsed: ParseResponse): Promise<void> {
    await runAutoOrder(hub, session, { parsed }, {
      onProgress: (text) => msg("info", text),
      onSettled: async ({ parsed: p, merchantRef, amountUnits, settlement, checkout }) => {
        const verified = settlement.status === "settled_verified";
        progressCard(`
          <div class="step">✓ ${p.merchant_name} 已接單（取餐單號 <b>${merchantRef}</b>）</div>
          <div class="step">✓ Agent 自動付款 ${(amountUnits / 1_000_000).toFixed(2)} USDC（口頭確認＋倒數後零按鍵）</div>
          <div class="step">${verified ? "✓ 鏈上驗證通過（digest／金額／店家相符）" : `⏳ 鏈上驗證中：${settlement.verify_reason ?? ""}`}</div>
          <a class="txlink" href="${settlement.explorer_url}" target="_blank" rel="noreferrer">🔗 在 Sui explorer 查看交易 ↗</a>`);
        bubble("agent", `付款完成！取餐單號 <b>${merchantRef}</b>，總共 ${p.quote.total} 元（${twdToUsdc(p.quote.total) || "USDC"}）。還要什麼跟我說～`);
        clearMsg();
        consecutiveErrors = 0;
        consecutiveMisses = 0;
        await refreshStatus().catch(() => undefined);
        await speak(`付款完成，取餐單號 ${merchantRef.split("-").pop()}，總共 ${p.quote.total} 元`);
        void sealAndUploadLog(merchantRef, checkout);
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

  /** 訂單完成後：整段對話在瀏覽器內 Seal 加密 → 上傳 Walrus → 顯示存證卡。 */
  async function sealAndUploadLog(merchantRef: string, checkout: CheckoutParams): Promise<void> {
    if (!sealVault) return; // Hub 沒發 Seal 設定：不做存證（不影響點餐）
    const entries = convo;
    convo = []; // 下一筆訂單從新的 log 開始
    const card = progressCard(`<div class="step">🔐 對話紀錄加密存證中（Seal ＋ Walrus）⋯</div>`);
    try {
      const owner = await session.ownerAddress();
      const sealed = await sealVault.encryptAndUpload(entries, owner, checkout.merchant_address, {
        merchant_ref: merchantRef,
      });
      card.innerHTML = `
        <div class="step">🔐 對話紀錄已端對端加密上傳 Walrus</div>
        <div class="step sealed-id">blob：<code>${sealed.blobId.slice(0, 14)}…</code>
          <a href="${sealed.blobUrl}" target="_blank" rel="noreferrer">密文 ↗</a></div>
        <div class="step">🔑 只有「你的錢包」與「店家」能解密——嘴付平台無權看</div>
        <a href="#" class="txlink unseal-link">用 Slush 解密查看（證明鑰匙在你手上）</a>`;
      card.querySelector(".unseal-link")?.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          msg("info", "請在 Slush 簽署個人訊息（Seal 取鑰身分證明）…");
          const log = await sealVault!.fetchAndDecrypt(sealed.blobId, owner, signPersonalMessageWithUserWallet);
          clearMsg();
          progressCard(`
            <div class="step">🔓 解密成功（key server 已驗證你是當事人）</div>
            ${log.entries.slice(0, 12).map((l) => `<div class="step logline">${l.role === "user" ? "🗣" : l.role === "agent" ? "🤖" : "⚙️"} ${l.text}</div>`).join("")}`);
        } catch (err) {
          msg("error", `解密失敗：${(err as Error).message}`);
        }
      });
    } catch (err) {
      card.innerHTML = `<div class="step">⚠️ 加密存證失敗：${(err as Error).message}（付款不受影響）</div>`;
    }
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
    regretAbort?.();
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

  // ---- 啟動 ----
  async function enterVoicePanel(): Promise<void> {
    const state = await refreshStatus();
    if (state !== "ready") {
      showAuthorize();
      return;
    }
    showVoice();
    let granted = false;
    try {
      const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
      granted = perm.state === "granted";
    } catch { /* 不支援查詢的瀏覽器：等使用者點一下 */ }
    if (granted && recorder.isSupported) {
      void speak("請說你要點什麼。");
      void loop();
    } else if (recorder.isSupported) {
      setListening(false, "點一下麥克風開始（只有第一次需要）");
    } else {
      setListening(false, "此環境無法錄音——請用下方打字備援");
    }
  }

  const overlay = $("voice-overlay");
  const openBtn = $("open-voice");
  if (overlay && openBtn) {
    // 關閉面板的唯一出口：停止錄音（釋放麥克風）、丟棄未送出內容、
    // 中止倒數、停掉語音合成。✕／背景灰幕／Esc 都走這裡。
    const closePanel = () => {
      overlay.classList.add("hidden");
      document.body.classList.remove("no-scroll");
      pendingParsed = null;
      regretAbort?.();
      pauseLoop("已暫停");
      if (recorder.isRecording) recorder.stop();
      try { speechSynthesis.cancel(); } catch { /* 無合成器 */ }
      clearMsg();
    };
    // foodpanda 式：首頁常駐菜單，按「嘴付下單」才開語音面板
    openBtn.addEventListener("click", () => {
      overlay.classList.remove("hidden");
      document.body.classList.add("no-scroll");
      void enterVoicePanel();
    });
    $("close-voice")?.addEventListener("click", closePanel);
    $("overlay-close")?.addEventListener("click", closePanel);
    // 點背景灰幕關閉（點到面板本身不關）
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePanel();
    });
    // Esc 關閉
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.classList.contains("hidden")) closePanel();
    });
    // 已授權用戶：把額度先撈起來顯示在首頁 chip
    void refreshStatus();
  } else {
    // 傳統版（voice-app）：開頁直接進語音流程
    await enterVoicePanel();
  }
}
