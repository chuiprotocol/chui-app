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
# 任何一行失敗都明確報出行號與指令——不再無聲中斷、走不到印網址那步
# （errtrace：子 shell／函式內的失敗也要觸發 trap）
set -o errtrace
trap 'printf "\n\033[1;31m❌ go-live 在第 %s 行失敗：%s\n   請把這段訊息貼回給我們排查\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

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

# Testnet 的 protocol 版本前進很快，CLI 太舊會讓合約發佈失敗——
# brew 裝的 sui 有新版就自動升級（實測 1.68/protocol 118 已發不上 protocol 136 的網路）
if command -v brew >/dev/null && brew list --versions sui >/dev/null 2>&1; then
  if [ -n "$(brew outdated --quiet sui 2>/dev/null || true)" ]; then
    echo "sui CLI 有新版，自動升級中（發佈合約需要跟上 Testnet protocol）…"
    brew upgrade sui || echo "⚠️ 自動升級失敗——若稍後發佈合約失敗，請手動執行 brew upgrade sui"
    sui --version
  fi
fi

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
# 內部測試匯率一律矯正為 1538（舊 .env 可能殘留 32000，會把 40 元算成 1.28 USDC）
python3 - <<'EOF'
import re
from pathlib import Path
p = Path('.env')
t = p.read_text()
if re.search(r'(?m)^USDC_UNITS_PER_TWD=', t):
    t2 = re.sub(r'(?m)^USDC_UNITS_PER_TWD=.*$', 'USDC_UNITS_PER_TWD=1538', t)
else:
    t2 = t.rstrip('\n') + '\nUSDC_UNITS_PER_TWD=1538\n'
if t2 != t:
    p.write_text(t2)
    print('✅ .env 匯率已矯正：USDC_UNITS_PER_TWD=1538（內部測試）')
EOF
# ⚠️ vault 合約在 chui-contracts 的 main 分支（repo 預設分支可能指向
#    另一套舊架構的合約），一律鎖定 main。
CONTRACTS_DIR=""
for c in ../chui-contracts ./chui-contracts "$HOME/chui-contracts"; do
  [ -d "$c/.git" ] && CONTRACTS_DIR="$c" && break
done
if [ -z "$CONTRACTS_DIR" ]; then
  echo "找不到 chui-contracts，clone（main 分支）中…"
  git clone --branch main https://github.com/chuiprotocol/chui-contracts ../chui-contracts
  CONTRACTS_DIR=../chui-contracts
fi
echo "同步 chui-contracts 到最新 main…"
git -C "$CONTRACTS_DIR" fetch origin main
git -C "$CONTRACTS_DIR" checkout -B main origin/main
[ -d "$CONTRACTS_DIR/contracts/sui" ] || die "chui-contracts 的 main 分支沒有 contracts/sui——請回報"

# 合約版本變了（例如新增 log_policy）就自動重佈署；沒變且已有 package 就跳過
# （grep 找不到該行時不可讓 set -e 無聲終止腳本——一律 || true）
current_pkg=$(grep '^CHUI_PACKAGE_ID=' .env | cut -d= -f2- || true)
current_rev=$(grep '^CHUI_CONTRACTS_REV=' .env | cut -d= -f2- || true)
head_rev=$(git -C "$CONTRACTS_DIR" rev-parse HEAD)
if [ -n "$current_pkg" ] && [ "$current_rev" = "$head_rev" ]; then
  echo "✅ 合約無變更（${head_rev:0:8}），沿用 CHUI_PACKAGE_ID=${current_pkg}"
else
  # 注意：macOS bash 3.2 對「$var 後緊貼全形字元」會解析錯誤，一律用 ${var}
  [ -n "${current_pkg}" ] && echo "合約已更新（${current_rev} -> ${head_rev}），重佈署…"
  (cd "$CONTRACTS_DIR/contracts/sui" && ./deploy.sh)   # 內含 sui move test
  PKG=$(python3 -c "import json; print(json.load(open('$CONTRACTS_DIR/deployments/testnet.json'))['package_id'])")
  python3 - "$PKG" "$head_rev" <<'EOF'
import re, sys
from pathlib import Path
pkg, rev = sys.argv[1], sys.argv[2]
p = Path('.env')
t = p.read_text()

def upsert(text, key, value):
    """該行存在就替換、不存在就補上——絕不無聲跳過。"""
    if re.search(rf'(?m)^{key}=', text):
        return re.sub(rf'(?m)^{key}=.*$', f'{key}={value}', text)
    return text.rstrip('\n') + f'\n{key}={value}\n'

t = upsert(t, 'CHUI_PACKAGE_ID', pkg)
t = upsert(t, 'CHUI_CONTRACTS_REV', rev)
p.write_text(t)
print(f'✅ 已寫入 .env：CHUI_PACKAGE_ID={pkg}（rev {rev[:8]}）')
EOF
  echo "⚠️ 合約重佈署＝新 package：手機上先前的授權會失效，請重新授權（舊 Vault 的錢可用舊 explorer 領回）"
fi

# ---------- 3. STT key ----------
say "3/6 語音辨識金鑰"
stt=$(grep '^STT_API_KEY=' .env | cut -d= -f2- || true)
if [ -z "$stt" ]; then
  printf "貼上 OpenAI API key（直接 Enter 跳過＝語音停用、只能打字）："
  read -r key
  if [ -n "$key" ]; then
    python3 - "$key" <<'EOF'
import re, sys
from pathlib import Path
p = Path('.env')
t = p.read_text()
if re.search(r'(?m)^STT_API_KEY=', t):
    t = re.sub(r'(?m)^STT_API_KEY=.*$', f'STT_API_KEY={sys.argv[1]}', t)
else:
    t = t.rstrip('\n') + f'\nSTT_API_KEY={sys.argv[1]}\n'
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

# ---------- 5+6. 隧道＋最終網址（可獨立重跑：./scripts/urls.sh）----------
say "5/6 公開 Hub（cloudflared 隧道）＋ 6/6 最終網址"
./scripts/urls.sh
