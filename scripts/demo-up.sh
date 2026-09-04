#!/usr/bin/env bash
# 一鍵啟動 Chui demo 的五個服務（前景 log 各自寫到 .demo-logs/）。
# 用法：./scripts/demo-up.sh        （先 cp .env.example .env 並填好）
# 停止：./scripts/demo-down.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # 先自動修補：值含 & ? 空白等特殊字元卻沒加引號（例：Atlas 連線字串
  # 的 &w=majority）會讓 source 直接炸掉——一律補上單引號再載入。
  python3 - <<'EOF'
import re
from pathlib import Path
p = Path('.env')
lines = p.read_text().splitlines()
changed = False
out = []
for line in lines:
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    if m:
        key, val = m.group(1), m.group(2)
        needs_quote = (
            val and not (val.startswith("'") or val.startswith('"'))
            and re.search(r"[&?<>|;()\s#]", val)
        )
        if needs_quote and "'" not in val:
            line = f"{key}='{val}'"
            changed = True
    out.append(line)
if changed:
    p.write_text("\n".join(out) + "\n")
    print("已自動修補 .env：特殊字元的值補上引號（避免啟動報錯）")
EOF
  set -a; source .env; set +a
else
  echo "⚠️ 找不到 .env（cp .env.example .env 後填入），先用預設值啟動。"
fi

mkdir -p .demo-logs

echo "== 建置前端（三個站）=="
pnpm --filter @chui/storefront-template --filter @chui/merchant-a --filter @chui/voice-app build

start() { # name, port, command...
  # 注意：macOS 內建 bash 3.2 在 $var 後緊貼全形字元會解析錯誤，
  # 一律用 ${var} 且變數後面接 ASCII 字元。
  local name="$1"
  local port="$2"
  shift 2
  if python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"; then
    echo "  [skip] ${name} (port ${port} 已在跑)"
    return
  fi
  ("$@" >> ".demo-logs/${name}.log" 2>&1 &)
  echo "  [run]  ${name} -> http://localhost:${port} (log: .demo-logs/${name}.log)"
}

echo "== 啟動服務 =="
start hub          8700 python3 -m uvicorn chui_hub.main:app --port 8700 --host 0.0.0.0 --app-dir apps/hub
start merchant-a   9100 env PORT=9100 node apps/merchant-a/backend/server.js
start adapter-a    9101 env PORT=9101 node apps/merchant-a/adapter/server.js
start merchant-b   9201 env PORT=9201 node apps/storefront-template/server.js
start voice-app    9300 env PORT=9300 node apps/voice-app/server.js

sleep 2
echo ""
echo "== 健康檢查 =="
curl -s --noproxy 127.0.0.1 http://127.0.0.1:8700/healthz | python3 -m json.tool || echo "Hub 未就緒，查 .demo-logs/hub.log"
echo ""
echo "🎛  封包面板     http://localhost:8700/panel"
echo "🍗 快樂鹽酥雞   http://localhost:9100（adapter 接入）"
echo "🧋 好喝奶茶店   http://localhost:9201（公版店面，原生協議）"
echo "👄 語音入口     http://localhost:9300"
echo ""
echo "手機 demo（Slush 錢包）需要 https 對外網址，見 DEMO.md 的隧道章節。"
