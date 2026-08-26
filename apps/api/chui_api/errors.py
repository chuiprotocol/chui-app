"""具名錯誤。所有 API 錯誤回應統一格式：{"error": {"code": ..., "message": ...}}。"""

from fastapi import HTTPException


class ChuiError(HTTPException):
    """帶有機器可讀 code 的 API 錯誤基底。"""

    code = "CHUI_ERROR"
    status_code_default = 400

    def __init__(self, message: str, status_code: int | None = None, **extra):
        detail = {"code": self.code, "message": message}
        if extra:
            detail.update(extra)
        super().__init__(status_code=status_code or self.status_code_default, detail=detail)


class AuthError(ChuiError):
    code = "AUTH_REQUIRED"
    status_code_default = 401


class ForbiddenError(ChuiError):
    code = "FORBIDDEN"
    status_code_default = 403


class NotFoundError(ChuiError):
    code = "NOT_FOUND"
    status_code_default = 404


class RateLimitedError(ChuiError):
    code = "RATE_LIMITED"
    status_code_default = 429


class ValidationFailedError(ChuiError):
    code = "VALIDATION_FAILED"
    status_code_default = 422


class ReplayError(ChuiError):
    """nonce 重複使用或 timestamp 過期。"""

    code = "REPLAY_REJECTED"
    status_code_default = 401


class ChainNotConfiguredError(ChuiError):
    """鏈上參數（package ID / shared object）未設定。明確報錯，絕不假裝成功。"""

    code = "CHAIN_NOT_CONFIGURED"
    status_code_default = 503


class ChainError(ChuiError):
    """鏈上結算失敗。move_abort 欄位帶回合約的具名錯誤（如 E_OVER_PER_TX）。"""

    code = "CHAIN_SETTLEMENT_FAILED"
    status_code_default = 502


class SettlementInProgressError(ChuiError):
    """同一筆訂單的結算正在進行中；呼叫端應稍後重試同一個 confirm。"""

    code = "SETTLEMENT_IN_PROGRESS"
    status_code_default = 409


class OrderStateError(ChuiError):
    code = "ORDER_STATE_INVALID"
    status_code_default = 409


class SttUnavailableError(ChuiError):
    """所有 STT 路徑都不可用。明確報錯並引導改用文字輸入，絕不無聲猜測。"""

    code = "STT_UNAVAILABLE"
    status_code_default = 503


class ClarificationNeededError(ChuiError):
    """信心度不足：不是錯誤路徑的錯誤，而是要求前端向使用者提出澄清問題。

    detail 內含 question（要問使用者的話）與 candidates（供按鈕快速選擇）。
    """

    code = "CLARIFICATION_NEEDED"
    status_code_default = 422
