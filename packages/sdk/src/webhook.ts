/** Webhook 簽章驗證與事件分發。 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types.js";

export interface WebhookHeaders {
  /** X-Chui-Timestamp */
  timestamp: string;
  /** X-Chui-Signature（格式 v1=<hex>） */
  signature: string;
}

/** 驗證 webhook 簽章：v1=HMAC-SHA256(secret, `${timestamp}.${body}`) */
export function verifyWebhookSignature(
  secret: string,
  headers: WebhookHeaders,
  rawBody: string | Uint8Array,
  toleranceSeconds = 300,
): boolean {
  const match = /^v1=([0-9a-f]{64})$/.exec(headers.signature ?? "");
  if (!match) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret)
    .update(`${headers.timestamp}.`)
    .update(body)
    .digest();
  const got = Buffer.from(match[1], "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export type WebhookHandler = (event: WebhookEvent) => void | Promise<void>;

/**
 * 建立 webhook 接收器。回傳的函式吃「原始 body 與 headers」，
 * 驗簽通過才呼叫 handler，並回覆建議的 HTTP 狀態碼。
 *
 * Express 範例：
 *   app.post("/chui-webhook", express.raw({ type: "*∕*" }), async (req, res) => {
 *     const { status } = await receiver(req.body, {
 *       timestamp: req.header("X-Chui-Timestamp") ?? "",
 *       signature: req.header("X-Chui-Signature") ?? "",
 *     });
 *     res.sendStatus(status);
 *   });
 */
export function createWebhookReceiver(secret: string, handler: WebhookHandler) {
  return async (
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
  ): Promise<{ status: number; event?: WebhookEvent }> => {
    if (!verifyWebhookSignature(secret, headers, rawBody)) {
      return { status: 401 };
    }
    const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
    let event: WebhookEvent;
    try {
      event = JSON.parse(text) as WebhookEvent;
    } catch {
      return { status: 400 };
    }
    await handler(event);
    return { status: 200, event };
  };
}
