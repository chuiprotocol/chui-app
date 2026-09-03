"""封包事件匯流排：demo 面板的即時封包流向靠這裡廣播（SSE）。"""

import asyncio
import json
import time
from collections import deque


class PacketBus:
    def __init__(self, history_size: int = 200):
        self.seq = 0
        self.history: deque = deque(maxlen=history_size)
        self.subscribers: set[asyncio.Queue] = set()

    def emit(self, from_: str, to: str, kind: str, summary: str, payload: dict | None = None):
        """記錄一個協議封包並推給所有面板訂閱者。"""
        self.seq += 1
        event = {
            "seq": self.seq,
            "ts": round(time.time(), 3),
            "from": from_,
            "to": to,
            "kind": kind,
            "summary": summary,
            "payload": payload or {},
        }
        self.history.append(event)
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:  # 面板斷線塞爆就放生，不影響主流程
                pass
        return event

    async def subscribe(self):
        """SSE 訂閱：先補歷史再收新事件。"""
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        for event in self.history:
            queue.put_nowait(event)
        self.subscribers.add(queue)
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            self.subscribers.discard(queue)


bus = PacketBus()
