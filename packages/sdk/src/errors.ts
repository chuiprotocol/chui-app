/** 具名錯誤。所有 SDK 錯誤都繼承 ChuiError，可用 instanceof 精確分流。 */

export class ChuiError extends Error {
  /** 機器可讀錯誤碼（與 API 的 error.code 一致） */
  readonly code: string;
  readonly status: number;
  /** API 回傳的完整 detail（可能含額外欄位） */
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, status: number, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** API key 無效或未登入 */
export class AuthenticationError extends ChuiError {}

/** 請求太頻繁（429），SDK 已重試仍失敗 */
export class RateLimitError extends ChuiError {}

/** 語音信心度不足：不要當一般錯誤處理，把 question 唸給使用者聽 */
export class ClarificationNeededError extends ChuiError {
  get question(): string {
    return String(this.detail.question ?? this.message);
  }
  get candidates(): string[] {
    return Array.isArray(this.detail.candidates) ? (this.detail.candidates as string[]) : [];
  }
}

/** 消費者沒有有效的鏈上授權 */
export class MandateRequiredError extends ChuiError {}

/** 鏈上結算被合約拒絕；moveAbort 是合約的具名錯誤（如 E_OVER_PER_TX） */
export class ChainSettlementError extends ChuiError {
  get moveAbort(): string {
    return String(this.detail.move_abort ?? "");
  }
}

/** 鏈上參數尚未設定（部署未完成），不是店家的問題 */
export class ChainNotConfiguredError extends ChuiError {}

/** nonce/timestamp 驗證失敗（時鐘漂移或重放） */
export class ReplayError extends ChuiError {}

/** 找不到資源 */
export class NotFoundError extends ChuiError {}

/** 結算正在進行中（同一筆訂單的另一個 confirm 還在跑）；SDK 會自動重試 */
export class SettlementInProgressError extends ChuiError {}

/** 語音辨識不可用（請改用文字輸入） */
export class SttUnavailableError extends ChuiError {}

/** 其他驗證錯誤 */
export class ValidationError extends ChuiError {}

/** 網路層錯誤（重試耗盡） */
export class NetworkError extends ChuiError {
  constructor(message: string) {
    super("NETWORK_ERROR", message, 0);
  }
}

const CODE_MAP: Record<string, new (code: string, message: string, status: number, detail: Record<string, unknown>) => ChuiError> = {
  AUTH_REQUIRED: AuthenticationError,
  FORBIDDEN: AuthenticationError,
  RATE_LIMITED: RateLimitError,
  CLARIFICATION_NEEDED: ClarificationNeededError,
  MANDATE_REQUIRED: MandateRequiredError,
  CHAIN_SETTLEMENT_FAILED: ChainSettlementError,
  CHAIN_NOT_CONFIGURED: ChainNotConfiguredError,
  REPLAY_REJECTED: ReplayError,
  NOT_FOUND: NotFoundError,
  SETTLEMENT_IN_PROGRESS: SettlementInProgressError,
  STT_UNAVAILABLE: SttUnavailableError,
  VALIDATION_FAILED: ValidationError,
};

/** 把 API 錯誤回應轉成對應的具名錯誤 */
export function errorFromResponse(status: number, body: unknown): ChuiError {
  const detail = (body && typeof body === "object" && "detail" in body
    ? (body as { detail: unknown }).detail
    : body) as Record<string, unknown> | null;
  const code = String(detail?.code ?? `HTTP_${status}`);
  const message = String(detail?.message ?? `API 錯誤（HTTP ${status}）`);
  const cls = CODE_MAP[code] ?? ChuiError;
  return new cls(code, message, status, detail ?? {});
}
