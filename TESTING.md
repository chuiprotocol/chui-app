# TESTING.md —— 拿著手機照著做

前提：`SETUP.md` 全部完成、四個行程都在跑、`CHUI_PACKAGE_ID` 已填
（合約 repo 補上後）。**全程 Sui Testnet 測試幣，無真實資金。**

每個測試附「預期結果」與「失敗排查」。任何一步的失敗訊息都應該是
明確的具名錯誤——看到「假裝成功」就是 bug，請回報。

---

## A. 店家上線（目標：5 分鐘內，全程只用 SDK）

拿一台電腦，計時開始：

1. `node` 開 REPL 或建一個 `onboard.mjs`：
   ```js
   import { registerMerchant, init } from "@chui/sdk";
   import fs from "node:fs";
   const { merchant_id, api_key } = await registerMerchant("快樂豬早餐店",
     { baseUrl: "http://127.0.0.1:8787" });
   console.log("保存這把 key：", api_key);
   const chui = init(api_key, { baseUrl: "http://127.0.0.1:8787" });
   const menu = JSON.parse(fs.readFileSync("examples/happy-pig/menu.json", "utf8"));
   await chui.updateMenu(menu);
   await chui.updateMerchant({ payout_address: "0x店家收款地址" });
   console.log("上線完成");
   ```
2. 把 key 填進 `.env` 的 `CHUI_API_KEY`，啟動 bot：
   `pnpm --filter @chui/reference-merchant start`。
3. 手機 LINE 傳「奶茶」給 bot。

**預期**：計時 5 分鐘內看到 bot 回覆「中杯冰奶茶，總共 25 元，確認嗎？」；
過程沒碰任何 Chui 內部程式碼，只有 `@chui/sdk`。

**失敗排查**：
- `INVALID_API_KEY`／401 → key 貼錯或多了空白。
- `VALIDATION_FAILED: 菜單…` → 菜單 JSON 被改壞，訊息會指出哪個品項哪個欄位。
- bot 沒回應 → LINE webhook URL 沒 Verify 通過；查 `cloudflared` 隧道是否還活著。

## B. 語音下單（測試幣真的移動）

1. 手機開快樂豬 LIFF →按住「🎙️ 按住說話」→ 說「我要一份蛋餅加辣跟中杯冰奶茶」→ 放開。
2. 聽覆誦：「原味辣醬蛋餅，中杯冰奶茶，總共 55 元，確認嗎？」
3. 按「✅ 確認付款」。
4. 點收據上的 explorer 連結（格式 `https://suiscan.xyz/testnet/tx/...`）。

**預期**：
- explorer 顯示交易成功；餘額變化＝消費者 Mandate 減少、店家地址增加
  對應金額（55 元 × AMOUNT_SCALE）。
- console「店家 → 結算紀錄」出現這筆，金額 55 元。
- 消費者「收據」列表出現這筆，狀態「已結算」。

**失敗排查**：
- `MANDATE_REQUIRED` → 還沒建授權，或 LIFF 綁的地址跟 console 錢包不同
  （兩邊地址逐字核對）。
- `CHAIN_NOT_CONFIGURED` → `.env` 沒填 `CHUI_PACKAGE_ID`／`SPONSOR_SECRET_KEY`。
- `CHAIN_SETTLEMENT_FAILED` 且訊息含 gas → 贊助者測試幣用完，faucet 再領。
- 麥克風無反應 → LIFF 需要 https（LINE 內開啟即為 https；瀏覽器測試用 localhost）。

## C. 重排序（故意講不清楚）

依序對 LIFF 或 LINE bot 說／打：

| 說法 | 預期 |
|---|---|
| 「中冰奶」 | 覆誦「中杯冰奶茶，總共 25 元」 |
| 「但餅加辣」（誤辨字型） | 覆誦「原味辣醬蛋餅」 |
| 「菜頭粿加蛋」（台語） | 覆誦「加蛋蘿蔔糕」 |
| 「呃…那個…好吃的那個」 | **提出澄清問題**，不建立訂單 |
| 含糊帶過品項名（小聲、快速） | 救回，或澄清——**絕不可無聲出現錯誤品項** |

**判定標準**：整個測試中，任何一次覆誦內容與你說的不符而它「沒問就往下走」
＝失敗。澄清屬於正確行為。

**失敗排查**：
- 全部都聽不懂 → STT 掛了：查 `STT_API_KEY`；bot 會回「請改用文字輸入」
  而不是亂猜（若它亂猜＝bug）。
- 特定俗稱救不回 → 到 console 菜單編輯把該俗稱加進 synonyms（這是設計
  好的補救路徑，店家自己就能修）。

## D. 超限攔截（鏈上 abort）

前提：授權單筆上限 100 元。

1. 對 bot 說「十份卡拉雞腿堡」（550 元 > 100）。
2. 聽完覆誦後確認。

**預期**：付款失敗，前端明確顯示 **E_OVER_PER_TX**（bot 文案：「超過你
設定的單筆上限（E_OVER_PER_TX）」）。explorer 上這筆交易是 abort 或
根本沒有成功交易；店家結算紀錄**沒有**新增。

**失敗排查**：
- 顯示的是一般錯誤而非 E_OVER_PER_TX → `.env` 的 `CHUI_ABORT_CODES`
  對映與合約實際 abort code 不符，照合約 SPEC 修正映射。
- 竟然成功扣款 → 停：這是合約端限額沒生效，回報合約團隊，不是應用層問題。

## E. 撤銷（30 秒內演完）

先深呼吸，計時開始：

1. 手機開 console →「消費者」→ 我的授權 → 按紅色**「立即撤銷」**（~3 秒）。
2. 簽名 → 等待「已撤銷（單一交易生效）」toast（~8 秒，一筆鏈上交易）。
3. 切到 LINE 對 bot 說「奶茶」→ 覆誦後說「對」（~10 秒）。

**預期**：30 秒內完成整段；最後的結算失敗並顯示 **E_REVOKED**
（「你的授權已撤銷」）。授權列表該筆顯示紅色「已撤銷」。

**失敗排查**：
- 撤銷簽名失敗 → zkLogin ephemeral key 過期（超過 maxEpoch），重新登入再撤。
- 結算竟然成功 → 撤銷交易還沒 final 就下單了？查撤銷 tx 的 explorer 狀態；
  若撤銷已確認仍能扣款＝合約 bug，立即回報。

## F. 冪等性（同一筆 confirm 三次）

1. 正常下一單但**不要**按確認。記下 order_id（bot 日誌或 LIFF network 面板）。
2. 終端機連打三次（`$KEY` 是店家 API key）：
   ```bash
   for i in 1 2 3; do
     curl -s -X POST http://127.0.0.1:8787/v1/orders/confirm \
       -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
       -H "X-Chui-Nonce: $(uuidgen)" -H "X-Chui-Timestamp: $(date +%s)" \
       -d "{\"order_id\": \"ord_xxx\"}" | python3 -m json.tool | grep tx_digest
   done
   ```

**預期**：三次都回 200，`tx_digest` **完全相同**；explorer 只有一筆交易；
消費者只被扣一次；店家結算紀錄只有一筆。

**失敗排查**：
- 出現兩個不同 tx_digest → 重大 bug，立刻停用並回報（單元測試
  `test_idempotency.py` 應該早就抓到）。
- 第二三次回 409 → 正常（結算中），隔一秒重打會拿到同一張收據。

## G. 隱私（explorer 看不到你吃什麼）

1. 開測試 B 那筆交易的 explorer 頁面。
2. 檢查交易 inputs／events：**應該只看得到** Mandate 物件、一串 32 bytes
   digest、換算後的鏈上金額；**不應該出現**「蛋餅」「奶茶」等品項字樣
   或「55」這個元金額明文（鏈上金額是 MIST 換算值）。
3. 跑離線驗證（order_key 在 LIFF 收據頁／parse 回應）：
   ```bash
   node --experimental-strip-types scripts/verify.ts \
     --api http://127.0.0.1:8787 --api-key $KEY \
     --order ord_xxx --key <order_key>
   ```

**預期**：印出解密後明細、重算 digest 與預期 digest 一致、顯示 ✅；
且該 digest 與 explorer 交易中的 digest 逐字相同。

**失敗排查**：
- ❌ 不相符 → key 或 order 對錯了（一單一鑰，不可混用）。
- explorer 看得到品項明文 → 重大隱私 bug，立即回報。

## H. 降級（使用者無感）

1. 把 `.env` 的 `ELEVENLABS_API_KEY` 改成 `invalid_key_test` → 重啟 API。
2. LIFF 點一單。**預期**：3 秒內照樣聽到覆誦（edge-tts 音色略不同）；
   回應 header `X-Chui-Tts-Source: edge-tts`（或 cache）。
3. 斷網演練：把跑 API 的機器**斷開對外網路**（保留與手機同一內網），
   確保 prebuild 快取已生成，再點一單（用**文字**輸入，因雲端 STT 也斷了；
   或先裝 faster-whisper 讓語音也離線）。
   **預期**：覆誦照常播出（`X-Chui-Tts-Source: cache` 或 `cache-fragments`），
   使用者聽不出差別；**結算會明確失敗**（鏈上需要網路）——這是誠實
   行為，不是 bug；恢復網路後同一筆訂單 confirm 成功且只扣一次。

**失敗排查**：
- 覆誦沉默 → 快取沒建：跑 `python scripts/prebuild-tts.py --menu ...`；
  查 `TTS_CACHE_DIR` 是否與 API 行程的工作目錄一致。
- 出現 `TTS_UNAVAILABLE` 且訊息列出缺的片段 → 訊息裡就是缺字清單，
  重跑 prebuild 會自動補齊。

---

## 自動化測試（不用手機）

```bash
cd apps/api && python -m pytest tests/ -q     # 26 項：冪等/加密/TTS/webhook/重排序
cd apps/api && python eval/run_eval.py        # 重排序評估（README 數字）
pnpm --filter @chui/sdk test                  # SDK 6 項
```
