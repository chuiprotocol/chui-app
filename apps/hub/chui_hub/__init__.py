"""Chui Hub：協議中樞。

統一入口，維護商家 registry，依 merchant_id 轉發請求，
提供 USDC on Sui Testnet 的結帳參數並驗證鏈上結算事件。
重排序／STT／digest 邏輯直接重用 apps/api 的 chui_api 模組。
"""

import sys
from pathlib import Path

# 重用 apps/api 的核心模組（monorepo 內部相依）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "api"))
