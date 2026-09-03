# Chui Protocol 規格 v0.2（demo 版）

Chui（嘴付協議）是「語音下單並結帳」的協議層。本文件定義 demo 所需的
全部訊息格式。目標：**異質商家都能接上協議，使用者端體驗一致**。

```
使用者(語音)                Chui Hub                     商家
    │  ① parse(語音/文字) ──▶ │                            │
    │ ◀── OrderIntent+Quote ─ │ ←(菜單快取自 /chui/menu)── │
    │  ② confirm ───────────▶ │ ── ③ POST /chui/orders ──▶ │（原生或經 adapter）
    │ ◀── CheckoutParams ──── │ ◀── accepted+ref ───────── │
    │  ④ Slush 簽名 settle()  →→→  Sui Testnet（USDC）      │
    │  ⑤ settlement(tx) ────▶ │ ── ⑥ 鏈上驗證事件 ──▶ Sui   │
    │ ◀── verified ────────── │ ── ⑦ 通知已付款 ─────────▶ │
```

## 角色

- **Chui Hub**：協議中樞。維護商家 registry、做 STT＋封閉詞彙重排序、
  依 merchant_id 轉發、提供結帳參數、驗證鏈上結算事件、廣播封包流向。
- **商家（原生）**：直接實作「商家端協議介面」（公版店面 template 內建）。
- **商家（adapter）**：既有系統維持原樣，由 adapter 把協議訊息翻譯成
  自家格式（快樂鹽酥雞示範）。

## 通用約定

- 金額一律**整數**。菜單價格單位＝新台幣元；鏈上金額單位＝USDC 最小單位
  （6 位小數）。換算：`amount_units = total_twd × USDC_UNITS_PER_TWD`（Hub 設定）。
- 所有訊息 JSON、UTF-8。錯誤格式：`{"error": {"code", "message"}}`。
- `order_digest = SHA-256(canonical_json(明細) ‖ salt)`，salt 為每單全新
  32 bytes CSPRNG；鏈上只出現 digest。

## 商家端協議介面（商家或其 adapter 必須提供）

### GET /chui/menu
回傳協議菜單格式（與 `examples/happy-pig/menu.json` 同構）：

```json
{
  "menu_version": "2026-09-03",
  "currency": "TWD",
  "items": [{
    "id": "fried-chicken", "name": "鹽酥雞", "base_price": 65,
    "synonyms": ["鹹酥雞", "鹽酥機"],
    "options": [{
      "id": "spicy", "name": "辣度", "required": false, "default": "NO",
      "choices": [{"id": "NO", "name": "不辣", "synonyms": [], "price_delta": 0},
                   {"id": "YES", "name": "加辣", "synonyms": ["要辣", "辣的"], "price_delta": 0}]
    }]
  }]
}
```

### POST /chui/orders
Hub 在使用者確認後把訂單交給商家。

```json
{
  "order_id": "ord_xxx",
  "lines": [{"item_id": "fried-chicken", "name": "鹽酥雞", "qty": 1,
              "options": {"spicy": "YES"}, "option_names": ["加辣"],
              "unit_price": 65, "line_total": 65}],
  "total": 65, "currency": "TWD"
}
```

回應：`{"accepted": true, "merchant_ref": "商家自己的單號"}`
（adapter 情境：merchant_ref 是翻譯後在舊系統建立的 ticket 編號。）

### POST /chui/orders/{order_id}/paid
鏈上驗證通過後 Hub 通知商家出餐：

```json
{"order_id": "ord_xxx", "tx_digest": "…", "amount_units": 2080000,
 "explorer_url": "https://suiscan.xyz/testnet/tx/…"}
```

回應：`{"ok": true}`

## Hub 介面（語音 App／商家官網呼叫）

### GET /v1/merchants
`{"merchants": [{"merchant_id", "name", "integration": "native|adapter", "web_url"}]}`

### POST /v1/orders/parse
multipart：`text`（或 `audio` 檔案）＋可選 `merchant_id`。
**省略 merchant_id 時，Hub 對所有商家的封閉詞彙各解析一次，
取信心度最高者路由**（語音入口 App 的「一段語音對多家下單」靠這個）。

成功 200：

```json
{"order_id": "ord_xxx", "merchant_id": "happy-chicken", "merchant_name": "快樂鹽酥雞",
 "intent": {"items": [...], "confidence": 0.93, "stt_text": "我要一份鹽酥雞加辣"},
 "quote": {"lines": [...], "total": 65, "currency": "TWD"},
 "readback": {"text": "加辣鹽酥雞，總共 65 元，確認嗎？"}}
```

信心不足 422：`{"error": {"code": "CLARIFICATION_NEEDED", "question": "…", "candidates": [...]}}`
——**協議規定：不確定就必須問，絕不猜。**

### POST /v1/orders/confirm
`{"order_id": "ord_xxx"}` → Hub 轉發 `/chui/orders` 給商家，成功後回結帳參數：

```json
{"order_id": "ord_xxx", "merchant_ref": "…",
 "checkout": {
   "network": "testnet",
   "package_id": "0x…", "module": "pay", "function": "settle",
   "coin_type": "0x…::usdc::USDC",
   "amount_units": 2080000,
   "merchant_address": "0x…",
   "order_digest_hex": "64 個 hex 字元"
 }}
```

錢包端組 PTB：`settle<coin_type>(coinWithBalance(amount_units), merchant_address, digest_bytes)`。

### POST /v1/orders/{order_id}/settlement
`{"tx_digest": "…"}` → Hub 記錄並向 fullnode 驗證 `SettlementEvent`
（digest、amount、merchant 三者皆符）。回應：

```json
{"order_id": "…", "status": "settled_verified" | "pending_verification",
 "explorer_url": "https://suiscan.xyz/testnet/tx/…"}
```

`pending_verification`＝交易已提交但 Hub 還連不上／查不到事件；
可對 `POST /v1/orders/{id}/verify` 重試。**Hub 絕不憑空標記已付款。**

### GET /v1/orders/{order_id}
訂單目前狀態（quoted → confirmed → paid_submitted → settled_verified / pending_verification）。

### GET /v1/events（SSE）
封包流向即時串流，`GET /panel` 是內建的視覺化面板。事件格式：

```json
{"seq": 12, "ts": 1789…, "from": "hub", "to": "merchant:happy-chicken",
 "kind": "chui.order", "summary": "轉發訂單 ord_xx（65 元）", "payload": {…}}
```

## Registry（Hub 設定 merchants.json）

```json
{"merchants": [
  {"merchant_id": "happy-chicken", "name": "快樂鹽酥雞", "integration": "adapter",
   "chui_endpoint": "http://127.0.0.1:9101", "payout_address": "0x…",
   "web_url": "http://localhost:9102"},
  {"merchant_id": "goodtea", "name": "好喝奶茶店", "integration": "native",
   "chui_endpoint": "http://127.0.0.1:9201", "payout_address": "0x…",
   "web_url": "http://localhost:9202"}
]}
```

## 明確不在 demo 範圍

真金流、登入系統、退款、Mandate 預授權（合約 `chui::pay` 為每筆錢包簽名模型）。
