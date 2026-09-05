# 待辦與未驗證事項（隨時更新）

## 未驗證
- [ ] **MongoDB Atlas 接線尚未驗證**：用戶已建 Cluster0，但還沒跑
      `./scripts/setup-atlas.sh '<連線字串>'`；驗證標準＝腳本印出
      「✅ 訂單現在存 MongoDB Atlas」且 healthz `order_store: mongodb-atlas`。
- [ ] **Atlas Oracle 尚未取得 API key**：之後帶用戶到 atlasoracle.io
      註冊（文件寫註冊後自動發 key），把 key 與 USDC/USD feed 的 id
      填進 .env（ATLAS_ORACLE_API_KEY／ATLAS_FEED_ID／
      ATLAS_FEED_MEANING=USDC_USD）；驗證標準＝healthz
      `fx_source: atlas-oracle`。
- [ ] **已決策記錄**：Atlas Oracle 沒有 TWD feed——已改用 USDC/USD
      模式（加密腿即時、台幣腿 ATLAS_TWD_PER_USD 設定值，預設 31.5；
      見 DECISIONS D26 與 commit 7ea0b17）。

## 上雲（用戶指示：Cloudflare 免費 Worker，不用 Fly.io）
- [ ] **儀表板建第三個 app `chui-hub`**（與兩個前端同模式的 Git 整合，
      Deploy command：`npx wrangler deploy --config
      apps/hub-worker/wrangler.jsonc`）——詳細步驟見 SETUP-CLOUD §6。
- [ ] **填 Variables**：CHUI_PACKAGE_ID（Text）＋STT_API_KEY（Secret）。
- [ ] **綁網域**：先刪 DNS 裡 hub 的舊隧道 CNAME，再到 Worker 的
      Domains & Routes 加 custom domain `hub.chuiprotocol.com`；
      驗證 healthz 回 `runtime: cloudflare-worker`。前端零改動。
- 備援路徑：任何 Ubuntu VM 一樣能上整包 Python 版
      （`./scripts/deploy-gmi.sh <IP>`）；Named Tunnel
      （scripts/setup-tunnel.sh）降級為本機開發用。
      Fly.io 方案已依用戶指示移除（token 記得撤銷，見下）。

## 等外部條件
- [ ] **更正**：AMD 與 GMI 提供的是「LLM token API」不是 VM——
      定位改為 LLM 重述備援的供應商（與 EastRouter 同一插槽）。
      哪家先發 key 就在 .env 填通用三項：LLM_BASE_URL／LLM_API_KEY／
      LLM_MODEL（＋LLM_PROVIDER 標名），healthz `llm_assist` 顯示之。
      scripts/deploy-gmi.sh 保留為「任何 Ubuntu VM」通用部署腳本備用。
- [ ] demo 結束後：撤銷對話中出現過的金鑰（OpenAI key、Fly token）。
