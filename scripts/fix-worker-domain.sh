#!/usr/bin/env bash
# fix-worker-domain.sh —— hub.chuiprotocol.com 綁定診斷＋自動修復。
# setup-worker.sh 部署成功但網域不通時跑這支：
#   檢查 healthz → 印出 DNS 現況 → 清殘留 CNAME → 直接用 API 把
#   custom domain 綁到 chui-hub → 輪詢最多 4 分鐘 → 仍不通就印出
#   完整診斷（貼回給 Claude）。
# 用法：
#   export CLOUDFLARE_API_TOKEN=同一把token
#   cd ~/chui-app && git pull && ./scripts/fix-worker-domain.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ fix-worker-domain 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

HUB_DOMAIN="hub.chuiprotocol.com"
ZONE_NAME="chuiprotocol.com"
WORKER_NAME="chui-hub"
API="https://api.cloudflare.com/client/v4"
HUB_URL="https://${HUB_DOMAIN}"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "缺 CLOUDFLARE_API_TOKEN——export 同一把 token 再跑"
cf() { curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$@"; }

ok_now() { curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"cloudflare-worker"'; }

say "0/4 先試一次 healthz"
if ok_now; then
  echo "✅ ${HUB_URL} 已經通了（剛才只是憑證還在簽）——不用修，收工！"
  exit 0
fi
echo "還不通，開始診斷。"

say "1/4 找 zone／帳號"
ZID="$(cf "${API}/zones?name=${ZONE_NAME}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result") or []; print(r[0]["id"] if r else "")')"
[ -n "${ZID}" ] || die "token 看不到 zone ${ZONE_NAME}——token 需要 Zone/DNS/Edit 權限（重建 token 後重跑）"
AID="$(cf "${API}/zones/${ZID}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["account"]["id"])')"
echo "zone=${ZID} account=${AID}"

say "2/4 DNS 現況（${HUB_DOMAIN}）＋清殘留"
cf "${API}/zones/${ZID}/dns_records?name=${HUB_DOMAIN}" \
  | python3 -c 'import json,sys
rows = json.load(sys.stdin).get("result") or []
if not rows: print("（目前沒有任何 hub DNS 記錄）")
for x in rows: print("- %s → %s（proxied=%s, id=%s）" % (x["type"], x.get("content",""), x.get("proxied"), x["id"]))'
# Worker custom domain 自己會放一筆特殊記錄；擋路的是舊隧道/一般 CNAME
RIDS="$(cf "${API}/zones/${ZID}/dns_records?name=${HUB_DOMAIN}&type=CNAME" \
  | python3 -c 'import json,sys; print("\n".join(x["id"] for x in (json.load(sys.stdin).get("result") or [])))')"
if [ -n "${RIDS}" ]; then
  for rid in ${RIDS}; do
    cf -X DELETE "${API}/zones/${ZID}/dns_records/${rid}" >/dev/null
    echo "🧹 已刪殘留 CNAME ${rid}"
  done
else
  echo "沒有殘留 CNAME 要清"
fi

say "3/4 直接用 API 綁 custom domain → ${WORKER_NAME}"
ATTACH="$(cf -X PUT "${API}/accounts/${AID}/workers/domains" \
  -H "Content-Type: application/json" \
  --data "{\"zone_id\":\"${ZID}\",\"hostname\":\"${HUB_DOMAIN}\",\"service\":\"${WORKER_NAME}\",\"environment\":\"production\"}")"
echo "${ATTACH}" | python3 -c 'import json,sys
d=json.load(sys.stdin)
if d.get("success"): print("✅ custom domain 已登記：", d["result"].get("hostname"))
else: print("⚠️ API 回應：", json.dumps(d.get("errors"), ensure_ascii=False))'

say "4/4 輪詢 healthz（DNS＋TLS 簽發，最多 4 分鐘）"
for i in $(seq 1 80); do
  ok_now && break
  sleep 3
done
if ok_now; then
  cat <<DONE

✅ 修好了，固定網址：${HUB_URL}（Mac 可以關機）
  🍗 手機A https://happy-chicken.chuiprotocol.com
  👄 手機B https://chuiprotocol.com
  🎛 封包面板 ${HUB_URL}/panel
DONE
else
  echo ""
  echo "仍不通——把下面整段貼回給 Claude："
  echo "--- workers domains ---"
  cf "${API}/accounts/${AID}/workers/domains?zone_id=${ZID}" | head -c 1500; echo
  echo "--- dns records ---"
  cf "${API}/zones/${ZID}/dns_records?name=${HUB_DOMAIN}" | head -c 1500; echo
  echo "--- healthz ---"
  curl -sv -m 8 "${HUB_URL}/healthz" 2>&1 | tail -12
fi
