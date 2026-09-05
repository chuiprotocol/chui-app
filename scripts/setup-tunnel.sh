#!/usr/bin/env bash
# setup-tunnel.sh —— 用 Cloudflare Named Tunnel 給後端一個「永久固定」的
# HTTPS 網址：https://hub.chuiprotocol.com（0 元；前提：網域已在你的
# Cloudflare 帳號裡）。設定完成後手機直接開 pages.dev 即可，永遠不用 ?hub=。
#
# 用法（只需跑一次；之後 urls.sh／go-live 會自動沿用固定隧道）：
#   ./scripts/setup-tunnel.sh            # 預設 hub.chuiprotocol.com
#   ./scripts/setup-tunnel.sh hub.別的網域.com
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ setup-tunnel 在第 %s 行失敗：%s\n   請把這段訊息貼回排查\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

HOSTNAME_ARG="${1:-hub.chuiprotocol.com}"
TUNNEL_NAME="chui-hub"
CONFIG_FILE=".cloudflared-chui.yml"

say "1/5 cloudflared"
command -v cloudflared >/dev/null || die "缺 cloudflared——先跑一次 ./scripts/go-live.sh 或 brew install cloudflared"

say "2/5 Cloudflare 授權（第一次會開瀏覽器，選 chuiprotocol.com 按 Authorize）"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  cloudflared tunnel login
fi
[ -f "$HOME/.cloudflared/cert.pem" ] || die "沒拿到授權憑證（~/.cloudflared/cert.pem）"

say "3/5 建立具名隧道 ${TUNNEL_NAME}（已存在就沿用）"
TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import json,sys; ts=json.load(sys.stdin); print(next((t['id'] for t in ts if t['name']=='${TUNNEL_NAME}'), ''))" || true)
if [ -z "${TUNNEL_ID}" ]; then
  cloudflared tunnel create "${TUNNEL_NAME}"
  TUNNEL_ID=$(cloudflared tunnel list --output json \
    | python3 -c "import json,sys; ts=json.load(sys.stdin); print(next((t['id'] for t in ts if t['name']=='${TUNNEL_NAME}'), ''))")
fi
[ -n "${TUNNEL_ID}" ] || die "建立隧道失敗"
CREDS="$HOME/.cloudflared/${TUNNEL_ID}.json"
[ -f "${CREDS}" ] || die "找不到隧道憑證 ${CREDS}——這台機器沒有它的鑰匙。跑 cloudflared tunnel delete ${TUNNEL_NAME} 後重跑本腳本"
echo "隧道 ID：${TUNNEL_ID}"

say "4/5 綁 DNS：${HOSTNAME_ARG} → 隧道"
cloudflared tunnel route dns --overwrite-dns "${TUNNEL_NAME}" "${HOSTNAME_ARG}" 2>/dev/null \
  || cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_ARG}" \
  || echo "（DNS 紀錄可能已存在，沿用）"

# 寫本機設定檔（含機器專屬路徑，已加入 .gitignore 不進版控）
cat > "${CONFIG_FILE}" <<CFG
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDS}
ingress:
  - hostname: ${HOSTNAME_ARG}
    service: http://localhost:8700
  - service: http_status:404
CFG
echo "✅ 已寫入 ${CONFIG_FILE}"

say "5/5 啟動固定隧道並驗證"
mkdir -p .demo-logs
(cloudflared tunnel --config "${CONFIG_FILE}" run "${TUNNEL_NAME}" > .demo-logs/tunnel.log 2>&1 &)
HUB_URL="https://${HOSTNAME_ARG}"
echo "${HUB_URL}" > .demo-logs/tunnel-url.txt

if ! curl -s -m 3 --noproxy 127.0.0.1 http://127.0.0.1:8700/healthz | grep -q '"ok"'; then
  echo "⚠️ 本機 Hub 沒在跑——固定隧道已設定完成，先跑 ./scripts/demo-up.sh 再開網址"
else
  for i in $(seq 1 30); do
    curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' && break
    sleep 2
  done
  curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' \
    || die "隧道啟動了但 ${HUB_URL}/healthz 不通——看 .demo-logs/tunnel.log 並把內容貼回"
fi

cat <<DONE

✅ 固定網址架好了（永遠不變）：${HUB_URL}

📱 手機從此「直接開」這兩個網址即可（不用再帶 ?hub=）：
   https://chui-happy-chicken.pages.dev
   https://chui-portal.pages.dev

🎛 封包面板：${HUB_URL}/panel

之後開 demo 只要：./scripts/demo-up.sh && ./scripts/urls.sh
（urls.sh 會自動沿用這條固定隧道；Mac 重開機後重跑同一行即可）
DONE
