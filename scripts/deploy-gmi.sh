#!/usr/bin/env bash
# deploy-gmi.sh —— 把後端整包部署到 GMI Cloud（或任何 Ubuntu VM），
# 拿到「固定的」HTTPS 網址：手機不再需要 localhost 或每次會變的隧道。
#
# 前提：1) 已在 GMI 開一台 VM（最小規格即可）並拿到「公網 IP＋SSH 私鑰」
#       2) 本機已跑過 ./scripts/go-live.sh（.env 有 CHUI_PACKAGE_ID / STT_API_KEY）
# 用法：./scripts/deploy-gmi.sh <VM_IP> [SSH_USER] [SSH_KEY_PATH]
#       例：./scripts/deploy-gmi.sh 34.12.56.78 ubuntu ~/.ssh/gmi.pem
# 重跑安全：之後改完程式重跑本腳本＝重新部署到同一個網址。
#
# ⚠️ 本腳本在沙箱無法實測（無對外網路）——首跑若卡住，把完整輸出貼回排查。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ deploy-gmi 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

VM_IP="${1:-}"
SSH_USER="${2:-ubuntu}"
SSH_KEY="${3:-}"
[ -n "${VM_IP}" ] || die "用法：./scripts/deploy-gmi.sh <VM_IP> [SSH_USER] [SSH_KEY_PATH]"
[ -f .env ] || die "找不到 .env——請先跑 ./scripts/go-live.sh"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
[ -n "${SSH_KEY}" ] && SSH_OPTS+=(-i "${SSH_KEY}")
remote() { ssh "${SSH_OPTS[@]}" "${SSH_USER}@${VM_IP}" "$@"; }

HUB_DOMAIN="${VM_IP}.sslip.io"
HUB_URL="https://${HUB_DOMAIN}"

say "1/4 連線 VM（${SSH_USER}@${VM_IP}）"
remote "echo ok" >/dev/null || die "SSH 連不上——確認 IP、使用者與金鑰"

say "2/4 確認 Docker（缺就裝）"
if ! remote "docker ps" >/dev/null 2>&1; then
  if remote "sudo docker ps" >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "安裝 Docker…"
    remote "curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker ${SSH_USER}"
    DOCKER="sudo docker"
  fi
else
  DOCKER="docker"
fi
echo "✅ Docker OK"

say "3/4 同步程式碼＋.env 到 VM"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude .demo-logs \
  --exclude .claude --exclude '*.png' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "${SSH_USER}@${VM_IP}:~/chui-app/"
echo "✅ 已同步（含 .env——只上你的 VM，不進 git）"

say "4/4 建置＋啟動（首次要拉映像檔，約 3–5 分鐘）"
remote "cd ~/chui-app && HUB_DOMAIN=${HUB_DOMAIN} ${DOCKER} compose up -d --build"

echo "等 HTTPS 憑證簽發與服務就緒…"
for i in $(seq 1 60); do
  curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' && break
  sleep 3
done
curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' \
  || die "部署完成但 healthz 不通：${HUB_URL}/healthz——查 VM 上的 docker compose logs"

cat <<URLS | tee demo-urls.txt

✅ 後端已上 GMI Cloud，網址「固定不變」：

🍗 快樂鹽酥雞官網（手機A）：
   https://chui-happy-chicken.pages.dev/?hub=${HUB_URL}

👄 嘴付公版入口（手機B）：
   https://chui-portal.pages.dev/?hub=${HUB_URL}

🎛 協議封包面板：
   ${HUB_URL}/panel

（?hub= 每支手機只需帶「第一次」，之後直接開 pages.dev 原網址即可；
 後端網址固定，這個 ?hub= 永遠不會再變。
 之後改完程式重新部署：./scripts/deploy-gmi.sh ${VM_IP} ${SSH_USER}${SSH_KEY:+ ${SSH_KEY}}）
URLS
