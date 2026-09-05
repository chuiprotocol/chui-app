# SETUP.md —— 從零到跑起來

## 雲端（正式）——一次設定，之後 push 即部署

三個 app 都用 Cloudflare Git 整合（免費層）：
- `chui-hub`（Worker）：Deploy command `npx wrangler deploy --config apps/hub-worker/wrangler.jsonc`
- `chui-portal`／`chui-happy-chicken`（Pages）：build 用 `pnpm --filter … build`

Secrets（chui-hub → Settings → Variables）：`CHUI_PACKAGE_ID`（合約 package id）、
`STT_API_KEY`（OpenAI）、`ELEVENLABS_API_KEY`；選配 `ATLAS_ORACLE_API_KEY`、
`LLM_*`（GMI/AMD/EastRouter 重述備援）。
自動化腳本：`scripts/setup-worker.sh`（部署＋secrets＋綁 hub 網域）、
`scripts/setup-frontend-domains.sh`（前端綁自有網域）。

## 本機開發

```bash
pnpm install
pnpm --filter @chui/hub-worker dev     # 後端（wrangler dev，含本地 DO SQLite）
pnpm --filter @chui/portal dev         # 前端，網址加 ?hub=http://localhost:8787
pnpm --filter @chui/hub-worker test    # 41 個測試
```

## 合約

見 [chui-contracts](https://github.com/chuiprotocol/chui-contracts)：
`sui move test`（17 案例）→ `./deploy.sh` → 把 package id 填進 Worker secrets。
Testnet only——程式碼層封鎖 mainnet。
