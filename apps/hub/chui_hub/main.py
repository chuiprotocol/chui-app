"""Chui Hub 主程式。

流程（見 PROTOCOL.md）：
parse（STT＋封閉詞彙重排序，可跨商家路由）→ confirm（轉發商家接單＋回結帳參數）
→ 使用者 Slush 簽名上鏈 → settlement（鏈上驗證事件）→ 通知商家出餐。
每一步都廣播到封包面板（/panel）。
"""

import os
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from . import bus as _bus_module  # noqa: F401  # 先觸發 chui_hub/__init__ 的 sys.path 設定
from chui_api import stt
from chui_api.crypto import new_salt, order_digest
from chui_api.errors import ChuiError, ClarificationNeededError, NotFoundError, ValidationFailedError
from chui_api.menu import quote_items, readback_text

from .bus import bus
from .registry import registry
from .verify import (
    CHUI_FN_SETTLE,
    CHUI_MODULE,
    CHUI_PACKAGE_ID,
    SUI_NETWORK,
    explorer_tx_url,
    verify_settlement,
)

# 1 元（TWD）換多少 USDC 最小單位（6 位小數）。
# 內部測試匯率：1 元 = 0.001538 USDC → 鹽酥雞 32 元 ≈ 0.05 USDC、
# 珍珠奶茶 65 元 ≈ 0.10 USDC（省測試幣）。正式演示可調回 32000。
USDC_UNITS_PER_TWD = int(os.environ.get("USDC_UNITS_PER_TWD", "1538"))
# Sui Testnet 的 USDC coin type（Circle 官方 testnet 發行）
USDC_COIN_TYPE = os.environ.get(
    "CHUI_USDC_COIN_TYPE",
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
)
# 對話 log 端對端加密存證（Seal＋Walrus）。Hub 只發設定，
# 加密／上傳都在用戶瀏覽器完成——平台接觸不到明文與金鑰。
# 預設值＝Mysten 官方 testnet 公開 Seal key server 與 Walrus 節點。
SEAL_KEY_SERVERS = [
    s for s in os.environ.get(
        "SEAL_KEY_SERVERS",
        "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75,"
        "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
    ).split(",") if s.strip()
]
WALRUS_PUBLISHER = os.environ.get(
    "WALRUS_PUBLISHER", "https://publisher.walrus-testnet.walrus.space")
WALRUS_AGGREGATOR = os.environ.get(
    "WALRUS_AGGREGATOR", "https://aggregator.walrus-testnet.walrus.space")

app = FastAPI(title="Chui Hub", description="嘴付協議中樞", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo：商家官網與語音 App 各自的 origin 都要能打
    allow_methods=["*"],
    allow_headers=["*"],
)

# 訂單儲存：MONGODB_URI 有設走 MongoDB Atlas（跨重啟持久化），
# 沒設退回行程記憶體（本地 demo 原行為）。見 store.py。
from . import assist
from .store import OrderStore

store = OrderStore()


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "network": SUI_NETWORK,
        "package_configured": bool(CHUI_PACKAGE_ID),
        "package_id": CHUI_PACKAGE_ID,
        "module": CHUI_MODULE,
        "settle_function": CHUI_FN_SETTLE,
        "usdc_coin_type": USDC_COIN_TYPE,
        "usdc_units_per_twd": USDC_UNITS_PER_TWD,
        "seal_key_servers": SEAL_KEY_SERVERS,
        "walrus_publisher": WALRUS_PUBLISHER,
        "walrus_aggregator": WALRUS_AGGREGATOR,
        "order_store": store.backend,
        "llm_assist": "eastrouter" if assist.enabled() else "off",
        "merchants": [m.merchant_id for m in registry.all()],
    }


@app.get("/v1/merchants")
async def list_merchants():
    return {
        "merchants": [
            {"merchant_id": m.merchant_id, "name": m.name,
             "integration": m.integration, "web_url": m.web_url}
            for m in registry.all()
        ]
    }


@app.get("/v1/merchants/{merchant_id}/menu")
async def merchant_menu(merchant_id: str):
    """協議菜單傳遞：官網（部署在 Pages 上）只需連 Hub 就能拿菜單展示。

    這正是「自家官網只串嘴付協議 API」的具體化——菜單、語音、結帳
    全部走同一個 Hub 端點。取不到時回具名 MENU_UNAVAILABLE。
    """
    merchant = registry.get(merchant_id)
    if merchant is None:
        raise NotFoundError(f"registry 沒有商家 {merchant_id}")
    menu = await merchant.menu()
    return {"merchant_id": merchant_id, "name": merchant.name, "menu": menu}


# ---- ① 解析 ----

@app.post("/v1/orders/parse")
async def parse_order(
    text: str | None = Form(default=None),
    merchant_id: str | None = Form(default=None),
    audio: UploadFile | None = File(default=None),
):
    """語音／文字 → 訂單意圖＋報價。

    未指定 merchant_id 時對所有商家的封閉詞彙各解析一次，
    取信心度最高者路由（語音入口 App 的跨商家能力）。
    """
    source = "voice-app" if not merchant_id else f"web:{merchant_id}"
    if audio is not None:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise ValidationFailedError("音檔是空的")
        bus.emit(source, "hub", "chui.parse.audio", f"語音輸入 {len(audio_bytes)} bytes")
        candidates = await stt.transcribe(audio_bytes, audio.filename or "audio.webm")
        bus.emit("hub", "hub", "stt.result", f"STT：{candidates[0][:40]}")
    elif text:
        candidates = [text]
        bus.emit(source, "hub", "chui.parse.text", f"文字輸入：{text[:40]}")
    else:
        raise ValidationFailedError("需要 text 或 audio 其中之一")

    targets = [registry.get(merchant_id)] if merchant_id else registry.all()
    if merchant_id and targets[0] is None:
        raise NotFoundError(f"registry 沒有商家 {merchant_id}")

    results = []
    for merchant in targets:
        engine = await merchant.engine()
        results.append((merchant, engine.parse(candidates)))
    merchant, result = max(results, key=lambda pair: pair[1].confidence)

    if len(results) > 1:
        ranking = "、".join(f"{m.name} {r.confidence:.2f}" for m, r in
                            sorted(results, key=lambda p: -p[1].confidence))
        bus.emit("hub", "hub", "route.rank", f"跨商家路由：{ranking}")

    if not result.ok:
        # EastRouter 備援：信心不足時請 LLM 把原文重述成「只含菜單詞彙」
        # 的標準句再解析一次。LLM 只做重述——重述句仍要過封閉詞彙解析、
        # 口頭確認與 5 秒防呆倒數，永不直接觸發扣款。
        if assist.enabled():
            menu_names: list[str] = []
            for m in targets:
                menu = await m.menu()
                for it in menu.get("items", []):
                    menu_names.append(it["name"])
                    menu_names.extend(
                        c["name"] for opt in it.get("options", []) for c in opt["choices"]
                    )
            rephrased = await assist.rephrase_order(result.source_text, menu_names)
            if rephrased:
                bus.emit("hub", "hub", "llm.rephrase",
                         f"EastRouter 重述：{rephrased[:40]}")
                retry = []
                for m in targets:
                    engine = await m.engine()
                    retry.append((m, engine.parse([rephrased])))
                m2, r2 = max(retry, key=lambda pair: pair[1].confidence)
                if r2.ok:
                    merchant, result = m2, r2
        if not result.ok:
            bus.emit("hub", source, "chui.clarify", result.clarification_question or "請再說一次")
            raise ClarificationNeededError(
                result.clarification_question or "請再說一次",
                question=result.clarification_question,
                candidates=result.clarification_candidates or [],
                confidence=round(result.confidence, 3),
                stt_text=result.source_text,
            )

    menu = await merchant.menu()
    lines, total = quote_items(menu, result.items)
    readback = readback_text(lines, total)
    salt = new_salt()
    details = {"merchant_id": merchant.merchant_id, "lines": lines,
               "total": total, "created_at": int(time.time())}
    digest_hex = order_digest(details, salt)

    order_id = "ord_" + uuid.uuid4().hex[:12]
    order = {
        "order_id": order_id,
        "merchant_id": merchant.merchant_id,
        "lines": lines,
        "total": total,
        "digest_hex": digest_hex,
        "salt_hex": salt.hex(),
        "amount_units": total * USDC_UNITS_PER_TWD,
        "status": "quoted",
        "readback": readback,
        "created_at": int(time.time()),
        "merchant_ref": "",
        "tx_digest": "",
        "verify_reason": "",
    }
    store.save(order)
    bus.emit("hub", source, "chui.quote",
             f"{merchant.name}：{readback}（信心 {result.confidence:.2f}）",
             {"order_id": order_id, "total": total})
    return {
        "order_id": order_id,
        "merchant_id": merchant.merchant_id,
        "merchant_name": merchant.name,
        "intent": {
            "items": [{"item_id": i.item_id, "name": i.name, "qty": i.qty, "options": i.options}
                      for i in result.items],
            "confidence": round(result.confidence, 3),
            "stt_text": result.source_text,
        },
        "quote": {"lines": lines, "total": total, "currency": "TWD"},
        "readback": {"text": readback},
    }


# ---- ②③ 確認＋轉發商家＋結帳參數 ----

class ConfirmRequest(BaseModel):
    order_id: str


def _get_order(order_id: str) -> dict:
    order = store.get(order_id)
    if order is None:
        hint = "" if store.backend != "memory" else "（記憶體模式：Hub 重啟會清空訂單）"
        raise NotFoundError(f"訂單 {order_id} 不存在{hint}")
    return order


@app.post("/v1/orders/confirm")
async def confirm_order(req: ConfirmRequest):
    order = _get_order(req.order_id)
    merchant = registry.get(order["merchant_id"])
    if not CHUI_PACKAGE_ID:
        _chain_not_configured()

    if order["status"] == "quoted":
        payload = {"order_id": order["order_id"], "lines": order["lines"],
                   "total": order["total"], "currency": "TWD"}
        bus.emit("hub", f"merchant:{merchant.merchant_id}", "chui.order",
                 f"轉發訂單 {order['order_id']}（{order['total']} 元）", payload)
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(f"{merchant.chui_endpoint}/chui/orders", json=payload)
                resp.raise_for_status()
                body = resp.json()
        except Exception as exc:
            bus.emit(f"merchant:{merchant.merchant_id}", "hub", "chui.order.error", str(exc))
            raise MerchantUnreachableError(f"商家接單失敗：{exc}") from exc
        if not body.get("accepted"):
            raise OrderRejectedError(f"商家拒單：{body}")
        order["merchant_ref"] = str(body.get("merchant_ref", ""))
        order["status"] = "confirmed"
        store.save(order)
        bus.emit(f"merchant:{merchant.merchant_id}", "hub", "chui.order.accepted",
                 f"接單成功（單號 {order['merchant_ref']}）")

    checkout = {
        "network": SUI_NETWORK,
        "package_id": CHUI_PACKAGE_ID,
        "module": CHUI_MODULE,
        "function": CHUI_FN_SETTLE,
        "coin_type": USDC_COIN_TYPE,
        "amount_units": order["amount_units"],
        "merchant_address": merchant.payout_address,
        "order_digest_hex": order["digest_hex"],
    }
    bus.emit("hub", "user", "chui.checkout",
             f"結帳參數：{order['amount_units']} USDC 單位 → {merchant.name}", checkout)
    return {"order_id": order["order_id"], "merchant_ref": order["merchant_ref"],
            "checkout": checkout}


class MerchantUnreachableError(ChuiError):
    code = "MERCHANT_UNREACHABLE"
    status_code_default = 502


class OrderRejectedError(ChuiError):
    code = "ORDER_REJECTED"
    status_code_default = 409


def _chain_not_configured():
    from chui_api.errors import ChainNotConfiguredError
    raise ChainNotConfiguredError(
        "CHUI_PACKAGE_ID 未設定：請先執行 chui-contracts/contracts/sui/deploy.sh 並填入 .env。"
    )


# ---- ⑤⑥⑦ 結算回報＋鏈上驗證＋通知商家 ----

class SettlementRequest(BaseModel):
    tx_digest: str


async def _verify_and_notify(order: dict) -> dict:
    merchant = registry.get(order["merchant_id"])
    bus.emit("hub", "sui", "chain.verify",
             f"驗證交易 {order['tx_digest'][:12]}…（查 SettlementEvent）")
    outcome = await verify_settlement(
        order["tx_digest"], order["digest_hex"], order["amount_units"], merchant.payout_address,
    )
    if outcome["verified"]:
        order["status"] = "settled_verified"
        order["verify_reason"] = outcome["reason"]
        bus.emit("sui", "hub", "chain.verified", f"鏈上驗證通過：{outcome['reason']}")
        # ⑦ 通知商家出餐（通知失敗不影響已驗證的結算狀態，但要記錄在面板）
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    f"{merchant.chui_endpoint}/chui/orders/{order['order_id']}/paid",
                    json={"order_id": order["order_id"], "tx_digest": order["tx_digest"],
                          "amount_units": order["amount_units"],
                          "explorer_url": explorer_tx_url(order["tx_digest"])},
                )
            bus.emit("hub", f"merchant:{merchant.merchant_id}", "chui.paid",
                     f"通知出餐：{order['order_id']}")
        except Exception as exc:
            bus.emit("hub", f"merchant:{merchant.merchant_id}", "chui.paid.error",
                     f"通知商家失敗（結算不受影響）：{exc}")
    else:
        order["status"] = "pending_verification"
        order["verify_reason"] = outcome["reason"]
        bus.emit("sui", "hub", "chain.unverified", f"暫未驗證：{outcome['reason']}")
    store.save(order)
    return outcome


@app.post("/v1/orders/{order_id}/settlement")
async def report_settlement(order_id: str, req: SettlementRequest):
    order = _get_order(order_id)
    if order["status"] == "settled_verified":
        # 冪等：已驗證的訂單重複回報直接回同一結果
        return {"order_id": order_id, "status": order["status"],
                "explorer_url": explorer_tx_url(order["tx_digest"])}
    if order["tx_digest"] and order["tx_digest"] != req.tx_digest:
        raise ValidationFailedError("這筆訂單已綁定另一個 tx_digest，拒絕覆寫")
    order["tx_digest"] = req.tx_digest
    order["status"] = "paid_submitted"
    store.save(order)
    bus.emit("user", "hub", "chui.settlement", f"回報交易 {req.tx_digest[:12]}…")
    await _verify_and_notify(order)
    return {"order_id": order_id, "status": order["status"],
            "verify_reason": order["verify_reason"],
            "explorer_url": explorer_tx_url(order["tx_digest"])}


@app.post("/v1/orders/{order_id}/verify")
async def reverify(order_id: str):
    """pending_verification 的訂單手動重試驗證。"""
    order = _get_order(order_id)
    if not order["tx_digest"]:
        raise ValidationFailedError("尚未回報 tx_digest")
    await _verify_and_notify(order)
    return {"order_id": order_id, "status": order["status"],
            "verify_reason": order["verify_reason"],
            "explorer_url": explorer_tx_url(order["tx_digest"])}


@app.get("/v1/orders/{order_id}")
async def get_order(order_id: str):
    order = _get_order(order_id)
    body = dict(order)
    if order["tx_digest"]:
        body["explorer_url"] = explorer_tx_url(order["tx_digest"])
    return body


# ---- 面板 ----

@app.get("/v1/events")
async def events_stream():
    return StreamingResponse(bus.subscribe(), media_type="text/event-stream")


@app.get("/panel")
async def panel():
    html = (Path(__file__).resolve().parent / "panel.html").read_text()
    return HTMLResponse(html)


@app.get("/")
async def root():
    return {"service": "Chui Hub", "panel": "/panel", "spec": "見 repo 的 PROTOCOL.md"}
