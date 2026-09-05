#!/usr/bin/env bash
# setup-worker.sh —— 雲端 Hub 一鍵設定（Cloudflare 免費 Worker）。
# 我（Claude）把所有 Cloudflare 設定寫成這支腳本代你操作：
#   部署 Worker chui-hub → 填 Secrets（從 .env 讀，不落終端）→
#   清掉 hub 的舊隧道 DNS → 綁 hub.chuiprotocol.com → 驗證 healthz。
#
# 前提（一次性，約 1 分鐘）：建一把 Cloudflare API Token——
#   dash.cloudflare.com/profile/api-tokens → Create Token →
#   選「Edit Cloudflare Workers」模板 → Zone Resources 選 chuiprotocol.com
#   → 再手動加一列權限：Zone / DNS / Edit → Continue → Create → 複製。
# 用法：
#   export CLOUDFLARE_API_TOKEN=貼上token
#   cd ~/chui-app && git pull && ./scripts/setup-worker.sh
# 重跑安全：改完程式重跑＝原地更新同一個 Worker。
#
# ⚠️ 沙箱無法連 Cloudflare API，本腳本無法在沙箱實測——卡住就把
#    完整輸出貼回排查。token 只走環境變數，絕不落地、絕不進 git。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ setup-worker 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

HUB_DOMAIN="hub.chuiprotocol.com"
ZONE_NAME="chuiprotocol.com"
API="https://api.cloudflare.com/client/v4"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] \
  || die "缺 CLOUDFLARE_API_TOKEN——照腳本開頭註解建一把 token 後：export CLOUDFLARE_API_TOKEN=…"
[ -f .env ] || die "找不到 .env——請先跑 ./scripts/go-live.sh"

cf() { curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$@"; }

say "1/5 檢查 token 與相依"
cf "${API}/user/tokens/verify" | grep -q '"status":"active"' \
  || die "token 驗證失敗——確認複製完整、未過期"
command -v pnpm >/dev/null 2>&1 || die "找不到 pnpm——先裝 node/pnpm（先前建置前端用過的環境即可）"
pnpm install --silent 2>/dev/null || pnpm install
echo "✅ token 有效、相依就緒"

say "2/5 清掉 ${HUB_DOMAIN} 的舊隧道 DNS（讓 custom domain 綁得上）"
ZID="$(cf "${API}/zones?name=${ZONE_NAME}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result") or []; print(r[0]["id"] if r else "")')"
if [ -z "${ZID}" ]; then
  echo "⚠️ token 看不到 zone ${ZONE_NAME}（沒給 DNS 權限？）——跳過清理；"
  echo "   若最後綁網域失敗，請到 DNS 手動刪掉 hub 那筆 CNAME 後重跑。"
else
  RIDS="$(cf "${API}/zones/${ZID}/dns_records?name=${HUB_DOMAIN}" \
    | python3 -c 'import json,sys; print("\n".join(x["id"] for x in (json.load(sys.stdin).get("result") or []) if "cfargotunnel" in str(x.get("content","")) or x.get("type")=="CNAME"))')"
  if [ -z "${RIDS}" ]; then
    echo "✅ 沒有舊 CNAME 要清"
  else
    for rid in ${RIDS}; do
      cf -X DELETE "${API}/zones/${ZID}/dns_records/${rid}" >/dev/null
      echo "🧹 已刪舊 DNS 記錄 ${rid}"
    done
  fi
fi

say "3/5 部署 Worker（chui-hub，含 hub.chuiprotocol.com custom domain）"
(cd apps/hub-worker && CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" \
  npx wrangler deploy --config wrangler.jsonc)

say "4/5 填 Secrets（從 .env 讀，值不顯示在終端）"
put_secret() {
  local name="$1"
  local val
  val="$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
  if [ -z "${val}" ]; then
    echo "⚠️ .env 沒有 ${name}——先跳過（之後補：wrangler secret put ${name} --config apps/hub-worker/wrangler.jsonc）"
    return 0
  fi
  printf '%s' "${val}" | (cd apps/hub-worker && CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" \
    npx wrangler secret put "${name}" --config wrangler.jsonc) >/dev/null
  echo "🔐 ${name} 已設定"
}
put_secret CHUI_PACKAGE_ID
put_secret STT_API_KEY
put_secret ELEVENLABS_API_KEY
# 有拿到 key 才會存在於 .env；沒有就自動跳過（healthz 會誠實顯示 off／static）
put_secret ATLAS_ORACLE_API_KEY
put_secret ATLAS_FEED_ID
put_secret LLM_BASE_URL
put_secret LLM_API_KEY
put_secret LLM_MODEL

say "5/5 驗證（等 DNS／憑證生效，最多 2 分鐘）"
HUB_URL="https://${HUB_DOMAIN}"
for i in $(seq 1 40); do
  curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"cloudflare-worker"' && break
  sleep 3
done
if curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"cloudflare-worker"'; then
  cat <<DONE

✅ 雲端 Hub 上線，固定網址：${HUB_URL}（你的電腦從此可以關機）

兩支手機「零設定」直接開：
  🍗 手機A https://happy-chicken.chuiprotocol.com
  👄 手機B https://chuiprotocol.com
  🎛 封包面板 ${HUB_URL}/panel

之後改完程式重新上雲：重跑本腳本（或到儀表板把 repo 連上 Git 整合，
push 即自動部署——Build command 留空、Deploy command：
npx wrangler deploy --config apps/hub-worker/wrangler.jsonc）
DONE
else
  die "Worker 已部署但 ${HUB_URL}/healthz 還不通——等幾分鐘再 curl 一次；仍不通就把輸出貼回給我"
fi
