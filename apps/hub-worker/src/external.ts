/** 外部服務（TypeScript 移植版）：
 * - STT：OpenAI 相容 Whisper API 轉發（apps/api/chui_api/stt/whisper_api.py）
 * - Atlas Oracle 即時匯率（apps/hub/chui_hub/oracle.py）
 * - 通用 LLM 重述備援（apps/hub/chui_hub/assist.py）
 * 行為約定不變：備援失敗一律靜默退回，絕不擋點餐主流程；
 * LLM 只做重述、永遠碰不到金流決策。
 */

export interface Env {
  HUB_DO: DurableObjectNamespace;
  SUI_NETWORK?: string;
  USDC_UNITS_PER_TWD?: string;
  CHUI_USDC_COIN_TYPE?: string;
  CHUI_PACKAGE_ID?: string;
  CHUI_MODULE?: string;
  CHUI_FN_SETTLE?: string;
  SUI_FULLNODE_URL?: string;
  STT_API_KEY?: string;
  STT_API_BASE?: string;
  STT_API_MODEL?: string;
  SEAL_KEY_SERVERS?: string;
  WALRUS_PUBLISHERS?: string;
  WALRUS_AGGREGATORS?: string;
  ATLAS_ORACLE_BASE_URL?: string;
  ATLAS_ORACLE_API_KEY?: string;
  ATLAS_FEED_ID?: string;
  ATLAS_FEED_MEANING?: string;
  ATLAS_RATE_MULTIPLIER?: string;
  ATLAS_TWD_PER_USD?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_PROVIDER?: string;
  EASTROUTER_BASE_URL?: string;
  EASTROUTER_API_KEY?: string;
  EASTROUTER_MODEL?: string;
}

// ---- STT ----

export class SttUnavailableError extends Error {
  code = "STT_UNAVAILABLE";
  status = 503;
}

/** 語音 → STT 候選文字列表（n-best；至少一個）。失敗明確報錯，絕不假裝聽到。 */
export async function transcribe(env: Env, audio: File): Promise<string[]> {
  if (!env.STT_API_KEY) {
    throw new SttUnavailableError("未設定 STT_API_KEY（雲端 Worker 版沒有本地模型備援）。請改用文字輸入。");
  }
  const base = (env.STT_API_BASE ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const form = new FormData();
  form.set("file", audio, audio.name || "audio.webm");
  form.set("model", env.STT_API_MODEL ?? "whisper-1");
  form.set("language", "zh");
  // 提示模型輸出繁體中文（Whisper 對 initial prompt 敏感）
  form.set("prompt", "以下是台灣的早餐店點餐內容，使用繁體中文。");
  let resp: Response;
  try {
    resp = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new SttUnavailableError(`雲端 STT 連線失敗：${(e as Error).message}。請改用文字輸入。`);
  }
  if (!resp.ok) {
    throw new SttUnavailableError(`雲端 STT 回 ${resp.status}。請改用文字輸入。`);
  }
  const text = String(((await resp.json()) as { text?: string }).text ?? "").trim();
  if (!text) throw new SttUnavailableError("STT 回傳空白結果。請改用文字輸入。");
  return [text];
}

// ---- Atlas Oracle 即時匯率 ----

const oracleCache: { at: number; units: number | null } = { at: 0, units: null };
const ORACLE_CACHE_TTL_MS = 30_000;

export function oracleEnabled(env: Env): boolean {
  return Boolean(env.ATLAS_ORACLE_API_KEY && env.ATLAS_FEED_ID);
}

/** feed 價格 → 1 台幣的 USDC 最小單位（6 位小數）。出口即取整。 */
export function unitsPerTwdFromPrice(
  price: number, meaning: string, multiplier: number, twdPerUsd = 31.5,
): number {
  if (price <= 0) throw new Error(`oracle 價格必須為正：${price}`);
  let units: number;
  if (meaning === "TWD_USD") {
    units = price * 1_000_000;
  } else if (meaning === "USD_TWD") {
    units = 1_000_000 / price;
  } else if (meaning === "USDC_USD") {
    if (twdPerUsd <= 0) throw new Error(`ATLAS_TWD_PER_USD 必須為正：${twdPerUsd}`);
    units = 1_000_000 / twdPerUsd / price;
  } else {
    throw new Error(`未知的 ATLAS_FEED_MEANING：${meaning}`);
  }
  const rounded = Math.round(units * multiplier);
  if (rounded <= 0) throw new Error(`換算後匯率為零（price=${price}, multiplier=${multiplier}）`);
  return rounded;
}

/** Pull API 回應 → 該 feed 的價格（parsedPayload.price ÷ 1e18）。 */
export function parseLatestResponse(body: { data: { parsedPayload: string } }, feedId: string): number {
  const payload = JSON.parse(body.data.parsedPayload) as Array<{ feedId: unknown; price: unknown }>;
  for (const entry of payload) {
    if (String(entry.feedId) === String(feedId)) return Number(entry.price) / 1e18;
  }
  throw new Error(`回應中沒有 feed ${feedId}`);
}

/** 即時匯率（USDC 最小單位/元）；未啟用或失敗 → null（退回固定匯率）。 */
export async function oracleUnitsPerTwd(env: Env): Promise<number | null> {
  if (!oracleEnabled(env)) return null;
  const now = Date.now();
  if (oracleCache.units !== null && now - oracleCache.at < ORACLE_CACHE_TTL_MS) {
    return oracleCache.units;
  }
  try {
    const base = (env.ATLAS_ORACLE_BASE_URL ?? "https://api.atlasoracle.io/report").replace(/\/$/, "");
    const resp = await fetch(`${base}/v1/price/latest`, {
      method: "POST",
      headers: { "X-API-KEY": env.ATLAS_ORACLE_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: [env.ATLAS_FEED_ID], signed: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data: { parsedPayload: string } };
    const price = parseLatestResponse(body, env.ATLAS_FEED_ID!);
    const units = unitsPerTwdFromPrice(
      price,
      (env.ATLAS_FEED_MEANING ?? "TWD_USD").toUpperCase(),
      Number(env.ATLAS_RATE_MULTIPLIER ?? "1.0"),
      Number(env.ATLAS_TWD_PER_USD ?? "31.5"),
    );
    oracleCache.at = now;
    oracleCache.units = units;
    return units;
  } catch {
    return null; // 失敗退回固定匯率——絕不擋點餐主流程
  }
}

/** 回傳（1 元台幣的 USDC 最小單位, 來源）。 */
export async function effectiveUnitsPerTwd(env: Env): Promise<[number, string]> {
  const live = await oracleUnitsPerTwd(env);
  if (live !== null) return [live, "atlas-oracle"];
  const fallback = parseInt(env.USDC_UNITS_PER_TWD ?? "1538", 10);
  return [fallback, oracleEnabled(env) ? "static-env(oracle 失敗退回)" : "static-env"];
}

// ---- 通用 LLM 重述備援 ----

function llmConfig(env: Env): { base: string; key: string; model: string } | null {
  const base = (env.LLM_BASE_URL || env.EASTROUTER_BASE_URL || "").replace(/\/$/, "");
  const key = env.LLM_API_KEY || env.EASTROUTER_API_KEY || "";
  const model = env.LLM_MODEL || env.EASTROUTER_MODEL || "";
  return base && key && model ? { base, key, model } : null;
}

export function assistEnabled(env: Env): boolean {
  return llmConfig(env) !== null;
}

export function assistProvider(env: Env): string {
  return env.LLM_PROVIDER ?? "eastrouter";
}

export function buildPrompt(text: string, menuNames: string[]): string {
  const vocab = menuNames.slice(0, 60).join("、");
  return (
    "你是台灣手搖飲／小吃店的點餐聽寫員。顧客的語音辨識原文可能有" +
    "錯字或口語贅詞。請把它重述成一句「只使用下列菜單詞彙」的標準" +
    "點餐句，保留數量與選項；無法對應菜單就輸出「無法對應」。\n" +
    `菜單詞彙：${vocab}\n` +
    `辨識原文：${text}\n` +
    "只輸出重述句，不要任何解釋。"
  );
}

/** 回傳重述句；未啟用／失敗／模型說無法對應 → null。 */
export async function rephraseOrder(env: Env, text: string, menuNames: string[]): Promise<string | null> {
  const cfg = llmConfig(env);
  if (!cfg || !text.trim()) return null;
  let out = "";
  try {
    const resp = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{ role: "user", content: buildPrompt(text, menuNames) }],
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    out = String(body.choices[0].message.content).trim();
  } catch {
    return null;
  }
  if (!out || out.includes("無法對應") || out === text) return null;
  return out;
}
