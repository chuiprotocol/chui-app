# DEMO.md —— Chui Protocol demo 操作腳本

> ☁️ 要用手機遠端實測（前端上 Cloudflare Pages）？直接看 **SETUP-CLOUD.md**。

目標：證明「**異質商家都能接上協議，使用者端體驗一致**」。
兩家店、兩種接法（原生 vs adapter）、一支語音 App、一個封包面板、
USDC on Sui Testnet 真實交易編號。

---

## 0. 事前準備（一次性，約 20 分鐘）

### 0.1 部署合約（約 5 分鐘）

```bash
# 安裝 sui CLI（擇一）：
curl -sSfL https://raw.githubusercontent.com/Mystenlabs/suiup/main/install.sh | sh && suiup install sui@testnet
# 或下載 release binary：
# https://github.com/MystenLabs/sui/releases/download/testnet-v1.79.0/sui-testnet-v1.79.0-ubuntu-x86_64.tgz

# 建地址並到 https://faucet.sui.io 領 Testnet SUI（付 gas）
sui client active-address

# 部署（會先跑 sui move test）
cd ../chui-contracts/contracts/sui && ./deploy.sh
```

腳本結束會印出 `CHUI_PACKAGE_ID=0x…`，填進本 repo 的 `.env`。

### 0.2 設定 .env（約 2 分鐘）

```bash
cp .env.example .env
# 必填：CHUI_PACKAGE_ID（上一步）
# 語音要用就填：STT_API_KEY（OpenAI 相容 Whisper）
# 收款地址：編輯 apps/hub/merchants.json 的兩個 payout_address
#（demo 可以用你自己另外兩個地址；explorer 上會看到錢分別進兩家）
```

### 0.3 手機錢包（每支手機約 5 分鐘）

1. 手機 A 與手機 B 各安裝 **Slush**（前 Sui Wallet）。
2. Slush 內切到 **Testnet**（設定 → Network）。
3. 每支手機領兩種測試幣：
   - Testnet SUI（付 gas）：https://faucet.sui.io
   - **Testnet USDC**（付款用）：https://faucet.circle.com → 選 Sui Testnet
     → 貼地址（每 2 小時可領 20 USDC；demo 匯率 1 元 = 0.032 USDC，
     20 USDC 約可點 625 元）。

### 0.4 對外網址（手機 demo 必要，約 5 分鐘）

手機上的 Slush 內建瀏覽器要能打到你的機器，且**錄音需要 https**。
最快的做法是 cloudflared 開四條隧道（Hub、兩家官網、語音 App）：

```bash
cloudflared tunnel --url http://localhost:8700   # Hub → 記下 https 網址
cloudflared tunnel --url http://localhost:9100   # 快樂鹽酥雞
cloudflared tunnel --url http://localhost:9201   # 好喝奶茶店
cloudflared tunnel --url http://localhost:9300   # 語音入口
```

把 Hub 的 https 網址填入 `.env` 的 `HUB_PUBLIC_URL` 後重啟服務
（三個網站的前端會透過 `/app-config.json` 拿到它）。

## 1. 啟動（30 秒）

```bash
./scripts/demo-up.sh     # 建置三個前端＋啟動五個服務＋健康檢查
```

| 服務 | 網址 | 角色 |
|---|---|---|
| 封包面板 | http://localhost:8700/panel | 投影在大螢幕 |
| 快樂鹽酥雞官網 | http://localhost:9100 | 商家A：自家系統＋adapter |
| 好喝奶茶店官網 | http://localhost:9201 | 商家B：公版店面，原生協議 |
| 語音入口 App | http://localhost:9300 | 一支 App 對兩家 |

停止：`./scripts/demo-down.sh`

## 2. Demo 腳本（照著演）——零按鍵版

> 開演前：把 **/panel** 投影出來，兩支手機都開好 Slush。
> 體驗核心：**除了「一次性授權」與「點一下開始說話」，全程零按鍵**
> ——說完話靜音自動送出，Chui Agent（x402 同款 session key 模式）
> 自動簽名付款，不會再跳出任何錢包確認。

### 場景零：一次性授權（每支手機一次，~20 秒）

1. 手機開 Slush 內建瀏覽器 → 進任一商家官網或語音入口。
2. 「授權 3 USDC 給你的點餐 Agent」畫面 → 在 Slush 確認**這唯一的一筆**：
   USDC 存進**你自己的鏈上 Vault**（`chui::vault`，自寫合約），
   Agent 只拿到額度內代付的 AgentCap＋0.05 SUI gas——**本金永遠不在 agent 手上**。
3. 畫面切到純語音模式，額度顯示「🤖 額度 3.00 USDC」。從此不再碰錢包、不再按任何鍵
   （回訪時麥克風權限已授予 → 開頁自動聆聽）。撤銷：頁面下方「撤銷授權」連結，
   Slush 簽一筆 `revoke_caps` 立即生效，`withdraw` 領回剩餘。

### 場景一：商家A（已有自己系統的店）

1. 快樂鹽酥雞官網 → 點一下 🎙️ → 說「**我要一份鹽酥雞加辣**」→ 手放開不用按任何鍵。
2. 靜音自動送出 → 畫面顯示並唸出「加辣鹽酥雞，總共 65 元，自動付款中」
   → Agent 自動簽名上鏈 → 收據 **✅ 鏈上驗證通過**＋explorer 連結。
3. 點開 explorer 給觀眾看（真實交易編號；金額 2.08 USDC、訂單內容只有雜湊）。
4. 指著面板：`parse → menu(adapter) → quote → order(adapter 開單 FC000x)
   → checkout → chain.verify → chain.verified → paid 通知`；
   同時商家A終端機印「🍗 [自家系統] 已收款，下鍋！」
   ——**這家店的舊系統一行程式碼都沒改，而使用者從頭到尾只點了一下麥克風**。

### 場景二：商家B（公版店面開的店）

1. 好喝奶茶店官網 → 點一下 🎙️ → 說「**一杯珍珠奶茶半糖去冰**」。
2. 自動送出 → 唸出「中杯半糖去冰珍珠奶茶，總共 55 元，自動付款中」→ 收據＋explorer。
3. 講一句：「這家店是**改一個 config JSON** 開起來的
   （apps/storefront-template/config/goodtea.json）。」

### 場景三：語音入口（一段語音、哪家都能點）

1. 語音入口 App → 點一下 🎙️ → 「我要一份鹽酥雞加辣」→
   顯示「📍 快樂鹽酥雞（協議自動路由）」→ 自動付款完成。
2. 再點一下 → 「一杯珍珠奶茶半糖去冰」→ 「📍 好喝奶茶店」→ 自動付款完成。
3. 面板出現 `route.rank` 封包——同一支 App、零按鍵、兩家異質商家。

### 加碼（展示「絕不猜」）

對任何一個入口說「呃…我要那個好吃的」→ 系統**唸出澄清問題並自動重新
聆聽**（仍然零按鍵），而不是下單。自動付款讓猜錯的代價更高，所以
「不確定就問」在零按鍵模式下反而更重要——這是協議規定的行為。

### 關於「零按鍵付款」的機制（被問到時）

x402 同款的 session key 模式：一次性授權把小額 USDC＋gas 撥給頁面內
（IndexedDB）的 Chui Agent key，之後每筆 `chui::pay::settle` 由 agent
自動簽名。損失上限＝撥入金額，花完要再授權；清除瀏覽器資料前記得把
餘額轉回。（Coinbase x402 協議本體不支援 Sui，此為同款 UX 模式的
Sui 實作——見 DECISIONS.md D19。）

## 3. 排查

| 症狀 | 檢查 |
|---|---|
| 「找不到 Sui 錢包」 | 沒在 Slush 內建瀏覽器開網頁；或桌機沒裝 Slush 擴充功能 |
| Slush 簽名時餘額不足 | USDC（faucet.circle.com）或 gas 的 SUI（faucet.sui.io）沒領 |
| 收據顯示 ⏳ pending_verification | Hub 連不上 fullnode 或交易未 final：按單一律不假成功；稍後 `POST /v1/orders/{id}/verify` 重試 |
| 錄音按鈕變灰 | 不是 https/localhost（見 0.4 隧道），先用文字輸入 |
| 語音辨識錯很多 | `.env` 沒填 STT_API_KEY（雲端 Whisper），或環境太吵；封閉詞彙重排序會救常見誤辨，救不回會問你 |
| CHAIN_NOT_CONFIGURED | `.env` 沒填 CHUI_PACKAGE_ID（見 0.1） |

## 4. 這個 demo 沒有做的事（刻意）

真金流、登入系統、退款、Mandate 預授權。付款每筆都由使用者在
Slush 親手簽名，合約 `chui::pay::settle` 把 USDC 直接轉給店家
（非託管），鏈上只留 32 bytes 訂單雜湊。
