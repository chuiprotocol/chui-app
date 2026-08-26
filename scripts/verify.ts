#!/usr/bin/env node --experimental-strip-types
/**
 * verify.ts —— 證明「鏈上 digest」與「鏈下訂單明細」相符。
 *
 * 消費者不必信任 Chui：只要有
 *   1. 明細密文與 salt（GET /v1/orders/{id}，或收據頁複製）
 *   2. 自己持有的解密金鑰（點餐時發給消費者的 order_key）
 * 就能離線重算 digest，並與 explorer 上交易裡的 digest 逐字比對。
 *
 * 用法一（直接給訂單 ID，向 API 取密文與 salt）：
 *   node --experimental-strip-types scripts/verify.ts \
 *     --api http://127.0.0.1:8787 --api-key chui_sk_xxx \
 *     --order ord_xxx --key <order_key_base64>
 *
 * 用法二（完全離線，資料自己貼）：
 *   node --experimental-strip-types scripts/verify.ts \
 *     --ciphertext <b64> --nonce <b64> --salt <hex> --digest <hex> --key <b64>
 */

import { verifyReceipt } from "../packages/sdk/dist/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const key = arg("key");
  if (!key) {
    console.error("缺少 --key（消費者持有的 order_key，base64）");
    process.exit(2);
  }

  let ciphertext = arg("ciphertext");
  let nonce = arg("nonce");
  let salt = arg("salt");
  let digest = arg("digest");
  let explorerUrl: string | undefined;

  const orderId = arg("order");
  if (orderId) {
    const api = arg("api") ?? "http://127.0.0.1:8787";
    const apiKey = arg("api-key");
    if (!apiKey) {
      console.error("用 --order 模式時需要 --api-key（店家 API key）");
      process.exit(2);
    }
    const resp = await fetch(`${api}/v1/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      console.error(`取得訂單失敗（HTTP ${resp.status}）：${await resp.text()}`);
      process.exit(1);
    }
    const order = await resp.json();
    ciphertext = order.details_ciphertext;
    nonce = order.details_nonce;
    salt = order.salt;
    digest = order.digest;
    explorerUrl = order.explorer_url;
  }

  if (!ciphertext || !nonce || !salt || !digest) {
    console.error("缺少必要資料：--ciphertext --nonce --salt --digest（或改用 --order 模式）");
    process.exit(2);
  }

  const result = await verifyReceipt({
    ciphertextB64: ciphertext,
    nonceB64: nonce,
    keyB64: key,
    saltHex: salt,
    expectedDigestHex: digest,
  });

  console.log("── Chui 收據驗證 ──");
  console.log("解密後明細：");
  console.log(JSON.stringify(result.details, null, 2));
  console.log(`重算 digest：${result.computedDigest}`);
  console.log(`預期 digest：${result.expectedDigest}`);
  if (result.ok) {
    console.log("✅ 相符：鏈上 digest 正是這份明細（含 salt）的 SHA-256。");
    if (explorerUrl) {
      console.log(`最後一步：打開 ${explorerUrl}，確認交易輸入中的 digest 與上面一致。`);
    } else {
      console.log("最後一步：到 explorer 打開這筆交易，確認其中的 digest 與上面一致。");
    }
  } else {
    console.error("❌ 不相符：明細、金鑰或 salt 有誤——這份明細「不能」對應到鏈上那筆交易。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("驗證失敗：", e.message);
  process.exit(1);
});
