/** Hub 位址解析（雲端部署用）。
 *
 * 優先序：
 * 1. ?hub= 查詢參數（現場救急覆寫）
 * 2. 建置期環境變數 VITE_HUB_URL（Cloudflare Pages 部署走這個）
 * 3. 同站的 /app-config.json（本地 node server 模式）
 * 4. http://localhost:8700（本地開發）
 */

export interface AppRuntimeConfig {
  hubUrl: string;
  merchantId?: string;
}

export async function resolveRuntimeConfig(): Promise<AppRuntimeConfig> {
  const params = new URLSearchParams(location.search);
  const override = params.get("hub");
  const envHub = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_HUB_URL;
  const envMerchant = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MERCHANT_ID;

  if (override) return { hubUrl: override, merchantId: envMerchant };
  if (envHub) return { hubUrl: envHub, merchantId: envMerchant };
  try {
    const resp = await fetch("/app-config.json");
    if (resp.ok) {
      const cfg = await resp.json();
      if (cfg.hub_url) return { hubUrl: cfg.hub_url, merchantId: cfg.merchant_id ?? envMerchant };
    }
  } catch { /* 靜態部署沒有這個端點，走預設 */ }
  return { hubUrl: "http://localhost:8700", merchantId: envMerchant };
}
