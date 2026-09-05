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

## 上雲（用戶指示：不要再 localhost）
- [ ] **跑一次 `./scripts/deploy-fly.sh`**（在 Mac 上、專案根目錄）：
      後端整包上 Fly.io，之後 Mac 可關機。前提＝`FLY_API_TOKEN`
      放環境變數或 .env（token 絕不進 git）。
- [ ] **Cloudflare DNS 一次性切換**：hub 那筆 CNAME 從隧道
      （…cfargotunnel.com）改指 `chui-protocol-hub.fly.dev`、
      Proxy 切「DNS only」（灰雲）；驗證
      `curl https://hub.chuiprotocol.com/healthz`。切完前端零改動。
- 備援路徑：任何 Ubuntu VM 一樣能上（`./scripts/deploy-gmi.sh <IP>`，
      Hetzner/DO 最小機約 US$4–6/月）；Named Tunnel
      （scripts/setup-tunnel.sh）降級為本機開發用。

## 等外部條件
- [ ] **更正**：AMD 與 GMI 提供的是「LLM token API」不是 VM——
      定位改為 LLM 重述備援的供應商（與 EastRouter 同一插槽）。
      哪家先發 key 就在 .env 填通用三項：LLM_BASE_URL／LLM_API_KEY／
      LLM_MODEL（＋LLM_PROVIDER 標名），healthz `llm_assist` 顯示之。
      scripts/deploy-gmi.sh 保留為「任何 Ubuntu VM」通用部署腳本備用。
- [ ] demo 結束後：撤銷對話中出現過的金鑰（OpenAI key、Fly token）。
