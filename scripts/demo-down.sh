#!/usr/bin/env bash
# 停掉 demo-up.sh 啟動的服務。
pkill -f "uvicorn chui_hub.main" 2>/dev/null || true
pkill -f "apps/merchant-a/backend/server.js" 2>/dev/null || true
pkill -f "apps/merchant-a/adapter/server.js" 2>/dev/null || true
pkill -f "apps/storefront-template/server.js" 2>/dev/null || true
pkill -f "apps/voice-app/server.js" 2>/dev/null || true
echo "已送出停止訊號。"
