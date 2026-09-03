"""商家 registry：載入 merchants.json、向商家協議端點抓菜單、建重排序引擎。"""

import json
import os
import time
from pathlib import Path

import httpx

from chui_api.errors import ChuiError
from chui_api.menu import validate_menu
from chui_api.rerank import RerankEngine

from .bus import bus


class MenuUnavailableError(ChuiError):
    """商家菜單取不到（商家服務掛了或菜單格式錯誤）。"""

    code = "MENU_UNAVAILABLE"
    status_code_default = 502

REGISTRY_PATH = Path(os.environ.get(
    "CHUI_REGISTRY_PATH",
    Path(__file__).resolve().parent.parent / "merchants.json",
))
MENU_CACHE_TTL_SECONDS = int(os.environ.get("MENU_CACHE_TTL_SECONDS", "60"))


class MerchantEntry:
    def __init__(self, raw: dict):
        self.merchant_id: str = raw["merchant_id"]
        self.name: str = raw["name"]
        self.integration: str = raw["integration"]  # native | adapter
        self.chui_endpoint: str = raw["chui_endpoint"].rstrip("/")
        self.payout_address: str = raw["payout_address"]
        self.web_url: str = raw.get("web_url", "")
        self._menu: dict | None = None
        self._engine: RerankEngine | None = None
        self._menu_fetched_at: float = 0.0

    async def menu(self) -> dict:
        """向商家的協議端點取菜單（60 秒快取）。

        任何失敗（連不上、格式錯、驗證不過）都轉成具名錯誤，
        絕不以裸 500 冒出；有舊快取時降級沿用並記錄到面板。
        """
        now = time.monotonic()
        if self._menu is not None and now - self._menu_fetched_at < MENU_CACHE_TTL_SECONDS:
            return self._menu
        bus.emit("hub", f"merchant:{self.merchant_id}", "chui.menu.fetch",
                 f"向 {self.name} 取協議菜單")
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chui_endpoint}/chui/menu")
                resp.raise_for_status()
                menu = resp.json()
            validate_menu(menu)
        except Exception as exc:
            bus.emit(f"merchant:{self.merchant_id}", "hub", "chui.menu.error", str(exc)[:120])
            if self._menu is not None:
                # 有舊快取：先用舊菜單撐著，不讓整條點餐路徑掛掉
                self._menu_fetched_at = now
                return self._menu
            raise MenuUnavailableError(f"無法取得 {self.name} 的菜單：{exc}") from exc
        self._menu = menu
        self._engine = RerankEngine(menu)
        self._menu_fetched_at = now
        bus.emit(f"merchant:{self.merchant_id}", "hub", "chui.menu",
                 f"{self.name} 菜單 {len(menu['items'])} 品項（{menu.get('menu_version', '?')}）")
        return menu

    async def engine(self) -> RerankEngine:
        await self.menu()
        assert self._engine is not None
        return self._engine


class Registry:
    def __init__(self):
        raw = json.loads(REGISTRY_PATH.read_text())
        self.merchants: dict[str, MerchantEntry] = {
            m["merchant_id"]: MerchantEntry(m) for m in raw["merchants"]
        }

    def get(self, merchant_id: str) -> MerchantEntry | None:
        return self.merchants.get(merchant_id)

    def all(self) -> list[MerchantEntry]:
        return list(self.merchants.values())


registry = Registry()
