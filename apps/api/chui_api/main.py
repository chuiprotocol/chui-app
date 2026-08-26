"""FastAPI 應用組裝。

啟動即檢查：絕不允許 mainnet；webhook 送達 worker 隨 app 起停。
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import chain, config
from .db import init_db
from .webhooks import delivery_worker


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.assert_not_mainnet()
    init_db()
    stop_event = asyncio.Event()
    worker = asyncio.create_task(delivery_worker(stop_event))
    yield
    stop_event.set()
    await worker


app = FastAPI(
    title="Chui Protocol API",
    description="嘴付協議應用層：語音下單、鏈上授權與冪等結算",
    version="0.1.0",
    lifespan=lifespan,
)

# console 開發伺服器與 LIFF 來自不同 origin；cookie 需要 credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from .routes import mandates, merchants, orders  # noqa: E402

app.include_router(merchants.router)
app.include_router(orders.router)
app.include_router(mandates.router)


@app.get("/healthz")
async def healthz():
    """健康檢查：回報網路設定與 chain-service 狀態，供部署驗證。"""
    chain_health = await chain.health()
    return {
        "ok": True,
        "network": config.SUI_NETWORK,
        "chain_service": chain_health,
    }
