"""STT provider 抽象。

主路徑：OpenAI 相容的 Whisper API（華語）。
備援：本地 faster-whisper（離線可用，需另外安裝）。
兩者都不可用時明確報錯（SttUnavailableError），絕不假裝聽到了什麼。

台語沒有獨立的 STT 路徑：它只透過菜單同義詞＋語音距離在重排序層被救回，
絕不位於關鍵路徑上。
"""

from ..errors import SttUnavailableError
from .. import config


async def transcribe(audio_bytes: bytes, filename: str = "audio.m4a") -> list[str]:
    """語音 → STT 候選文字列表（n-best；至少一個）。

    依 STT_PROVIDER 設定選擇路徑；auto 模式先走雲端 API，失敗時退回本地模型。
    """
    provider = config.STT_PROVIDER
    errors: list[str] = []

    if provider in ("auto", "whisper_api") and config.STT_API_KEY:
        try:
            from .whisper_api import transcribe_via_api

            return await transcribe_via_api(audio_bytes, filename)
        except Exception as exc:  # 雲端失敗 → 記下原因，嘗試本地
            errors.append(f"whisper_api: {exc}")
            if provider == "whisper_api":
                raise SttUnavailableError(
                    f"雲端 STT 失敗且未啟用本地備援：{exc}。請改用文字輸入。"
                ) from exc
    elif provider in ("auto", "whisper_api"):
        errors.append("whisper_api: 未設定 STT_API_KEY")

    if provider in ("auto", "faster_whisper"):
        try:
            from .local_whisper import transcribe_local

            return await transcribe_local(audio_bytes, filename)
        except ImportError:
            errors.append("faster_whisper: 未安裝（pip install faster-whisper）")
        except Exception as exc:
            errors.append(f"faster_whisper: {exc}")

    raise SttUnavailableError(
        "所有語音辨識路徑都不可用（" + "；".join(errors) + "）。請改用文字輸入下單。"
    )
