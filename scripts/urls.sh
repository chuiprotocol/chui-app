#!/usr/bin/env bash
# urls.sh —— 確保隧道活著並印出「兩支手機要開的最終網址」（帶 ?hub=）。
# 可獨立執行：./scripts/urls.sh（go-live.sh 的第 5、6 步也是呼叫這支）。
# 前提：本機 Hub 已在跑（./scripts/demo-up.sh）。
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }

# 本機 Hub 不在跑的話，隧道通了也沒用——先講清楚
if ! curl -s -m 3 --noproxy 127.0.0.1 http://127.0.0.1:8700/healthz | grep -q '"ok"'; then
  die "本機 Hub（localhost:8700）沒在跑。先執行 ./scripts/demo-up.sh 再跑本腳本"
fi

if ! command -v cloudflared >/dev/null; then
  echo "安裝 cloudflared…"
  case "$(uname -s)" in
    Darwin) command -v brew >/dev/null && brew install cloudflared \
            || die "請先裝 Homebrew 或手動安裝 cloudflared" ;;
    Linux)  curl -sSL -o /tmp/cloudflared \
              https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
            && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared ;;
    *) die "不支援的作業系統，請手動安裝 cloudflared" ;;
  esac
fi

mkdir -p .demo-logs
HUB_URL=""

# 優先：固定 Named Tunnel（跑過 ./scripts/setup-tunnel.sh 就有設定檔）
if [ -f .cloudflared-chui.yml ]; then
  FIXED_HOST=$(grep 'hostname:' .cloudflared-chui.yml | head -1 | awk '{print $3}')
  FIXED_URL="https://${FIXED_HOST}"
  if ! curl -s -m 5 "${FIXED_URL}/healthz" | grep -q '"ok"'; then
    echo "啟動固定隧道（${FIXED_HOST}）…"
    (cloudflared tunnel --config .cloudflared-chui.yml run > .demo-logs/tunnel.log 2>&1 &)
    for i in $(seq 1 30); do
      curl -s -m 5 "${FIXED_URL}/healthz" | grep -q '"ok"' && break
      sleep 2
    done
  fi
  if curl -s -m 5 "${FIXED_URL}/healthz" | grep -q '"ok"'; then
    HUB_URL="${FIXED_URL}"
    echo "✅ 固定隧道存活：${HUB_URL}（永久網址）"
  else
    echo "⚠️ 固定隧道起不來（看 .demo-logs/tunnel.log），退回免費快速隧道…"
  fi
fi

if [ -z "${HUB_URL}" ] && [ -f .demo-logs/tunnel-url.txt ]; then
  candidate=$(cat .demo-logs/tunnel-url.txt)
  if curl -s -m 5 "${candidate}/healthz" | grep -q '"ok"'; then
    HUB_URL="${candidate}"
    echo "✅ 既有隧道仍存活：${HUB_URL}"
  fi
fi
if [ -z "${HUB_URL}" ]; then
  echo "開新隧道…"
  (cloudflared tunnel --url http://localhost:8700 > .demo-logs/tunnel.log 2>&1 &)
  for i in $(seq 1 30); do
    # -a：cloudflared 的 log 夾雜非文字位元組時，grep 會改印
    # 「Binary file … matches」——這串字曾被當成網址塞進 ?hub=。
    # 一律強制當文字處理，且抽出的字串必須真的是 trycloudflare 網址。
    HUB_URL=$(grep -a -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .demo-logs/tunnel.log | head -1 || true)
    [ -n "${HUB_URL}" ] && break
    sleep 1
  done
  case "${HUB_URL}" in
    https://*.trycloudflare.com) ;;
    *) echo "--- tunnel.log 最後 20 行 ---"; tail -20 .demo-logs/tunnel.log
       die "隧道啟動失敗（沒抽到合法網址），完整 log：.demo-logs/tunnel.log" ;;
  esac
  # 等隧道真的通（DNS 生效可能要幾秒），最多 30 秒
  for i in $(seq 1 30); do
    curl -s -m 5 "${HUB_URL}/healthz" | grep -q '"ok"' && break
    sleep 1
  done
  echo "${HUB_URL}" > .demo-logs/tunnel-url.txt
fi

say "手機（Slush 內建瀏覽器）開這兩個網址"
cat <<URLS | tee demo-urls.txt

🍗 快樂鹽酥雞官網（手機A）：
   https://chui-happy-chicken.pages.dev/?hub=${HUB_URL}

👄 嘴付公版入口（手機B，進去點「好喝奶茶店」）：
   https://chui-portal.pages.dev/?hub=${HUB_URL}

🎛 協議封包面板（投影用）：
   ${HUB_URL}/panel

（?hub= 只需帶第一次，之後手機直接開原網址即可。
 隧道網址每次重跑會變；隨時可單獨執行 ./scripts/urls.sh 重印最新網址。）
URLS
