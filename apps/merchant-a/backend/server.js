// 快樂鹽酥雞的「自家系統」後端。
//
// 刻意使用「非協議」格式：英文欄位、金額用 cents、mods 是扁平代碼——
// 模擬一家早就有 POS／點餐系統的店。這個後端完全不知道 Chui 的存在，
// 對協議的一切翻譯都發生在 adapter（adapter/server.js）。
// 同時服務官網（vite build 後的 dist/）。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9100);
const HUB_PUBLIC_URL = process.env.HUB_PUBLIC_URL || 'http://localhost:8700';

// ---- 自家菜單（legacy 格式：sku / label / cents / 扁平 mods）----
const PRODUCTS = [
  { sku: 'FC-001', label: '鹽酥雞', cents: 6500,
    mods: [{ code: 'SPICY', label: '加辣', extra_cents: 0 },
           { code: 'GARLIC', label: '加蒜', extra_cents: 1000 }] },
  { sku: 'FC-002', label: '甜不辣', cents: 4000,
    mods: [{ code: 'SPICY', label: '加辣', extra_cents: 0 }] },
  { sku: 'FC-003', label: '雞皮', cents: 3500,
    mods: [{ code: 'SPICY', label: '加辣', extra_cents: 0 }] },
  { sku: 'FC-004', label: '魷魚鬚', cents: 8000,
    mods: [{ code: 'SPICY', label: '加辣', extra_cents: 0 }] },
  { sku: 'FC-005', label: '地瓜薯條', cents: 4500, mods: [] },
  { sku: 'FC-006', label: '米血', cents: 3000,
    mods: [{ code: 'SPICY', label: '加辣', extra_cents: 0 },
           { code: 'GARLIC', label: '加蒜', extra_cents: 1000 }] },
];

const app = express();
app.use(express.json());

// demo 範圍：單據存記憶體
const tickets = new Map();

// 取餐單號：日期前綴＋落地持久化流水號（例 FC-0903-0001）。
// 流水號寫進檔案，重啟不歸零；跨日由日期前綴保證唯一——永不重複。
const SEQ_PATH = process.env.TICKET_SEQ_PATH || path.join(__dirname, '.ticket-seq.json');

function nextTicketNo(prefix) {
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

// ---- legacy API（這家店自己的格式，不是協議）----

app.get('/api/legacy/menu', (_req, res) => {
  res.json({ store: 'HAPPY FRIED CHICKEN', currency: 'TWD_CENTS', products: PRODUCTS });
});

app.post('/api/legacy/tickets', (req, res) => {
  const { items, memo } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(422).json({ err: 'ITEMS_REQUIRED' });
  }
  let totalCents = 0;
  for (const it of items) {
    const product = PRODUCTS.find((p) => p.sku === it.sku);
    if (!product) return res.status(422).json({ err: `UNKNOWN_SKU:${it.sku}` });
    let unit = product.cents;
    for (const code of it.mods ?? []) {
      const mod = product.mods.find((m) => m.code === code);
      if (!mod) return res.status(422).json({ err: `UNKNOWN_MOD:${code}` });
      unit += mod.extra_cents;
    }
    totalCents += unit * (it.qty ?? 1);
  }
  let ticketNo;
  try {
    ticketNo = nextTicketNo('FC');
  } catch (err) {
    return res.status(500).json({ err: `TICKET_SEQ_FAILED:${err.message}` });
  }
  tickets.set(ticketNo, { ticket_no: ticketNo, items, memo: memo ?? '', total_cents: totalCents, paid: false });
  console.log(`🍗 [自家系統] 開單 ${ticketNo}，合計 ${totalCents} cents`);
  res.json({ ok: true, ticket_no: ticketNo, total_cents: totalCents });
});

app.post('/api/legacy/tickets/:no/settle_notify', (req, res) => {
  const ticket = tickets.get(req.params.no);
  if (!ticket) return res.status(404).json({ err: 'NO_TICKET' });
  ticket.paid = true;
  ticket.txid = req.body?.txid ?? '';
  console.log(`🍗 [自家系統] ${req.params.no} 已收款（txid=${ticket.txid}），下鍋！`);
  res.json({ ok: true });
});

app.get('/api/legacy/tickets', (_req, res) => {
  res.json({ tickets: [...tickets.values()] });
});

// ---- 官網前端執行期設定 ----
app.get('/app-config.json', (_req, res) => {
  res.json({ merchant_id: 'happy-chicken', hub_url: HUB_PUBLIC_URL });
});

// ---- 官網（自家網站）----
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
} else {
  app.get('/', (_req, res) => res
    .status(503)
    .send('官網尚未建置：請先執行 pnpm --filter @chui/merchant-a build'));
}

app.listen(PORT, () => {
  console.log(`快樂鹽酥雞（自家系統）啟動 http://localhost:${PORT}`);
});
