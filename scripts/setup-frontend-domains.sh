#!/usr/bin/env bash
# setup-frontend-domains.sh —— 兩個前端一鍵綁上自有網域：
#   👄 嘴付公版入口  chui-portal        → chuiprotocol.com（＋www）
#   🍗 快樂鹽酥雞官網 chui-happy-chicken → happy-chicken.chuiprotocol.com
# 舊的 *.pages.dev 網址仍然有效（不會壞）。
#
# 前提：API token 需要三種權限（可沿用 setup-worker 的 token「再加一列」）：
#   Account / Cloudflare Pages / Edit ＋ Zone / DNS / Edit ＋（原有 Workers）
#   沒有 Pages 權限時本腳本會明確告訴你去 token 加哪一列。
# 用法：
#   export CLOUDFLARE_API_TOKEN=貼上token
#   cd ~/chui-app && git pull && ./scripts/setup-frontend-domains.sh
# 重跑安全：已綁的網域自動跳過。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ setup-frontend-domains 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

ZONE_NAME="chuiprotocol.com"
API="https://api.cloudflare.com/client/v4"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "缺 CLOUDFLARE_API_TOKEN——export 後再跑"
cf() { curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$@"; }

say "1/3 檢查 token／zone／帳號"
cf "${API}/user/tokens/verify" | grep -q '"status":"active"' || die "token 驗證失敗"
ZID="$(cf "${API}/zones?name=${ZONE_NAME}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result") or []; print(r[0]["id"] if r else "")')"
[ -n "${ZID}" ] || die "token 看不到 zone ${ZONE_NAME}——token 需要 Zone/DNS/Edit"
AID="$(cf "${API}/zones/${ZID}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["account"]["id"])')"
echo "zone=${ZID} account=${AID}"

# 綁一組：Pages 專案 + hostname + DNS CNAME（proxied；root 由 CF 自動壓平）
bind() {
  local project="$1" hostname="$2"
  say "綁 ${hostname} → ${project}"
  local resp
  resp="$(cf -X POST "${API}/accounts/${AID}/pages/projects/${project}/domains" \
    -H "Content-Type: application/json" --data "{\"name\":\"${hostname}\"}")"
  echo "${resp}" | python3 -c 'import json,sys
d=json.load(sys.stdin)
if d.get("success"):
    print("✅ Pages 已登記")
else:
    errs=d.get("errors") or []
    codes=[e.get("code") for e in errs]
    msg="；".join(str(e.get("message","")) for e in errs)
    if any(c in (8000015,) for c in codes) or "already" in msg.lower():
        print("✅ 先前已登記，跳過")
    elif any(c in (10000,9109,10001) for c in codes) or "auth" in msg.lower():
        raise SystemExit("TOKEN_NO_PAGES")
    else:
        raise SystemExit("API 錯誤：" + msg)' \
  || { [ $? -eq 1 ] && die "token 沒有 Pages 權限——到 dash.cloudflare.com/profile/api-tokens 編輯這把 token，加一列「Account / Cloudflare Pages / Edit」後重跑" || die "Pages domains API 失敗（見上）"; }

  # DNS：同名既有記錄若不是指向 pages.dev 就不動（避免誤刪用戶自設的東西）
  local existing
  existing="$(cf "${API}/zones/${ZID}/dns_records?name=${hostname}" \
    | python3 -c 'import json,sys
rows=json.load(sys.stdin).get("result") or []
keep=[x for x in rows if "pages.dev" not in str(x.get("content",""))]
have=[x for x in rows if "pages.dev" in str(x.get("content",""))]
print("HAVE" if have else ("BLOCKED:" + "，".join("%s→%s" % (x["type"], x.get("content","")) for x in keep) if keep else "NONE"))')"
  case "${existing}" in
    HAVE) echo "✅ DNS 已指向 Pages" ;;
    NONE)
      cf -X POST "${API}/zones/${ZID}/dns_records" -H "Content-Type: application/json" \
        --data "{\"type\":\"CNAME\",\"name\":\"${hostname}\",\"content\":\"${project}.pages.dev\",\"proxied\":true}" \
        | grep -q '"success":true' && echo "✅ DNS CNAME 已建立" || die "建 DNS 記錄失敗（${hostname}）"
      ;;
    BLOCKED:*)
      echo "⚠️ ${hostname} 已有別的 DNS 記錄（${existing#BLOCKED:}）——不敢動；"
      echo "   若確定不需要，請到儀表板刪掉後重跑本腳本。"
      ;;
  esac
}

say "2/3 逐一綁定"
bind chui-portal        "${ZONE_NAME}"
bind chui-portal        "www.${ZONE_NAME}"
bind chui-happy-chicken "happy-chicken.${ZONE_NAME}"

say "3/3 驗證（等憑證簽發，最多 3 分鐘）"
ok() { curl -s -o /dev/null -w '%{http_code}' -m 6 "https://$1" | grep -q "200"; }
for i in $(seq 1 60); do
  ok "${ZONE_NAME}" && ok "happy-chicken.${ZONE_NAME}" && break
  sleep 3
done
if ok "${ZONE_NAME}" && ok "happy-chicken.${ZONE_NAME}"; then
  cat <<DONE

✅ 全部綁好，正式網址（舊 pages.dev 也仍可用）：
  👄 嘴付入口     https://${ZONE_NAME}（www 也通）
  🍗 快樂鹽酥雞   https://happy-chicken.${ZONE_NAME}
  🏦 後端 Hub     https://hub.${ZONE_NAME}
DONE
else
  echo "⚠️ 已綁定但憑證可能還在簽——過幾分鐘用瀏覽器開 https://${ZONE_NAME} 確認；仍不通就把輸出貼回給 Claude"
fi
