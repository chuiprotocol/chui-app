"""封閉詞彙重排序（closed-vocabulary reranking）。

絕不直接信任 STT 輸出：把 STT 候選文字與「該店家」菜單的封閉詞彙
（品項、選項、同義詞）做語音距離比對，在封閉範圍內選出最可能的訂單組合。
信心度不足時回傳澄清問題，絕不猜。
"""

from .engine import ParseResult, RerankEngine  # noqa: F401
