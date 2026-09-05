#!/usr/bin/env bash
# deploy-fly.sh —— 後端整包一鍵上 Fly.io：從此不再 localhost，Mac 可以關機。
#
# 前提：1) .env 已由 ./scripts/go-live.sh 填好（CHUI_PACKAGE_ID／STT_API_KEY…）
#       2) Fly token：export FLY_API_TOKEN=…（或寫進 .env；token 絕不進 git）
# 用法：./scripts/deploy-fly.sh
# 重跑安全：改完程式重跑＝重新部署到同一個網址。
#
# 部署完成後（一次性）把 Cloudflare DNS 的 hub 指到 Fly，前端零改動：
# 手機直接開 https://chui-portal.pages.dev（PUBLIC_HUB_URL 已是 hub.chuiprotocol.com）。
#
# ⚠️ 沙箱無對外網路，本腳本無法在沙箱實測——首跑卡住就把完整輸出貼回排查。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ deploy-fly 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

FLY_APP="${FLY_APP:-chui-protocol-hub}"
HUB_DOMAIN="hub.chuiprotocol.com"

say "1/6 檢查 flyctl（缺就裝）"
if ! command -v fly >/dev/null 2>&1 && ! command -v flyctl >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install flyctl
  else
    curl -L https://fly.io/install.sh | sh
    export PATH="${HOME}/.fly/bin:${PATH}"
  fi
fi
FLY="$(command -v fly || command -v flyctl)"
echo "✅ flyctl：${FLY}"

say "2/6 讀取 Fly token（只進環境變數，不落地不上傳 git）"
if [ -z "${FLY_API_TOKEN:-}" ] && [ -f .env ]; then
  # 只取值、不 echo：token 絕不出現在終端輸出
  FLY_API_TOKEN="$(grep -E '^FLY_API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
fi
[ -n "${FLY_API_TOKEN:-}" ] || die "缺 FLY_API_TOKEN——export FLY_API_TOKEN=… 或寫一行進 .env（.env 已被 gitignore）"
export FLY_API_TOKEN

say "3/6 確認 App（${FLY_APP}；不存在就建立）"
if ! "${FLY}" apps list --json 2>/dev/null | grep -q "\"${FLY_APP}\""; then
  "${FLY}" apps create "${FLY_APP}" \
    || die "App 名稱 ${FLY_APP} 被別人占走了——改用：FLY_APP=chui-hub-你的暱稱 ./scripts/deploy-fly.sh（並同步改 fly.toml 的 app=）"
fi
echo "✅ App OK"

say "4/6 上傳 .env 為 Fly secrets（平台注入，不烤進映像檔）"
[ -f .env ] || die "找不到 .env——請先跑 ./scripts/go-live.sh"
# 過濾註解／空行／FLY_API_TOKEN 本身（token 只給部署用，不進執行環境）
grep -Ev '^\s*(#|$)|^FLY_API_TOKEN=' .env | "${FLY}" secrets import -a "${FLY_APP}" --stage
echo "✅ secrets 已暫存（隨下一步部署一起生效）"

say "5/6 部署（首次建映像檔約 3–6 分鐘）"
"${FLY}" deploy -a "${FLY_APP}" --ha=false

FLY_URL="https://${FLY_APP}.fly.dev"
echo "等服務就緒…"
for i in $(seq 1 40); do
  curl -s -m 5 "${FLY_URL}/healthz" | grep -q '"ok"' && break
  sleep 3
done
curl -s -m 5 "${FLY_URL}/healthz" | grep -q '"ok"' \
  || die "部署完成但 healthz 不通：${FLY_URL}/healthz——跑 ${FLY} logs -a ${FLY_APP} 查原因"
echo "✅ 後端已在雲上：${FLY_URL}"

say "6/6 綁固定網域 ${HUB_DOMAIN}"
"${FLY}" certs add -a "${FLY_APP}" "${HUB_DOMAIN}" >/dev/null 2>&1 || true

cat <<STEPS

✅ 雲端後端已上線（Mac 從此可關機）：${FLY_URL}

最後一步（一次性，30 秒）——到 Cloudflare 儀表板把 DNS 切到雲端：
  1. dash.cloudflare.com → chuiprotocol.com → DNS → Records
  2. 找到「hub」那筆 CNAME（目前指向 …cfargotunnel.com 的隧道）→ 編輯
  3. Target 改成：${FLY_APP}.fly.dev
  4. Proxy status 切成「DNS only」（灰雲，讓 Fly 自己簽 HTTPS 憑證）→ Save
  5. 等 1–3 分鐘憑證簽好，驗證：
       curl https://${HUB_DOMAIN}/healthz

之後兩支手機「零設定」直接用（前端內建 ${HUB_DOMAIN} 備援）：
  🍗 手機A https://chui-happy-chicken.pages.dev
  👄 手機B https://chui-portal.pages.dev
DNS 還沒切之前，臨時可先帶 ?hub=${FLY_URL} 使用。

改完程式重新上雲：./scripts/deploy-fly.sh（同網址原地更新）
看雲端日誌：${FLY} logs -a ${FLY_APP}
STEPS
