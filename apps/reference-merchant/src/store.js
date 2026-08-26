// 店家端的小型持久化：LINE 使用者 ↔ Sui 地址綁定、待確認訂單。
// 用 JSON 檔即可——這是「店家自己的」資料，不屬於 Chui 協議的一部分，
// 參考實作刻意保持最低依賴。

import fs from 'node:fs';
import path from 'node:path';

const DATA_PATH = process.env.MERCHANT_DATA_PATH || path.join(process.cwd(), 'merchant-data.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { bindings: {}, pendingOrders: {} };
  }
}

function save(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

export function bindAddress(lineUserId, suiAddress) {
  const data = load();
  data.bindings[lineUserId] = suiAddress;
  save(data);
}

export function getAddress(lineUserId) {
  return load().bindings[lineUserId] || null;
}

// 待確認訂單：語音確認（「對」「好」）時要知道使用者是在確認哪一單。
// 十分鐘過期，過期的確認一律重問。
const PENDING_TTL_MS = 10 * 60 * 1000;

export function setPendingOrder(lineUserId, orderId, readbackText) {
  const data = load();
  data.pendingOrders[lineUserId] = { orderId, readbackText, at: Date.now() };
  save(data);
}

export function getPendingOrder(lineUserId) {
  const entry = load().pendingOrders[lineUserId];
  if (!entry) return null;
  if (Date.now() - entry.at > PENDING_TTL_MS) return null;
  return entry;
}

export function clearPendingOrder(lineUserId) {
  const data = load();
  delete data.pendingOrders[lineUserId];
  save(data);
}
