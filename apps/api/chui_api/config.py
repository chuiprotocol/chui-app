"""集中設定。所有可調參數一律走環境變數，切換網路只改設定不改程式碼。"""

import os
from pathlib import Path

# ---- 網路設定（絕對不可硬編 mainnet）----
SUI_NETWORK = os.environ.get("SUI_NETWORK", "testnet")

# 各網路對應的 explorer 網址樣板；連結一律依 SUI_NETWORK 自動產生
_EXPLORER_TX_TEMPLATES = {
    "testnet": "https://suiscan.xyz/testnet/tx/{digest}",
    "devnet": "https://suiscan.xyz/devnet/tx/{digest}",
    "mainnet": "https://suiscan.xyz/mainnet/tx/{digest}",
}
_EXPLORER_OBJECT_TEMPLATES = {
    "testnet": "https://suiscan.xyz/testnet/object/{object_id}",
    "devnet": "https://suiscan.xyz/devnet/object/{object_id}",
    "mainnet": "https://suiscan.xyz/mainnet/object/{object_id}",
}


def explorer_tx_url(digest: str) -> str:
    """依目前網路設定產生交易的 explorer 連結。"""
    return _EXPLORER_TX_TEMPLATES[SUI_NETWORK].format(digest=digest)


def explorer_object_url(object_id: str) -> str:
    """依目前網路設定產生物件的 explorer 連結。"""
    return _EXPLORER_OBJECT_TEMPLATES[SUI_NETWORK].format(object_id=object_id)


# ---- 資料庫 ----
DATABASE_URL = os.environ.get("CHUI_DATABASE_URL", "sqlite:///./chui.db")

# ---- 鏈上服務 sidecar（Node，走 localhost 內部呼叫）----
CHAIN_SERVICE_URL = os.environ.get("CHAIN_SERVICE_URL", "http://127.0.0.1:8788")
CHAIN_SERVICE_TOKEN = os.environ.get("CHAIN_SERVICE_TOKEN", "")

# ---- STT ----
# 主路徑：OpenAI 相容的 Whisper API（華語）。備援：本地 faster-whisper（離線）。
STT_PROVIDER = os.environ.get("STT_PROVIDER", "auto")  # auto | whisper_api | faster_whisper
STT_API_BASE = os.environ.get("STT_API_BASE", "https://api.openai.com/v1")
STT_API_KEY = os.environ.get("STT_API_KEY", "")
STT_API_MODEL = os.environ.get("STT_API_MODEL", "whisper-1")

# ---- TTS ----
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "")
ELEVENLABS_MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")
ELEVENLABS_TIMEOUT_SECONDS = float(os.environ.get("ELEVENLABS_TIMEOUT_SECONDS", "3.0"))
EDGE_TTS_VOICE = os.environ.get("EDGE_TTS_VOICE", "zh-TW-HsiaoChenNeural")
TTS_CACHE_DIR = Path(os.environ.get("TTS_CACHE_DIR", "./tts_cache"))

# ---- 重排序 ----
# 信心度低於此閾值時必須提出澄清問題，絕對不猜
RERANK_CONFIDENCE_THRESHOLD = float(os.environ.get("RERANK_CONFIDENCE_THRESHOLD", "0.62"))
# 前兩名分數差距小於此值視為模糊，也要澄清
RERANK_AMBIGUITY_MARGIN = float(os.environ.get("RERANK_AMBIGUITY_MARGIN", "0.08"))

# ---- zkLogin salt 服務 ----
# 消費者的 zkLogin salt 由 HMAC(master secret, iss|aud|sub) 決定性導出。
# 這代表 Chui 營運方是 salt 保管者（信任假設，見 README）。
ZKLOGIN_SALT_MASTER_SECRET = os.environ.get("ZKLOGIN_SALT_MASTER_SECRET", "")
# 允許的 OAuth audience（Google client ID），逗號分隔
ZKLOGIN_ALLOWED_AUDIENCES = [
    a.strip() for a in os.environ.get("ZKLOGIN_ALLOWED_AUDIENCES", "").split(",") if a.strip()
]

# ---- 安全 ----
# consumer session cookie 的簽章金鑰（32 bytes hex；未設定時啟動報錯，不偷偷產生）
SESSION_SECRET = os.environ.get("CHUI_SESSION_SECRET", "")
# confirm 請求的 timestamp 容許誤差（秒）
TIMESTAMP_TOLERANCE_SECONDS = int(os.environ.get("TIMESTAMP_TOLERANCE_SECONDS", "300"))

# ---- Rate limit（單機記憶體實作；多實例部署需換 Redis，見 DECISIONS.md）----
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "120"))
RATE_LIMIT_PARSE_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PARSE_PER_MINUTE", "30"))

# ---- CORS（console 與 LIFF 的 origin，逗號分隔）----
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]

# ---- Webhook ----
WEBHOOK_MAX_RETRIES = int(os.environ.get("WEBHOOK_MAX_RETRIES", "5"))
WEBHOOK_TIMEOUT_SECONDS = float(os.environ.get("WEBHOOK_TIMEOUT_SECONDS", "5.0"))


def assert_not_mainnet() -> None:
    """防呆：現階段禁止連 mainnet。要上 mainnet 時由人工拿掉這道防線。"""
    if SUI_NETWORK == "mainnet":
        raise RuntimeError(
            "SUI_NETWORK=mainnet 目前被明確封鎖：本專案現階段只允許 testnet/devnet。"
        )
