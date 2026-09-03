#!/usr/bin/env bash
# go-live.sh —— 在「你的電腦」上一條指令完成上線前的全部步驟：
#   1. 安裝 sui CLI（缺才裝）＋ 建立/切換 testnet 錢包 ＋ 自動領 gas
#   2. 部署 chui::vault 合約（會先跑 Move 測試）→ 自動把 CHUI_PACKAGE_ID 寫進 .env
#   3. 準備 .env（缺 STT_API_KEY 會提示輸入）
#   4. 安裝相依 ＋ 啟動後端整包（Hub＋兩家商家）
#   5. 安裝 cloudflared（缺才裝）＋ 開隧道公開 Hub
#   6. 印出兩支手機要開的最終網址（已帶 ?hub=）
#
# 用法：./scripts/go-live.sh
# 重跑安全：每一步都會先檢查是否已完成，已完成就跳過。
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\n\033[1;35m== %s ==\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }

# ---------- 0. 基本工具 ----------
say "0/6 檢查基本工具"
command -v node >/dev/null || die "需要 Node.js 18+（https://nodejs.org）"
command -v pnpm >/dev/null || npm install -g pnpm
command -v python3 >/dev/null || die "需要 Python 3.11+"
pnpm install
python3 -m pip install -q -r apps/api/requirements.txt

# ---------- 1. sui CLI ----------
say "1/6 sui CLI 與 testnet 錢包"
if ! command -v sui >/dev/null; then
  echo "安裝 sui CLI（經 suiup）…"
  curl -sSfL https://raw.githubusercontent.com/Mystenlabs/suiup/main/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  suiup install sui@testnet
fi
sui --version

# 建立設定與地址（--yes 全用預設，非互動）
sui client --yes envs >/dev/null 2>&1 || true
if ! sui client envs 2>/dev/null | grep -q testnet; then
  sui client --yes new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443
fi
sui client switch --env testnet >/dev/null
DEPLOYER=$(sui client active-address)
echo "部署地址：$DEPLOYER"

# gas：先試 CLI faucet，失敗就引導網頁 faucet 並等待
has_gas() { sui client gas --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d else 1)"; }
if ! has_gas; then
  echo "領取 Testnet SUI（gas）…"
  sui client faucet 2>/dev/null || echo "CLI faucet 失敗，請到 https://faucet.sui.io 貼上 $DEPLOYER 領取"
  for i in $(seq 1 60); do
    has_gas && break
    sleep 3
    [ "$i" = 60 ] && die "等不到 gas。請到 https://faucet.sui.io 領取後重跑本腳本"
  done
fi
echo "✅ gas OK"

# ---------- 2. 部署合約 ----------
say "2/6 部署 chui::vault 合約"
[ -f .env ] || cp .env.example .env
current_pkg=$(grep '^CHUI_PACKAGE_ID=' .env | cut -d= -f2-)
if [ -n "$current_pkg" ]; then
  echo "✅ .env 已有 CHUI_PACKAGE_ID=$current_pkg，跳過部署（要重佈署請先清空該行）"
else
  CONTRACTS_DIR=""
  for c in ../chui-contracts ./chui-contracts "$HOME/chui-contracts"; do
    [ -d "$c/contracts/sui" ] && CONTRACTS_DIR="$c" && break
  done
  if [ -z "$CONTRACTS_DIR" ]; then
    echo "找不到 chui-contracts，clone 中…"
    git clone https://github.com/chuiprotocol/chui-contracts ../chui-contracts
    CONTRACTS_DIR=../chui-contracts
  fi
  (cd "$CONTRACTS_DIR/contracts/sui" && ./deploy.sh)   # 內含 sui move test
  PKG=$(python3 -c "import json; print(json.load(open('$CONTRACTS_DIR/deployments/testnet.json'))['package_id'])")
  python3 - "$PKG" <<'EOF'
import re, sys
from pathlib import Path
pkg = sys.argv[1]
p = Path('.env')
t = p.read_text()
t = re.sub(r'(?m)^CHUI_PACKAGE_ID=.*$', f'CHUI_PACKAGE_ID={pkg}', t)
p.write_text(t)
print(f'✅ 已寫入 .env：CHUI_PACKAGE_ID={pkg}')
EOF
fi

# ---------- 3. STT key ----------
say "3/6 語音辨識金鑰"
stt=$(grep '^STT_API_KEY=' .env | cut -d= -f2-)
if [ -z "$stt" ]; then
  printf "貼上 OpenAI API key（直接 Enter 跳過＝語音停用、只能打字）："
  read -r key
  if [ -n "$key" ]; then
    python3 - "$key" <<'EOF'
import re, sys
from pathlib import Path
p = Path('.env')
t = re.sub(r'(?m)^STT_API_KEY=.*$', f'STT_API_KEY={sys.argv[1]}', p.read_text())
p.write_text(t)
print('✅ 已寫入 STT_API_KEY')
EOF
  else
    echo "⚠️ 略過：語音輸入將回報明確錯誤，打字備援可用"
  fi
fi

# ---------- 4. 啟動後端 ----------
say "4/6 啟動後端整包"
./scripts/demo-up.sh

# ---------- 5. cloudflared 隧道 ----------
say "5/6 公開 Hub（cloudflared 隧道）"
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
if [ -f .demo-logs/tunnel-url.txt ] && curl -s -m 5 "$(cat .demo-logs/tunnel-url.txt)/healthz" | grep -q '"ok"'; then
  HUB_URL=$(cat .demo-logs/tunnel-url.txt)
  echo "✅ 既有隧道仍存活：$HUB_URL"
else
  (cloudflared tunnel --url http://localhost:8700 > .demo-logs/tunnel.log 2>&1 &)
  HUB_URL=""
  for i in $(seq 1 30); do
    HUB_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .demo-logs/tunnel.log | head -1 || true)
    [ -n "$HUB_URL" ] && break
    sleep 1
  done
  [ -n "$HUB_URL" ] || die "隧道啟動失敗，看 .demo-logs/tunnel.log"
  echo "$HUB_URL" > .demo-logs/tunnel-url.txt
fi

# ---------- 6. 最終網址 ----------
say "6/6 完成！手機（Slush 內建瀏覽器）開這兩個網址"
cat <<URLS | tee demo-urls.txt

🍗 快樂鹽酥雞官網（手機A）：
   https://chui-happy-chicken.pages.dev/?hub=$HUB_URL

👄 嘴付公版入口（手機B，進去點「好喝奶茶店」）：
   https://chui-portal.pages.dev/?hub=$HUB_URL

🎛 協議封包面板（投影用）：
   $HUB_URL/panel

（?hub= 只需帶第一次，之後手機直接開原網址即可。
 隧道網址每次重跑會變；重跑本腳本會自動沿用仍存活的隧道。）
URLS
