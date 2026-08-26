// 快樂豬 LIFF 前端：綁定地址 → 錄音點餐 → 聽覆誦 → 確認 → 收據。
// 訂單解密金鑰（order_key）只存 IndexedDB——絕不使用 localStorage。

const CONSOLE_URL = new URLSearchParams(location.search).get("console") || "http://localhost:5173";
const LIFF_ID = new URLSearchParams(location.search).get("liffId") || "";

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

function message(kind, text) {
  $("msg").innerHTML = `<div class="${kind}">${text}</div>`;
}

// ---- IndexedDB 迷你封裝 ----
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("chui-liff", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- LINE 身分：LIFF 內用真實 userId；瀏覽器測試時用固定的本機代號 ----
let lineUserId = "";
async function initIdentity() {
  if (LIFF_ID && window.liff) {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) liff.login();
    const profile = await liff.getProfile();
    lineUserId = profile.userId;
  } else {
    let stored = await idbGet("dev-user-id");
    if (!stored) {
      stored = "dev-" + crypto.randomUUID();
      await idbSet("dev-user-id", stored);
    }
    lineUserId = stored;
  }
}

// ---- 綁定 ----
async function setupBind() {
  $("console-link").href = CONSOLE_URL;
  const bound = await idbGet("bound-address");
  if (bound) {
    hide("bind-card");
    show("order-card");
    return;
  }
  $("bind-btn").onclick = async () => {
    const address = $("address-input").value.trim();
    if (!/^0x[0-9a-fA-F]{2,}$/.test(address)) {
      message("error", "地址格式不對（應以 0x 開頭）");
      return;
    }
    const resp = await fetch("/liff/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineUserId, suiAddress: address }),
    });
    if (!resp.ok) {
      message("error", (await resp.json()).message || "綁定失敗");
      return;
    }
    await idbSet("bound-address", address);
    message("ok", "綁定完成！記得在後台建立付款授權，然後就可以點餐了。");
    hide("bind-card");
    show("order-card");
  };
}

// ---- 錄音（按住說話）----
let mediaRecorder = null;
let chunks = [];
let currentOrder = null;

function setupRecording() {
  const btn = $("record-btn");
  const start = async (e) => {
    e.preventDefault();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorder.ondataavailable = (ev) => chunks.push(ev.data);
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await submitAudio(new Blob(chunks, { type: "audio/webm" }));
      };
      mediaRecorder.start();
      btn.classList.add("recording");
      btn.textContent = "🔴 放開送出";
    } catch (err) {
      message("error", "無法使用麥克風：" + err.message);
    }
  };
  const stop = (e) => {
    e.preventDefault();
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      btn.classList.remove("recording");
      btn.textContent = "🎙️ 按住說話";
    }
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("touchstart", start);
  btn.addEventListener("mouseup", stop);
  btn.addEventListener("mouseleave", stop);
  btn.addEventListener("touchend", stop);
}

async function submitAudio(blob) {
  message("ok", "辨識中…");
  const resp = await fetch("/liff/order", {
    method: "POST",
    headers: { "Content-Type": "audio/webm", "X-Line-User-Id": lineUserId },
    body: blob,
  });
  const body = await resp.json();
  if (!resp.ok) {
    if (body.question) {
      // 澄清問題：唸出來、顯示出來，等使用者再說一次
      message("error", body.question);
      speak(body.question);
    } else {
      message("error", body.message || "點餐失敗");
    }
    return;
  }
  currentOrder = body;
  // 訂單解密金鑰屬於消費者：存進使用者自己的 IndexedDB
  await idbSet(`order-key:${body.order_id}`, body.order_key);
  $("readback-text").textContent = body.readback;
  $("readback-audio").src = `/liff/readback/${body.order_id}.mp3`;
  $("msg").innerHTML = "";
  show("confirm-card");
}

// TTS 不可用時的最後保險：瀏覽器內建語音（僅用於澄清問題朗讀）
function speak(text) {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-TW";
    speechSynthesis.speak(utterance);
  } catch { /* 靜默略過：文字已顯示在畫面上 */ }
}

// ---- 確認與收據 ----
function setupConfirm() {
  $("confirm-btn").onclick = async () => {
    if (!currentOrder) return;
    message("ok", "結算中（Sui Testnet）…");
    const resp = await fetch("/liff/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: currentOrder.order_id }),
    });
    const body = await resp.json();
    if (!resp.ok) {
      const reason = body.move_abort === "E_OVER_PER_TX" ? "超過單筆授權上限（E_OVER_PER_TX）"
        : body.move_abort === "E_REVOKED" ? "授權已撤銷（E_REVOKED）"
        : body.message;
      message("error", `付款沒有成功：${reason}`);
      return;
    }
    hide("confirm-card");
    $("msg").innerHTML = "";
    $("receipt-body").innerHTML = `
      <p>金額：<b>${body.amount} 元</b>（Testnet 測試幣）</p>
      <p><a href="${body.explorer_url}" target="_blank" rel="noreferrer">在 Sui explorer 查看交易 ↗</a></p>
      <p class="hint">鏈上 digest：<code>${body.digest}</code></p>
      <p class="hint">明細解密金鑰已存在你的手機裡（IndexedDB）。用 scripts/verify.ts 可證明鏈上雜湊與明細相符。</p>`;
    show("receipt-card");
    currentOrder = null;
  };
  $("cancel-btn").onclick = () => {
    currentOrder = null;
    hide("confirm-card");
    message("ok", "已取消。想吃什麼再跟我說！");
  };
}

// ---- 啟動 ----
(async () => {
  try {
    await initIdentity();
    await setupBind();
    setupRecording();
    setupConfirm();
  } catch (e) {
    message("error", "初始化失敗：" + e.message);
  }
})();
