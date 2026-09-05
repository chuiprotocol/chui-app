# SETUP-CLOUD.md —— 上 Cloudflare Pages（手機實測版）

目標：兩支手機的 Slush 內建瀏覽器分別打開
**🍗 快樂鹽酥雞官網**（自家網址，只串嘴付協議 API）與
**👄 嘴付公版入口**（消費者在裡面選「好喝奶茶店」），完成語音支付。

> 架構事實：Cloudflare Pages 只能跑靜態網站——**三個前端上 Pages**；
> **Chui Hub（Python：STT＋重排序）與兩家商家後端**是一整包行程，
> 跑在任一台機器上（先用你的電腦），以一條 cloudflared 隧道公開 Hub。
> 前端只連 Hub 一個網址，所以隧道只需要一條。

## ⚡ 最快路徑：一條指令

Pages 兩個網站已部署好之後，你電腦上只要：

```bash
cd ~/chui-app && git pull && ./scripts/go-live.sh
```

腳本會自動：裝 sui CLI（缺才裝）→ 建錢包＋領 gas → 跑合約測試＋部署
→ 把 CHUI_PACKAGE_ID 寫進 .env → 問你要不要貼 STT key → 啟動後端整包
→ 裝 cloudflared＋開隧道 → **直接印出兩支手機要開的完整網址**。
重跑安全（做過的步驟自動跳過）。以下章節是同一件事的手動版。

## 0. 前提（一次性）

- 合約已部署、`.env` 已填 `CHUI_PACKAGE_ID` 與 `STT_API_KEY`（見 DEMO.md §0.1–0.2）
- 手機已裝 Slush（Testnet）＋領好 USDC 與 SUI（見 DEMO.md §0.3）
- 有 Cloudflare 帳號（免費版即可）

## 1. 啟動後端整包（你的電腦，30 秒）

```bash
cd ~/chui-app && ./scripts/demo-up.sh
```

## 2. 公開 Hub（一條隧道，30 秒）

```bash
cloudflared tunnel --url http://localhost:8700
# 記下印出的 https://xxxx.trycloudflare.com ← 這就是 HUB_URL
```

（正式一點可在 Cloudflare Zero Trust 建具名 tunnel 綁自己網域，步驟相同。）

## 3. 部署兩個前端到 Pages

### 3a. 推薦：Git 整合（一次性點擊設定，之後每次 push 自動部署）

新版儀表板是「Workers 統一流程」（沒有 Pages 分頁也沒關係，
repo 內已放好 wrangler.jsonc，走 Worker 靜態資產部署）：

https://dash.cloudflare.com → Workers & Pages → **Create application →
Import a repository** → 選 `chuiprotocol/chui-app`，建**兩個** app，
三個欄位照抄：

| 欄位 | App 一：快樂鹽酥雞官網 | App 二：嘴付公版入口 |
|---|---|---|
| Project name | `chui-happy-chicken` | `chui-portal` |
| Build command | `pnpm --filter @chui/merchant-a build` | `pnpm --filter @chui/portal build` |
| Deploy command | `npx wrangler deploy --config apps/merchant-a/wrangler.jsonc` | `npx wrangler deploy --config apps/portal/wrangler.jsonc` |

按 **Deploy**。完成後網址形如
`https://chui-happy-chicken.<你的子網域>.workers.dev` 與
`https://chui-portal.<你的子網域>.workers.dev`（部署頁會直接顯示）。
**之後每次我 push 程式碼就會自動重新部署**，不再需要你動手。

### 3b. 替代：本機 CLI 一鍵部署

```bash
npx wrangler login          # 第一次會開瀏覽器授權
HUB_URL=https://xxxx.trycloudflare.com ./scripts/deploy-pages.sh
```

> 💡 **隧道網址換了不用重部署**：手機開
> `https://chui-portal.pages.dev/?hub=https://新網址` 帶一次，
> 網站會記住（IndexedDB），之後直接開原網址即可。

完成後得到兩個網址：

| 網址 | 內容 |
|---|---|
| `https://chui-happy-chicken.pages.dev` | 🍗 快樂鹽酥雞**自家官網**——菜單/語音/結帳全部只串 Hub 協議 API |
| `https://chui-portal.pages.dev` | 👄 嘴付**公版入口**——列出商家，點「好喝奶茶店」進店點餐 |

（Pages 專案名若被別人佔用，改 `scripts/deploy-pages.sh` 裡的 project 名稱即可。）

## 4. 手機實測

1. 手機A：Slush 內建瀏覽器開 `https://chui-happy-chicken.pages.dev`
   → 授權 3 USDC（唯一一次簽名）→ 點🎙️說「我要一份鹽酥雞加辣」
   → 聽覆誦 → 自動付款 → 收據＋explorer。
2. 手機B：開 `https://chui-portal.pages.dev` → 點「好喝奶茶店」
   → 授權 → 說「一杯珍珠奶茶半糖去冰」→ 自動付款完成。
3. 大螢幕開 `HUB_URL/panel` 看封包流。

## 5. 注意事項與排查

| 症狀 | 原因／解法 |
|---|---|
| 頁面顯示「連不上 Chui Hub」 | 隧道斷了或 HUB_URL 填錯：quick tunnel 每次重開網址會變，重跑 §2 與 §3（或改用具名 tunnel 固定網址） |
| 商家清單/菜單載不出來 | 後端整包沒啟動（§1），或 Hub log 有錯：看 `.demo-logs/hub.log` |
| 語音沒反應 | Pages 是 https ✅；確認手機給了麥克風權限；`.env` 有 STT_API_KEY |
| 「找不到 Sui 錢包」 | 沒用 Slush 內建瀏覽器開（用系統瀏覽器開會沒有錢包）|
| 付款失敗訊息含 abort | 看 explorer：`2`=授權已撤銷、`3`=超過單筆上限、`4`=額度不足（chui::vault abort codes） |
| 現場想換 Hub 網址不重部署 | 網址加 `?hub=https://新網址` 即可覆寫 |

## 6. 後端上雲（正式版：Cloudflare 免費 Worker，不再 localhost）

後端整包已移植成 **Cloudflare Worker**（`apps/hub-worker/`，免費層即可）：
重排序引擎、報價、接單單號、鏈上驗證、SSE 看板全在 Worker＋Durable
Object（SQLite 持久化——單號跨重啟不歸零、訂單不消失）。部署方式與
兩個前端相同：**儀表板點幾下 Git 整合，之後每次 push 自動部署**。

### 6a. 建 Worker（一次性，約 3 分鐘）

https://dash.cloudflare.com → Workers & Pages → **Create application →
Import a repository** → 選 `chuiprotocol/chui-app`，欄位照抄：

| 欄位 | 值 |
|---|---|
| Project name | `chui-hub` |
| Build command | （留空） |
| Deploy command | `npx wrangler deploy --config apps/hub-worker/wrangler.jsonc` |

按 **Deploy**。完成後得到 `https://chui-hub.<你的子網域>.workers.dev`。

### 6b. 填參數（Settings → Variables and Secrets）

| 名稱 | 型別 | 值 |
|---|---|---|
| `CHUI_PACKAGE_ID` | Text | 跟你 `.env` 裡同一個 package id |
| `STT_API_KEY` | **Secret** | OpenAI key（語音辨識用） |

（可選：`ATLAS_ORACLE_API_KEY`／`ATLAS_FEED_ID`／`LLM_API_KEY` 等，
拿到 key 後照 `.env.example` 同名填入。）填完按 Deploy 重新部署生效。

### 6c. 綁固定網域（30 秒）

1. dash.cloudflare.com → chuiprotocol.com → DNS → Records：
   **刪掉** `hub` 那筆指向 `…cfargotunnel.com` 的舊隧道 CNAME。
2. 回到 chui-hub Worker → Settings → **Domains & Routes → Add →
   Custom domain** → 輸入 `hub.chuiprotocol.com` → Add。
3. 驗證：`curl https://hub.chuiprotocol.com/healthz` 應回 `"ok": true`
   且 `"runtime": "cloudflare-worker"`。

前端**零改動**（內建備援網址就是 hub.chuiprotocol.com），兩支手機
直接開 pages.dev 網址即可；你的電腦從此可以關機。

- 之後改完程式：push 即自動重新部署（三個 app 一致）。
- 誠實揭露：雲端 Worker 版的兩家商家「協議端點」為內建實作（菜單
  靜態化＋DO 發單號）；legacy＋adapter 的整合示範仍在本機版
  （`demo-up.sh`）。訂單儲存改用 Durable Object SQLite，MongoDB
  Atlas 之後想接再接（VM 部署模式 `deploy-gmi.sh` 仍支援）。
