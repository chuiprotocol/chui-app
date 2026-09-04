#!/usr/bin/env bash
# 容器內啟動：三個商家服務背景跑、Hub 前景跑（PID 1，平台監控它）。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .demo-logs

env PORT=9100 node apps/merchant-a/backend/server.js >> .demo-logs/merchant-a.log 2>&1 &
env PORT=9101 node apps/merchant-a/adapter/server.js >> .demo-logs/adapter-a.log 2>&1 &
env PORT=9201 node apps/storefront-template/server.js >> .demo-logs/merchant-b.log 2>&1 &

exec python3 -m uvicorn chui_hub.main:app --host 0.0.0.0 --port "${PORT:-8700}" --app-dir apps/hub
