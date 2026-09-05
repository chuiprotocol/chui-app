#!/usr/bin/env bash
# 一鍵部署前端到 Cloudflare Pages（在「你的電腦」執行；沙箱連不到 Cloudflare）。
#
# 前提：
#   1. npm i -g wrangler（或用 npx，本腳本用 npx）
#   2. 登入：npx wrangler login（瀏覽器授權）
#      或環境變數 CLOUDFLARE_API_TOKEN（權限：Cloudflare Pages – Edit）＋CLOUDFLARE_ACCOUNT_ID
#   3. Hub 的公開 https 網址（見 SETUP-CLOUD.md 的隧道章節）
#
# 用法：
#   HUB_URL=https://你的hub隧道網址 ./scripts/deploy-pages.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${HUB_URL:-}" ]; then
  echo "❌ 請提供 HUB_URL，例如："
  echo "   HUB_URL=https://xxxx.trycloudflare.com ./scripts/deploy-pages.sh"
  exit 1
fi
echo "Hub 公開網址：$HUB_URL"

deploy() { # app_dir project_name 顯示名
  local dir=$1 project=$2 label=$3
  echo ""
  echo "== 建置 ${label}（VITE_HUB_URL=${HUB_URL}）=="
  (cd "$dir" && VITE_HUB_URL="$HUB_URL" npx vite build)
  echo "== 部署 $label → Pages 專案 $project =="
  npx wrangler pages project create "$project" --production-branch=main 2>/dev/null || true
  npx wrangler pages deploy "$dir/dist" --project-name="$project" --branch=main --commit-dirty=true
}

# 網址一：快樂鹽酥雞「自家官網」（只串嘴付協議 API）
deploy apps/merchant-a  chui-happy-chicken "快樂鹽酥雞官網"
# 網址二：嘴付公版商家入口（消費者在裡面選好喝奶茶店）
deploy apps/portal      chui-portal        "嘴付公版入口"

echo ""
echo "✅ 完成。你的兩個網址（首次部署後 Pages 會顯示實際網域）："
echo "   🍗 快樂鹽酥雞官網   https://happy-chicken.chuiprotocol.com"
echo "   👄 嘴付公版入口     https://chuiprotocol.com（點「好喝奶茶店」進店）"
echo ""
echo "下一步：把 apps/hub/merchants.json 裡 happy-chicken 的 web_url 改成"
echo "        https://happy-chicken.chuiprotocol.com 後重啟 Hub（公版入口的"
echo "        「前往官網」連結會用到）。"
