#!/usr/bin/env bash
# setup-atlas.sh —— 把 MongoDB Atlas 接上 Hub（訂單持久化），一條指令完成：
#   1. 實連 Atlas 驗證連線字串（帳密錯、白名單沒開會當場告訴你）
#   2. 寫入 .env（MONGODB_URI）
#   3. 重啟後端並確認 healthz 顯示 order_store=mongodb-atlas
#
# 用法：./scripts/setup-atlas.sh 'mongodb+srv://帳:密@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority'
#（連線字串從 Atlas 後台 Connect → Drivers 複製；記得整串用「單引號」包住）
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$1"; exit 1; }
set -o errtrace
trap 'printf "\n\033[1;31m❌ setup-atlas 在第 %s 行失敗：%s\033[0m\n" "${LINENO}" "${BASH_COMMAND}"' ERR

URI="${1:-}"
[ -n "${URI}" ] || die "用法：./scripts/setup-atlas.sh '<Atlas 連線字串>'（整串用單引號包住）"
[ -f .env ] || die "找不到 .env——請先跑 ./scripts/go-live.sh"
case "${URI}" in mongodb://*|mongodb+srv://*) ;; *) die "這不像 Mongo 連線字串（要以 mongodb:// 或 mongodb+srv:// 開頭）" ;; esac

echo "1/3 實連 Atlas 驗證…"
python3 -m pip show pymongo >/dev/null 2>&1 || python3 -m pip install -q 'pymongo>=4.7'
python3 - "${URI}" <<'EOF'
import sys
from pymongo import MongoClient
try:
    client = MongoClient(sys.argv[1], serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
except Exception as exc:
    print(f"連不上 Atlas：{exc}")
    print("常見原因：1) 帳密打錯 2) Network Access 白名單沒加你的 IP（demo 可加 0.0.0.0/0）")
    raise SystemExit(1)
print("✅ Atlas 連線成功")
EOF

echo "2/3 寫入 .env…"
python3 - "${URI}" <<'EOF'
import re, sys
from pathlib import Path
uri = sys.argv[1]
if "'" in uri:
    raise SystemExit("連線字串含單引號，請先把密碼裡的 ' 換掉（Atlas 可重生密碼）")
# 一律寫成單引號包裹：URI 裡的 & 會讓 shell source 直接炸掉
line = f"MONGODB_URI='{uri}'"
p = Path('.env')
t = p.read_text()
if re.search(r'(?m)^MONGODB_URI=', t):
    t = re.sub(r'(?m)^MONGODB_URI=.*$', line, t)
else:
    t = t.rstrip('\n') + f'\n{line}\n'
p.write_text(t)
print('✅ 已寫入 .env：MONGODB_URI（帳密只在你機器，不進 git）')
EOF

echo "3/3 重啟後端並驗證…"
./scripts/demo-down.sh >/dev/null 2>&1 || true
./scripts/demo-up.sh >/dev/null
for i in $(seq 1 15); do
  backend=$(curl -s --noproxy 127.0.0.1 http://127.0.0.1:8700/healthz \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('order_store',''))" 2>/dev/null || true)
  [ "${backend}" = "mongodb-atlas" ] && break
  sleep 2
done
[ "${backend:-}" = "mongodb-atlas" ] \
  || die "Hub 起來了但 order_store=${backend:-讀不到}——看 .demo-logs/hub.log"

echo ""
echo "✅ 完成！訂單現在存 MongoDB Atlas，Hub 重啟不掉單。"
echo "   （隧道還活著的話手機網址不變；需要重印網址：./scripts/urls.sh）"
