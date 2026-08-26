// chain-service HTTP 伺服器：只綁 localhost，由 FastAPI 以內部 token 呼叫。
// 絕不直接對外暴露。

import http from 'node:http';
import {
  buildMandateTx,
  buildRevokeTx,
  currentEpoch,
  executeSponsored,
  health,
  settle,
  verifySignature,
} from './sui.js';

const PORT = Number(process.env.CHAIN_SERVICE_PORT || 8788);
const HOST = process.env.CHAIN_SERVICE_HOST || '127.0.0.1';
const TOKEN = process.env.CHAIN_SERVICE_TOKEN || '';

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  'POST /internal/verify-signature': async (body) => ({ valid: await verifySignature(body) }),
  'POST /internal/mandate/build': async (body) => ({ txBytesB64: await buildMandateTx(body) }),
  'POST /internal/mandate/revoke/build': async (body) => ({ txBytesB64: await buildRevokeTx(body) }),
  'POST /internal/execute': async (body) => executeSponsored(body),
  'POST /internal/settle': async (body) => settle(body),
  'GET /internal/health': async () => health(),
  'GET /internal/epoch': async () => ({ epoch: await currentEpoch() }),
};

const server = http.createServer(async (req, res) => {
  // 內部 token 驗證：token 未設定時拒絕所有請求（安全預設）
  const auth = req.headers.authorization || '';
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return send(res, 401, { code: 'AUTH_REQUIRED', message: 'chain-service 內部 token 無效或未設定' });
  }
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const handler = routes[key];
  if (!handler) {
    return send(res, 404, { code: 'NOT_FOUND', message: `無此路由：${key}` });
  }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = await handler(body);
    return send(res, 200, result);
  } catch (error) {
    if (error.code === 'CHAIN_NOT_CONFIGURED') {
      return send(res, 503, { code: 'CHAIN_NOT_CONFIGURED', message: error.message });
    }
    return send(res, 502, {
      code: 'CHAIN_ERROR',
      message: error.message,
      move_abort: error.moveAbort || '',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`chain-service 監聽 http://${HOST}:${PORT}（network 由 SUI_NETWORK 決定）`);
});
