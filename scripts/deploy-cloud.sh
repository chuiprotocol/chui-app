#!/usr/bin/env bash
# deploy-cloud.sh —— 把後端整包（Hub＋兩家商家）部署到 Fly.io，
# 拿到「固定的」HTTPS 網址：手機不再需要 localhost 或每次會變的隧道。
#
# 前提：已跑過 ./scripts/go-live.sh（.env 有 CHUI_PACKAGE_ID / STT_API_KEY）。
# 用法：./scripts/deploy-cloud.sh
# 重跑安全：之後每次改完程式重跑本腳本＝重新部署到同一個網址。
#
# ⚠️ 本腳本在沙箱無法實測（無 Docker／對外網路）——首跑若卡住，
#    把完整輸出貼回來排查。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ deploy-cloud 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

[ -f .env ] || die "找不到 .env——請先跑 ./scripts/go-live.sh"

say "1/4 flyctl（Fly.io CLI）"
if ! command -v flyctl >/dev/null && ! command -v fly >/dev/null; then
  echo "安裝 flyctl…"
  command -v brew >/dev/null && brew install flyctl || curl -L https://fly.io/install.sh | sh
  export PATH="$HOME/.fly/bin:$PATH"
fi
FLY=$(command -v flyctl || command -v fly)
# 支援 token 登入：FLY_API_TOKEN=xxxx ./scripts/deploy-cloud.sh
# （flyctl 會自動讀 FLY_API_TOKEN；token 不落地、不進 git）
if [ -n "${FLY_API_TOKEN:-}" ]; then
  echo "使用 FLY_API_TOKEN 登入"
fi
"$FLY" auth whoami >/dev/null 2>&1 || "$FLY" auth login

say "2/4 建立／取得 app（固定網址）"
if ! grep -q '^app = ' fly.toml; then
  # 首跑：讓 Fly 產生全球唯一的 app 名稱並寫回 fly.toml
  "$FLY" launch --no-deploy --copy-config --generate-name --yes
fi
APP=$(grep '^app = ' fly.toml | sed "s/app = ['\"]\{0,1\}//; s/['\"]\{0,1\}\$//" | tr -d "'\"")
[ -n "${APP}" ] || die "fly.toml 沒有 app 名稱，請把輸出貼回排查"
HUB_URL="https://${APP}.fly.dev"
echo "app：${APP} → ${HUB_URL}"

say "3/4 同步 .env 機密到 Fly（不進 git、不進映像檔）"
secrets=""
for key in CHUI_PACKAGE_ID CHUI_MODULE CHUI_FN_SETTLE STT_API_KEY USDC_UNITS_PER_TWD \
           SEAL_KEY_SERVERS WALRUS_PUBLISHER WALRUS_AGGREGATOR CHUI_USDC_COIN_TYPE; do
  value=$(grep "^${key}=" .env | cut -d= -f2- || true)
  [ -n "${value}" ] && secrets="${secrets} ${key}=${value}"
done
# shellcheck disable=SC2086
[ -n "${secrets}" ] && "$FLY" secrets set --app "${APP}" --stage ${secrets} >/dev/null
echo "✅ secrets 已同步"

say "4/4 部署（首次要建映像檔，約 3–5 分鐘）"
"$FLY" deploy --app "${APP}" --ha=false

for i in $(seq 1 30); do
  curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' && break
  sleep 2
done
curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' || die "部署完成但 healthz 不通：${HUB_URL}/healthz"

cat <<URLS | tee demo-urls.txt

✅ 後端已上雲，網址「固定不變」——手機直接開、不用再帶隧道參數：

🍗 快樂鹽酥雞官網（手機A）：
   https://chui-happy-chicken.pages.dev/?hub=${HUB_URL}

👄 嘴付公版入口（手機B）：
   https://chui-portal.pages.dev/?hub=${HUB_URL}

🎛 協議封包面板：
   ${HUB_URL}/panel

（?hub= 每支手機只需帶「第一次」，之後直接開 pages.dev 原網址即可；
 因為後端網址固定，這個 ?hub= 永遠不會再變。
 之後改完程式重新部署：./scripts/deploy-cloud.sh）
URLS
