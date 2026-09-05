/** Hub 位址解析（雲端部署用）。
 *
 * 優先序：
 * 1. ?hub= 查詢參數——「活著」才記住（IndexedDB），之後直接開網址就好；
 *    隧道網址換了只要重新帶一次 ?hub=。
 * 2. 上次記住的 hub 網址——每次開頁都會先探測，死掉（trycloudflare
 *    隧道網址每次重跑都會變）就自動忘掉、往下一層 fallback 走，
 *    不會卡在舊網址上一直 Failed to fetch。
 * 3. 建置期環境變數 VITE_HUB_URL（Cloudflare Pages 部署走這個）
 * 4. 同站的 /app-config.json（本地 node server 模式）
 * 5. 正式固定網址 https://hub.chuiprotocol.com（Named Tunnel；活著才用）
 *    ——手機直接開 pages.dev 就能用，不需要帶 ?hub=
 * 6. http://localhost:8700（本地開發）
 */

import { idbGet, idbSet, idbDelete } from "./idb.js";

const HUB_STORAGE = "chui.hub-url";
const PROBE_TIMEOUT_MS = 6000;
// 正式固定網址（Cloudflare Named Tunnel → 用戶 Mac 上的 Hub）。
// 只在「探測活著」時採用，掛了照樣往下層 fallback——不會卡死任何流程。
const PUBLIC_HUB_URL = "https://hub.chuiprotocol.com";

export interface AppRuntimeConfig {
  hubUrl: string;
  merchantId?: string;
}

/** hub 網址必須是絕對 http(s)——否則 fetch 會變相對路徑打到自己網站，
 *  拿回 200 的 HTML 被誤判成活著（實例：?hub=Binary）。 */
export function looksLikeHubUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url);
}

/** 探測 hub 是否活著（healthz 必須回 JSON 且 ok=true，6 秒逾時）。 */
export async function hubAlive(url: string): Promise<boolean> {
  if (!looksLikeHubUrl(url)) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const resp = await fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const body = await resp.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** 連不上 Hub 時的統一說明（比「Failed to fetch」有用）。 */
export function hubDownMessage(hubUrl: string): string {
  return `連不上 Chui Hub（${hubUrl}）。` +
    "隧道網址每次重跑都會變——請在電腦上重跑 ./scripts/go-live.sh，" +
    "然後用它印出的「最新網址」（帶 ?hub=）重新開啟本頁。";
}

export async function resolveRuntimeConfig(): Promise<AppRuntimeConfig> {
  const params = new URLSearchParams(location.search);
  const override = params.get("hub");
  const envHub = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_HUB_URL;
  const envMerchant = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MERCHANT_ID;

  if (override && looksLikeHubUrl(override)) {
    // 活著才記住：避免把打錯／過期的網址存起來害之後每次開頁都壞
    if (await hubAlive(override)) {
      await idbSet(HUB_STORAGE, override).catch(() => undefined);
    }
    return { hubUrl: override, merchantId: envMerchant };
  }
  // 不像網址的 ?hub=（如 ?hub=Binary）直接忽略，走下層 fallback
  const remembered = await idbGet<string>(HUB_STORAGE).catch(() => undefined);
  if (remembered) {
    if (await hubAlive(remembered)) {
      return { hubUrl: remembered, merchantId: envMerchant };
    }
    // 舊隧道死了：忘掉它，往下層 fallback 走
    await idbDelete(HUB_STORAGE).catch(() => undefined);
  }
  if (envHub) return { hubUrl: envHub, merchantId: envMerchant };
  try {
    const resp = await fetch("/app-config.json");
    if (resp.ok) {
      const cfg = await resp.json();
      if (cfg.hub_url) return { hubUrl: cfg.hub_url, merchantId: cfg.merchant_id ?? envMerchant };
    }
  } catch { /* 靜態部署沒有這個端點，走預設 */ }
  if (await hubAlive(PUBLIC_HUB_URL)) {
    return { hubUrl: PUBLIC_HUB_URL, merchantId: envMerchant };
  }
  return { hubUrl: "http://localhost:8700", merchantId: envMerchant };
}
