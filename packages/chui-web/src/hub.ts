/** Chui Hub 的瀏覽器端 client（協議訊息見 PROTOCOL.md）。 */

export interface QuoteLine {
  item_id: string;
  name: string;
  qty: number;
  options: Record<string, string>;
  option_names: string[];
  unit_price: number;
  line_total: number;
}

export interface ParseResponse {
  order_id: string;
  merchant_id: string;
  merchant_name: string;
  intent: { items: unknown[]; confidence: number; stt_text: string };
  quote: { lines: QuoteLine[]; total: number; currency: "TWD" };
  readback: { text: string };
  /** 這筆訂單鎖定的匯率（顯示 ≈USDC 一律用它；舊版 Hub 沒有此欄位） */
  fx?: { units_per_twd: number; source: string };
}

export interface CheckoutParams {
  network: string;
  package_id: string;
  module: string;
  function: string;
  coin_type: string;
  amount_units: number;
  merchant_address: string;
  order_digest_hex: string;
}

export interface ConfirmResponse {
  order_id: string;
  merchant_ref: string;
  checkout: CheckoutParams;
}

export interface SettlementResponse {
  order_id: string;
  status: "settled_verified" | "pending_verification" | string;
  verify_reason?: string;
  explorer_url: string;
}

/** 信心不足時 Hub 回 422，這個錯誤帶著要唸給使用者聽的澄清問題。
 *  sttText＝Hub 聽到的原文——口頭確認階段（「確認」「取消」）靠它判讀。 */
export class ClarificationNeeded extends Error {
  constructor(public question: string, public candidates: string[], public sttText = "") {
    super(question);
  }
}

export class HubError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function unwrap<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}));
  if (resp.ok) return body as T;
  const detail = (body?.detail ?? body?.error ?? body) as Record<string, unknown>;
  const code = String(detail?.code ?? `HTTP_${resp.status}`);
  const message = String(detail?.message ?? `Hub 錯誤（${resp.status}）`);
  if (code === "CLARIFICATION_NEEDED") {
    throw new ClarificationNeeded(
      String(detail?.question ?? message),
      Array.isArray(detail?.candidates) ? (detail.candidates as string[]) : [],
      String(detail?.stt_text ?? ""),
    );
  }
  throw new HubError(code, message, resp.status);
}

export class HubClient {
  constructor(public baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async merchants(): Promise<{ merchants: { merchant_id: string; name: string; integration: string; web_url: string }[] }> {
    return unwrap(await fetch(`${this.baseUrl}/v1/merchants`));
  }

  /** 文字解析。merchantId 省略時由 Hub 依信心度跨商家路由。 */
  async parseText(text: string, merchantId?: string): Promise<ParseResponse> {
    const form = new FormData();
    form.set("text", text);
    if (merchantId) form.set("merchant_id", merchantId);
    return unwrap(await fetch(`${this.baseUrl}/v1/orders/parse`, { method: "POST", body: form }));
  }

  /** 語音解析（錄音 Blob）。 */
  async parseAudio(audio: Blob, merchantId?: string): Promise<ParseResponse> {
    const form = new FormData();
    form.set("audio", audio, "recording.webm");
    if (merchantId) form.set("merchant_id", merchantId);
    return unwrap(await fetch(`${this.baseUrl}/v1/orders/parse`, { method: "POST", body: form }));
  }

  async confirm(orderId: string): Promise<ConfirmResponse> {
    return unwrap(await fetch(`${this.baseUrl}/v1/orders/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    }));
  }

  async reportSettlement(orderId: string, txDigest: string): Promise<SettlementResponse> {
    return unwrap(await fetch(`${this.baseUrl}/v1/orders/${orderId}/settlement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_digest: txDigest }),
    }));
  }

  async reverify(orderId: string): Promise<SettlementResponse> {
    return unwrap(await fetch(`${this.baseUrl}/v1/orders/${orderId}/verify`, { method: "POST" }));
  }
}
