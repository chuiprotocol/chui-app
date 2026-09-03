// 嘴付協議 adapter：把 Chui 協議訊息翻譯成快樂鹽酥雞自家系統的格式。
//
// 這個行程證明「已有自己系統的店不用改一行舊程式碼就能接上協議」：
//   GET  /chui/menu          ← 抓 legacy 菜單，翻成協議格式（cents→元、mods→選項組、補同義詞）
//   POST /chui/orders        ← 協議訂單翻成 legacy ticket（item_id→sku、選項→mod codes）
//   POST /chui/orders/:id/paid ← 翻成 legacy settle_notify
// 翻譯對照表在 mapping.json——整合者只要維護那份 JSON。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9101);
const LEGACY_URL = process.env.LEGACY_URL || 'http://127.0.0.1:9100';

const mapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapping.json'), 'utf8'));

const app = express();
app.use(express.json());

// order_id ↔ legacy ticket_no 的對照（demo 存記憶體）
const ticketByOrder = new Map();

function centsToTwd(cents, context) {
  // 協議金額是整數「元」；legacy 用 cents。不是 100 的倍數就是資料錯誤，直接擋下。
  if (!Number.isInteger(cents) || cents % 100 !== 0) {
    throw new Error(`legacy 金額 ${cents} cents 無法整除成元（${context}）`);
  }
  return cents / 100;
}

// ---- 協議菜單（翻譯自 legacy）----

app.get('/chui/menu', async (_req, res) => {
  try {
    const resp = await fetch(`${LEGACY_URL}/api/legacy/menu`);
    if (!resp.ok) throw new Error(`legacy 後端回 ${resp.status}`);
    const legacy = await resp.json();
    const items = legacy.products.map((product) => {
      const itemMap = mapping.items[product.sku];
      if (!itemMap) throw new Error(`mapping.json 缺少 sku ${product.sku}`);
      return {
        id: itemMap.id,
        name: product.label,
        base_price: centsToTwd(product.cents, product.sku),
        synonyms: itemMap.synonyms,
        options: product.mods.map((mod) => {
          const modMap = mapping.mods[mod.code];
          if (!modMap) throw new Error(`mapping.json 缺少 mod ${mod.code}`);
          return {
            id: modMap.option_id,
            name: modMap.option_name,
            required: false,
            default: modMap.no_choice.id,
            choices: [
              { ...modMap.no_choice, price_delta: 0 },
              { ...modMap.yes_choice, price_delta: centsToTwd(mod.extra_cents, mod.code) },
            ],
          };
        }),
      };
    });
    res.json({ menu_version: `legacy-${Date.now() >> 16}`, currency: 'TWD', items });
  } catch (err) {
    res.status(502).json({ error: { code: 'ADAPTER_MENU_FAILED', message: String(err.message) } });
  }
});

// ---- 協議接單 → legacy 開單 ----

app.post('/chui/orders', async (req, res) => {
  try {
    const order = req.body ?? {};
    const skuById = Object.fromEntries(
      Object.entries(mapping.items).map(([sku, m]) => [m.id, sku]),
    );
    const items = order.lines.map((line) => {
      const sku = skuById[line.item_id];
      if (!sku) throw new Error(`mapping.json 對不到品項 ${line.item_id}`);
      const mods = [];
      for (const [optionId, choiceId] of Object.entries(line.options ?? {})) {
        const modEntry = Object.entries(mapping.mods)
          .find(([, m]) => m.option_id === optionId);
        if (modEntry && choiceId === modEntry[1].yes_choice.id) mods.push(modEntry[0]);
      }
      return { sku, qty: line.qty, mods };
    });
    const resp = await fetch(`${LEGACY_URL}/api/legacy/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, memo: `Chui ${order.order_id}` }),
    });
    const body = await resp.json();
    if (!resp.ok || !body.ok) throw new Error(`legacy 開單失敗：${JSON.stringify(body)}`);
    // 對帳防線：legacy 算出來的總額必須等於協議報價
    const legacyTwd = centsToTwd(body.total_cents, body.ticket_no);
    if (legacyTwd !== order.total) {
      throw new Error(`金額不一致：協議 ${order.total} 元 ≠ legacy ${legacyTwd} 元`);
    }
    ticketByOrder.set(order.order_id, body.ticket_no);
    console.log(`🔁 [adapter] ${order.order_id} → 開單 ${body.ticket_no}`);
    res.json({ accepted: true, merchant_ref: body.ticket_no });
  } catch (err) {
    res.status(502).json({ accepted: false, error: { code: 'ADAPTER_ORDER_FAILED', message: String(err.message) } });
  }
});

// ---- 協議收款通知 → legacy settle_notify ----

app.post('/chui/orders/:orderId/paid', async (req, res) => {
  const ticketNo = ticketByOrder.get(req.params.orderId);
  if (!ticketNo) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '找不到對應的 legacy 單據' } });
  }
  try {
    await fetch(`${LEGACY_URL}/api/legacy/tickets/${ticketNo}/settle_notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid: req.body?.tx_digest ?? '' }),
    });
    console.log(`🔁 [adapter] 收款通知 → ${ticketNo}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: { code: 'ADAPTER_NOTIFY_FAILED', message: String(err.message) } });
  }
});

app.listen(PORT, () => {
  console.log(`嘴付協議 adapter 啟動 http://localhost:${PORT} →（翻譯）→ ${LEGACY_URL}`);
});
