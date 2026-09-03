// 公版商家伺服器：一個行程同時提供
//   1. 商家端協議介面（/chui/*，原生實作，見 PROTOCOL.md）
//   2. 店面網頁（vite build 後的 dist/）
//   3. /app-config.json（前端執行期設定）
// 開一家新店 = 換一個 CONFIG_PATH，不改程式碼。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'goodtea.json');
const PORT = Number(process.env.PORT || 9201);
const HUB_PUBLIC_URL = process.env.HUB_PUBLIC_URL || 'http://localhost:8700';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
console.log(`公版店面啟動：${config.shop.name}（merchant_id=${config.merchant_id}）`);

const app = express();
app.use(express.json());

// demo 範圍：訂單內容存記憶體（無登入需求）
const orders = new Map();

// 取餐單號：日期前綴＋落地持久化流水號（例 TEA-0903-0001）。
// 流水號寫進檔案，重啟不歸零；跨日由日期前綴保證唯一——永不重複。
const SEQ_PATH = process.env.TICKET_SEQ_PATH
  || path.join(path.dirname(CONFIG_PATH), `.ticket-seq-${config.merchant_id}.json`);

function nextOrderRef(prefix) {
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  let state = { date: today, seq: 0 };
  try {
    const stored = JSON.parse(fs.readFileSync(SEQ_PATH, 'utf8'));
    if (stored.date === today && Number.isInteger(stored.seq)) state = stored;
  } catch { /* 首次使用或檔案損毀：從 0 起算（日期前綴仍保證跨日唯一） */ }
  state.seq += 1;
  fs.writeFileSync(SEQ_PATH, JSON.stringify(state));
  return `${prefix}-${today}-${String(state.seq).padStart(4, '0')}`;
}

// ---- 商家端協議介面（原生）----

app.get('/chui/menu', (_req, res) => {
  res.json(config.menu);
});

app.post('/chui/orders', (req, res) => {
  const order = req.body ?? {};
  if (!order.order_id || !Array.isArray(order.lines) || !Number.isInteger(order.total)) {
    return res.status(422).json({ error: { code: 'BAD_ORDER', message: '訂單格式不符協議' } });
  }
  let merchantRef;
  try {
    merchantRef = nextOrderRef(config.order_ref_prefix || 'ORD');
  } catch (err) {
    return res.status(500).json({ error: { code: 'TICKET_SEQ_FAILED', message: String(err.message) } });
  }
  orders.set(order.order_id, { ...order, merchant_ref: merchantRef, paid: false });
  console.log(`🧾 接單 ${merchantRef}：${order.lines.map((l) => `${l.name}x${l.qty}`).join('、')}（${order.total} 元）`);
  res.json({ accepted: true, merchant_ref: merchantRef });
});

app.post('/chui/orders/:orderId/paid', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '沒有這筆訂單' } });
  }
  order.paid = true;
  order.tx_digest = req.body?.tx_digest ?? '';
  console.log(`💰 已收款，請出餐！${order.merchant_ref}（${req.body?.explorer_url ?? ''}）`);
  res.json({ ok: true });
});

// 店內出餐畫面用：目前訂單列表（協議之外的店家自用介面）
app.get('/shop/orders', (_req, res) => {
  res.json({ orders: [...orders.values()] });
});

// ---- 前端執行期設定 ----

app.get('/app-config.json', (_req, res) => {
  res.json({
    merchant_id: config.merchant_id,
    shop: config.shop,
    hub_url: HUB_PUBLIC_URL,
  });
});

// ---- 靜態店面 ----
const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
} else {
  app.get('/', (_req, res) => res
    .status(503)
    .send('店面尚未建置：請先執行 pnpm --filter @chui/storefront-template build'));
}

app.listen(PORT, () => {
  console.log(`  店面網址   http://localhost:${PORT}`);
  console.log(`  協議端點   http://localhost:${PORT}/chui/menu`);
  console.log(`  Hub        ${HUB_PUBLIC_URL}`);
});
