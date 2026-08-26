/** 完整型別定義。金額一律是整數（新台幣元），絕無浮點數。 */

export interface OrderItem {
  item_id: string;
  name: string;
  qty: number;
  /** option_id → choice_id */
  options: Record<string, string>;
}

export interface OrderIntent {
  items: OrderItem[];
  /** 0～1，重排序後的信心度 */
  confidence: number;
  /** 重排序採用的 STT 文字 */
  stt_text: string;
}

export interface QuoteLine {
  item_id: string;
  name: string;
  qty: number;
  options: Record<string, string>;
  option_names: string[];
  /** 單價（元，整數） */
  unit_price: number;
  /** 小計（元，整數） */
  line_total: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** 總金額（元，整數） */
  total: number;
  currency: "TWD";
}

export interface ParseResult {
  order_id: string;
  intent: OrderIntent;
  quote: Quote;
  readback: {
    /** 覆誦文字：「中杯冰奶茶，總共 25 元，確認嗎？」 */
    text: string;
    fragments: string[];
  };
  /**
   * 訂單明細的解密金鑰（base64）。伺服器不留存——請轉交消費者保存。
   * 店家端不應長期儲存這把金鑰。
   */
  order_key: string;
  /** 上鏈的 salted digest（hex） */
  digest: string;
}

export interface SettlementReceipt {
  order_id: string;
  status: "settled";
  /** 結算金額（元，整數） */
  amount: number;
  currency: "TWD";
  /** Sui 交易 digest */
  tx_digest: string;
  /** 依網路設定自動產生的 explorer 連結 */
  explorer_url: string;
  /** 訂單明細的 salted digest（鏈上唯一可見的訂單資訊） */
  digest: string;
  settled_at: number;
  network: string;
}

export interface OrderStatus {
  order_id: string;
  status: "quoted" | "settling" | "settled" | "failed";
  total: number;
  currency: "TWD";
  digest: string;
  salt: string;
  details_ciphertext: string;
  details_nonce: string;
  readback_text: string;
  fail_code: string;
  created_at: number;
  tx_digest?: string;
  explorer_url?: string;
}

export interface WebhookEvent {
  type: "order.settled" | "order.failed";
  created_at: number;
  data: Record<string, unknown>;
}

export interface ChuiClientOptions {
  /** API 伺服器位址，預設 http://127.0.0.1:8787 */
  baseUrl?: string;
  /** 重試次數上限（指數退避），預設 4 */
  maxRetries?: number;
  /** 單次請求逾時（毫秒），預設 30000 */
  timeoutMs?: number;
}

export type ParseInput =
  | { text: string; consumerAddress?: string }
  | { audio: Uint8Array; filename?: string; consumerAddress?: string };
