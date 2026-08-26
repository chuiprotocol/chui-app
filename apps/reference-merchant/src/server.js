// 快樂豬早餐店 LINE bot 伺服器。
//
// 鐵律：與 Chui 的所有互動只走 @chui/sdk（公開 SDK），
// 絕不 import Chui 的內部模組——證明第三方店家真的能介接。

import express from 'express';
import * as line from '@line/bot-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '@chui/sdk';
import { createBot } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 必要環境變數（缺了就直接報錯，不啞火）----
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少環境變數 ${name}（見 .env.example）`);
  return value;
}

const LINE_CHANNEL_ACCESS_TOKEN = requireEnv('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = requireEnv('LINE_CHANNEL_SECRET');
const CHUI_API_KEY = requireEnv('CHUI_API_KEY');
const CHUI_API_URL = process.env.CHUI_API_URL || 'http://127.0.0.1:8787';
const CONSOLE_URL = process.env.CONSOLE_URL || 'http://localhost:5173';
// LIFF 網址：設定 LIFF_ID 就用 LINE 的 liff.line.me，否則退回本機頁面
const LIFF_URL = process.env.LIFF_ID
  ? `https://liff.line.me/${process.env.LIFF_ID}`
  : `${process.env.BASE_URL || 'http://localhost:8790'}/liff/`;
const PORT = Number(process.env.MERCHANT_PORT || 8790);

const chui = init(CHUI_API_KEY, { baseUrl: CHUI_API_URL });
const bot = createBot({ chui, liffUrl: LIFF_URL, consoleUrl: CONSOLE_URL });

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});
const lineBlobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const app = express();

// ---- LINE webhook（需在 express.json 之前掛，因為要驗原始 body 簽章）----
app.post('/line-webhook', line.middleware({ channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
  res.sendStatus(200); // 先回 200，避免 LINE 端 timeout 重送
  for (const event of req.body.events ?? []) {
    try {
      await handleLineEvent(event);
    } catch (e) {
      console.error('處理 LINE 事件失敗：', e);
    }
  }
});

async function handleLineEvent(event) {
  const lineUserId = event.source?.userId;
  if (!lineUserId) return;
  let messages = null;

  if (event.type === 'message' && event.message.type === 'text') {
    messages = await bot.onText(lineUserId, event.message.text);
  } else if (event.type === 'message' && event.message.type === 'audio') {
    // 下載語音內容後交給 SDK 解析
    const stream = await lineBlobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    messages = await bot.onAudio(lineUserId, new Uint8Array(Buffer.concat(chunks)));
  } else if (event.type === 'postback') {
    messages = await bot.onPostback(lineUserId, event.postback.data);
  }

  if (messages && event.replyToken) {
    await lineClient.replyMessage({ replyToken: event.replyToken, messages });
  }
}

// ---- Chui webhook：結算事件通知（用 SDK 驗簽）----
const CHUI_WEBHOOK_SECRET = process.env.CHUI_WEBHOOK_SECRET || '';
if (CHUI_WEBHOOK_SECRET) {
  const receive = chui.onWebhook(async (webhookEvent) => {
    console.log(`[Chui webhook] ${webhookEvent.type}`, webhookEvent.data);
  }, CHUI_WEBHOOK_SECRET);
  app.post('/chui-webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const { status } = await receive(req.body, {
      timestamp: req.header('X-Chui-Timestamp') ?? '',
      signature: req.header('X-Chui-Signature') ?? '',
    });
    res.sendStatus(status);
  });
}

// ---- LIFF 頁面與其 API ----
app.use('/liff', express.static(path.join(__dirname, '..', 'public', 'liff')));
app.use(express.json());

// LIFF：綁定錢包（LINE userId ↔ Sui 地址）
app.post('/liff/bind', (req, res) => {
  const { lineUserId, suiAddress } = req.body ?? {};
  if (!lineUserId || !suiAddress || !/^0x[0-9a-fA-F]{2,}$/.test(suiAddress)) {
    return res.status(422).json({ message: '需要 lineUserId 與有效的 suiAddress' });
  }
  bot.bindWallet(lineUserId, suiAddress);
  res.json({ ok: true });
});

// LIFF：錄音點餐（走 SDK，回覆覆誦文字與訂單資訊）
app.post('/liff/order', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
  try {
    const lineUserId = req.header('X-Line-User-Id') ?? '';
    const { getAddress } = await import('./store.js');
    const consumerAddress = getAddress(lineUserId);
    if (!consumerAddress) {
      return res.status(402).json({ code: 'WALLET_NOT_BOUND', message: '請先綁定錢包' });
    }
    const parsed = await chui.parseOrder({
      audio: new Uint8Array(req.body),
      filename: 'liff-recording.webm',
      consumerAddress,
    });
    res.json({
      order_id: parsed.order_id,
      readback: parsed.readback.text,
      total: parsed.quote.total,
      order_key: parsed.order_key, // LIFF 存進消費者自己的 IndexedDB
      digest: parsed.digest,
    });
  } catch (e) {
    res.status(e.status && e.status >= 400 ? e.status : 500).json({
      code: e.code ?? 'ERROR',
      message: e.message,
      question: e.detail?.question,
    });
  }
});

// LIFF：確認結算
app.post('/liff/confirm', async (req, res) => {
  try {
    const receipt = await chui.confirmOrder(String(req.body?.order_id ?? ''));
    res.json(receipt);
  } catch (e) {
    res.status(e.status && e.status >= 400 ? e.status : 500).json({
      code: e.code ?? 'ERROR',
      message: e.message,
      move_abort: e.detail?.move_abort,
    });
  }
});

// LIFF：覆誦音檔轉發（TTS 快取與降級都在 API 端）
app.get('/liff/readback/:orderId.mp3', async (req, res) => {
  try {
    const audio = await chui.getReadbackAudio(req.params.orderId);
    res.type('audio/mpeg').send(Buffer.from(audio));
  } catch (e) {
    res.status(503).json({ message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`快樂豬 LINE bot 監聽 :${PORT}`);
  console.log(`LINE webhook: POST /line-webhook；LIFF: ${LIFF_URL}`);
});
