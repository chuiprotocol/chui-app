# @chui/sdk —— 五分鐘介接 Chui

讓你的店（或你的 bot）聽得懂客人點餐，並且直接在 Sui Testnet 上完成結算。
你不需要懂區塊鏈，也不需要碰語音辨識的細節。

## 0. 前提（30 秒）

- Node.js 18+
- 一個跑起來的 Chui API（見 repo 根目錄 SETUP.md；下例假設在 `http://127.0.0.1:8787`）

## 1. 安裝（30 秒）

```bash
npm install @chui/sdk        # monorepo 內請用 workspace:"@chui/sdk"
```

## 2. 註冊店家、拿 API key（1 分鐘）

```ts
import { registerMerchant } from "@chui/sdk";

const { merchant_id, api_key } = await registerMerchant("快樂豬早餐店", {
  baseUrl: "http://127.0.0.1:8787",
});
// api_key 只會出現這一次，存進你的環境變數
```

## 3. 上傳菜單（1 分鐘）

```ts
import { init } from "@chui/sdk";
import menu from "./menu.json" with { type: "json" };

const chui = init(process.env.CHUI_API_KEY!, { baseUrl: "http://127.0.0.1:8787" });
await chui.updateMenu(menu);
await chui.updateMerchant({ payout_address: "0x你的Sui收款地址" });
```

菜單格式見 `examples/happy-pig/menu.json`：品項、價格（**整數元**）、選項與
同義詞。同義詞寫得越口語（含台語、常見誤聽字），語音辨識救回率越高。

## 4. 解析訂單（1 分鐘）

```ts
import { ClarificationNeededError } from "@chui/sdk";

try {
  const parsed = await chui.parseOrder({
    text: "中冰奶",                       // 或 { audio: bytes, filename: "a.m4a" }
    consumerAddress: "0x消費者地址",       // 結算時要找他的授權
  });
  console.log(parsed.readback.text);      // 「中杯冰奶茶，總共 25 元，確認嗎？」
  console.log(parsed.quote.total);        // 25（整數，元）
} catch (e) {
  if (e instanceof ClarificationNeededError) {
    // 信心度不足：把 e.question 唸給客人聽，拿到回覆後再 parseOrder 一次
    console.log(e.question);
  } else throw e;
}
```

## 5. 確認與結算（1 分鐘）

```ts
const receipt = await chui.confirmOrder(parsed.order_id);
console.log(receipt.tx_digest);      // Sui 交易 digest
console.log(receipt.explorer_url);   // 依網路設定自動產生的 explorer 連結
```

**冪等保證**：`confirmOrder` 對同一個 `order_id` 呼叫幾次都只會扣款一次。
語音介面必然重複觸發——SDK 與伺服器兩層都擋住了。

## Webhook（選用）

```ts
const { secret } = await chui.registerWebhook("https://你的網址/chui-webhook");
const receive = chui.onWebhook(async (event) => {
  if (event.type === "order.settled") console.log("入帳！", event.data);
});
// 在你的 HTTP 框架把「原始 body」與兩個 header 交給 receive
app.post("/chui-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const { status } = await receive(req.body, {
    timestamp: req.header("X-Chui-Timestamp") ?? "",
    signature: req.header("X-Chui-Signature") ?? "",
  });
  res.sendStatus(status);
});
```

## 錯誤處理速查

| 錯誤類別 | 意義 | 建議動作 |
|---|---|---|
| `ClarificationNeededError` | 語音信心不足 | 唸出 `question`，重問 |
| `MandateRequiredError` | 消費者沒有有效授權 | 引導去後台建立授權 |
| `ChainSettlementError` | 鏈上拒絕（看 `moveAbort`，如 `E_OVER_PER_TX`） | 顯示明確原因 |
| `SettlementInProgressError` | 另一個 confirm 在跑 | SDK 已自動重試 |
| `SttUnavailableError` | 語音辨識全掛 | 引導改用文字輸入 |
| `ChainNotConfiguredError` | 鏈上參數未設定 | 找營運方，不是你的錯 |

## 收據驗證（消費者不必信任 Chui）

```ts
import { verifyReceipt } from "@chui/sdk";

const r = await verifyReceipt({
  ciphertextB64, nonceB64,          // 來自 GET /v1/orders/{id}
  keyB64,                            // 消費者持有的 order_key
  saltHex,                           // 來自 GET /v1/orders/{id}
  expectedDigestHex,                 // 鏈上的 digest
});
console.log(r.ok);                   // true = 鏈上 digest 與明細相符
```
