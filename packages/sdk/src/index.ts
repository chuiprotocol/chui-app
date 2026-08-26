/** Chui Protocol 店家 SDK。
 *
 * 五分鐘介接：
 *   const chui = init(process.env.CHUI_API_KEY!, { baseUrl: "https://api.example" });
 *   const parsed = await chui.parseOrder({ text: "中冰奶" });
 *   const receipt = await chui.confirmOrder(parsed.order_id);
 */

import { randomUUID } from "node:crypto";
import {
  ChuiError,
  ClarificationNeededError,
  NetworkError,
  RateLimitError,
  SettlementInProgressError,
  errorFromResponse,
} from "./errors.js";
import type {
  ChuiClientOptions,
  OrderStatus,
  ParseInput,
  ParseResult,
  SettlementReceipt,
  WebhookEvent,
} from "./types.js";
import { createWebhookReceiver, type WebhookHandler, type WebhookHeaders } from "./webhook.js";

export * from "./errors.js";
export * from "./types.js";
export * from "./verify.js";
export { createWebhookReceiver, verifyWebhookSignature } from "./webhook.js";
export type { WebhookHandler, WebhookHeaders } from "./webhook.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChuiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private webhookSecret = "";

  constructor(apiKey: string, options: ChuiClientOptions = {}) {
    if (!apiKey || !apiKey.startsWith("chui_sk_")) {
      throw new ChuiError("INVALID_API_KEY", "API key 格式錯誤（應以 chui_sk_ 開頭）", 0);
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * 帶指數退避的請求（2s → 4s → 8s → 16s）。
   * 可重試：網路錯誤、429、5xx、409 SETTLEMENT_IN_PROGRESS。
   * 不可重試：4xx 業務錯誤（澄清、授權不足等）——立刻拋具名錯誤。
   */
  private async request<T>(
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let lastError: ChuiError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(2 ** attempt * 1000);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        ...init.headers,
      };
      let body: BodyInit | undefined;
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.json);
      } else if (init.form) {
        body = init.form;
      }
      let resp: Response;
      try {
        resp = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = new NetworkError(`連線失敗：${(e as Error).message}`);
        continue;
      }
      if (resp.ok) {
        return (await resp.json()) as T;
      }
      const errBody = await resp.json().catch(() => ({}));
      const error = errorFromResponse(resp.status, errBody);
      if (error instanceof RateLimitError || error instanceof SettlementInProgressError || resp.status >= 500) {
        lastError = error;
        continue;
      }
      throw error;
    }
    throw lastError ?? new NetworkError("重試耗盡");
  }

  /**
   * 語音或文字 → 訂單意圖與報價。
   *
   * 信心度不足時拋 ClarificationNeededError：這不是失敗，
   * 把 error.question 唸給使用者聽，拿到回覆後再呼叫一次。
   */
  async parseOrder(input: ParseInput): Promise<ParseResult> {
    const form = new FormData();
    if ("text" in input) {
      form.set("text", input.text);
    } else {
      const filename = input.filename ?? "audio.m4a";
      form.set("audio", new Blob([input.audio as BlobPart]), filename);
    }
    if (input.consumerAddress) form.set("consumer_address", input.consumerAddress);
    return this.request<ParseResult>("POST", "/v1/orders/parse", { form });
  }

  /**
   * 鏈上結算。冪等：同一個 order_id 呼叫 N 次只會扣款一次，
   * 重複呼叫會拿到同一張收據。每次嘗試自動帶新的 nonce 與 timestamp。
   */
  async confirmOrder(orderId: string, options: { mandateId?: string } = {}): Promise<SettlementReceipt> {
    return this.request<SettlementReceipt>("POST", "/v1/orders/confirm", {
      json: { order_id: orderId, mandate_id: options.mandateId ?? null },
      headers: {
        "X-Chui-Nonce": randomUUID(),
        "X-Chui-Timestamp": String(Math.floor(Date.now() / 1000)),
      },
    });
  }

  /** 查詢訂單狀態（含明細密文與 explorer 連結） */
  async getOrder(orderId: string): Promise<OrderStatus> {
    return this.request<OrderStatus>("GET", `/v1/orders/${orderId}`);
  }

  /** 取得覆誦音檔（mp3）。伺服器端已含快取與離線降級。 */
  async getReadbackAudio(orderId: string): Promise<Uint8Array> {
    const resp = await fetch(`${this.baseUrl}/v1/orders/${orderId}/readback.mp3`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      throw errorFromResponse(resp.status, await resp.json().catch(() => ({})));
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** 上傳／更新菜單（品項、價格、選項、同義詞） */
  async updateMenu(menu: Record<string, unknown>): Promise<{ ok: boolean; menu_version: string }> {
    return this.request("PUT", "/v1/merchants/me/menu", { json: menu });
  }

  /** 設定收款地址等店家資訊 */
  async updateMerchant(fields: { payout_address?: string; name?: string }): Promise<{ ok: boolean }> {
    return this.request("PUT", "/v1/merchants/me", { json: fields });
  }

  /** 註冊 webhook。回傳的 secret 用於 onWebhook 驗簽，只會出現一次。 */
  async registerWebhook(url: string): Promise<{ webhook_id: string; secret: string }> {
    const result = await this.request<{ webhook_id: string; url: string; secret: string }>(
      "POST", "/v1/webhooks", { json: { url } },
    );
    this.webhookSecret = result.secret;
    return result;
  }

  /**
   * 掛上 webhook 處理器。回傳 (rawBody, headers) => {status} 的接收器，
   * 接到任何 HTTP 框架都可以。需先呼叫 registerWebhook 或自行提供 secret。
   */
  onWebhook(handler: WebhookHandler, secret?: string) {
    const s = secret ?? this.webhookSecret;
    if (!s) {
      throw new ChuiError(
        "WEBHOOK_SECRET_MISSING",
        "缺少 webhook secret：請先 registerWebhook() 或把 secret 傳進 onWebhook(handler, secret)",
        0,
      );
    }
    return createWebhookReceiver(s, handler);
  }
}

/** 註冊新店家（唯一不需要 API key 的呼叫）。api_key 只會回傳這一次。 */
export async function registerMerchant(
  name: string,
  options: ChuiClientOptions & { payoutAddress?: string } = {},
): Promise<{ merchant_id: string; api_key: string }> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const resp = await fetch(`${baseUrl}/v1/merchants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, payout_address: options.payoutAddress ?? "" }),
  });
  if (!resp.ok) throw errorFromResponse(resp.status, await resp.json().catch(() => ({})));
  return (await resp.json()) as { merchant_id: string; api_key: string };
}

/** 建立 SDK client */
export function init(apiKey: string, options: ChuiClientOptions = {}): ChuiClient {
  return new ChuiClient(apiKey, options);
}

export type { WebhookEvent };
