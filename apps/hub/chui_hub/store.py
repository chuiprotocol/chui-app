"""訂單儲存層（Atlas 持久化）。

MONGODB_URI 有設 → 存 MongoDB Atlas：訂單／取餐單號／結算狀態跨重啟
持久化，冪等檢查升級成真正的資料庫層。
沒設 → 退回行程記憶體（本地 demo 原行為，重啟即清空——healthz 會誠實
標示 backend，絕不假裝有持久化）。

設定壞掉（連不上、帳密錯）時啟動直接失敗，不會無聲退回記憶體。
"""

import os


class OrderStore:
    def __init__(self) -> None:
        self._mem: dict[str, dict] = {}
        self._col = None
        uri = os.environ.get("MONGODB_URI", "")
        if uri:
            # 延遲 import：沒用 Atlas 就不需要 pymongo
            from pymongo import MongoClient

            client = MongoClient(uri, serverSelectionTimeoutMS=5000)
            client.admin.command("ping")  # 啟動即驗證，壞設定立刻炸出來
            db_name = os.environ.get("MONGODB_DB", "chui")
            self._col = client[db_name]["orders"]

    @property
    def backend(self) -> str:
        return "mongodb-atlas" if self._col is not None else "memory"

    def save(self, order: dict) -> None:
        """整份 upsert（訂單物件小，覆寫最不易漏欄位）。"""
        if self._col is not None:
            doc = dict(order)
            doc["_id"] = order["order_id"]
            self._col.replace_one({"_id": doc["_id"]}, doc, upsert=True)
        else:
            self._mem[order["order_id"]] = order

    def get(self, order_id: str) -> dict | None:
        if self._col is not None:
            doc = self._col.find_one({"_id": order_id})
            if doc is not None:
                doc.pop("_id", None)
            return doc
        return self._mem.get(order_id)
