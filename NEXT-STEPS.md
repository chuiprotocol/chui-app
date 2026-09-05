# 待辦與未驗證事項（隨時更新）

## 未驗證
- [ ] **Atlas Oracle 尚未取得 API key**：之後帶用戶到 atlasoracle.io
      註冊（文件寫註冊後自動發 key），把 key 與 USDC/USD feed 的 id
      填進 .env（ATLAS_ORACLE_API_KEY／ATLAS_FEED_ID／
      ATLAS_FEED_MEANING=USDC_USD）；驗證標準＝healthz
      `fx_source: atlas-oracle`。
- [ ] **已決策記錄**：Atlas Oracle 沒有 TWD feed——已改用 USDC/USD
      模式（加密腿即時、台幣腿 ATLAS_TWD_PER_USD 設定值，預設 31.5；
      見 DECISIONS D26 與 commit 7ea0b17）。

## 上雲（用戶指示：Cloudflare 免費 Worker，不用 Fly.io；已授權代設定）
- [x] chui-hub 已連上 Git 整合（push 即自動部署，與兩個前端一致）。
- [ ] **用戶建一把 API token**（Edit Cloudflare Workers 模板＋
      Zone/DNS/Edit，見 SETUP-CLOUD §6）→ 在 Mac 跑
      `export CLOUDFLARE_API_TOKEN=…` ＋ `./scripts/setup-worker.sh`
      ——部署／Secrets／清舊 DNS／綁 hub.chuiprotocol.com 全自動；
      驗證標準＝healthz 回 `runtime: cloudflare-worker`。前端零改動。
      （沙箱連不到 Cloudflare API，故由腳本在用戶機器代跑；token
      只走環境變數，用完可撤銷。）
- （Python 本機版與 VM 備援腳本已於收尾清理移除——正式與開發都走 Worker。）

## 已接上的贊助資源
- [x] **GMI Cloud**：LLM 重述備援已上線（GLM-4.7-Flash，免費層；
      healthz `llm_assist: gmi-cloud`）。
- [x] **ElevenLabs**：STT 主力已上線（Scribe v2，stt_chain 第一位）。

## 等外部條件
- [ ] **更正**：AMD 與 GMI 提供的是「LLM token API」不是 VM——
      定位改為 LLM 重述備援的供應商（與 EastRouter 同一插槽）。
      哪家先發 key 就在 .env 填通用三項：LLM_BASE_URL／LLM_API_KEY／
      LLM_MODEL（＋LLM_PROVIDER 標名），healthz `llm_assist` 顯示之。
      scripts/deploy-gmi.sh 保留為「任何 Ubuntu VM」通用部署腳本備用。
- [ ] demo 結束後：撤銷對話中出現過的金鑰（OpenAI key、Fly token、
      Cloudflare API token——Worker 部署完成後即可撤，
      日常更新走 git push／重建新 token）。
