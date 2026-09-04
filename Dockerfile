# Chui 後端整包（單容器）：Hub＋商家A legacy＋adapter＋商家B 公版。
# 服務間走容器內 127.0.0.1（merchants.json 原封不動），只對外開 Hub。
# 環境變數（CHUI_PACKAGE_ID、STT_API_KEY…）由平台注入（fly secrets）。
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --prod --ignore-scripts \
  && pip3 install --break-system-packages --no-cache-dir -r apps/api/requirements.txt

ENV PORT=8700
EXPOSE 8700
CMD ["bash", "scripts/cloud-start.sh"]
