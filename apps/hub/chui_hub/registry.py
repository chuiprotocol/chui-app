"""商家 registry：載入 merchants.json、向商家協議端點抓菜單、建重排序引擎。"""

import json
import os
import time
from pathlib import Path

import httpx

from chui_api.menu import validate_menu
from chui_api.rerank import RerankEngine

from .bus import bus

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
        """向商家的協議端點取菜單（60 秒快取）。商家掛掉時明確報錯。"""
        now = time.monotonic()
        if self._menu is not None and now - self._menu_fetched_at < MENU_CACHE_TTL_SECONDS:
            return self._menu
        bus.emit("hub", f"merchant:{self.merchant_id}", "chui.menu.fetch",
                 f"向 {self.name} 取協議菜單")
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{self.chui_endpoint}/chui/menu")
            resp.raise_for_status()
            menu = resp.json()
        validate_menu(menu)
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
