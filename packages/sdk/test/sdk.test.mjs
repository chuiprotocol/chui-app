// SDK 單元測試：錯誤對映、webhook 驗簽、canonical JSON、加解密驗證。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  ClarificationNeededError,
  ChainSettlementError,
  canonicalJson,
  computeOrderDigest,
  errorFromResponse,
  init,
  verifyWebhookSignature,
} from "../dist/index.js";

test("錯誤對映：CLARIFICATION_NEEDED → ClarificationNeededError", () => {
  const err = errorFromResponse(422, {
    detail: { code: "CLARIFICATION_NEEDED", message: "請再說一次", question: "您是要奶茶嗎？", candidates: ["奶茶"] },
  });
  assert.ok(err instanceof ClarificationNeededError);
  assert.equal(err.question, "您是要奶茶嗎？");
  assert.deepEqual(err.candidates, ["奶茶"]);
});

test("錯誤對映：move_abort 帶回具名合約錯誤", () => {
  const err = errorFromResponse(502, {
    detail: { code: "CHAIN_SETTLEMENT_FAILED", message: "拒絕", move_abort: "E_OVER_PER_TX" },
  });
  assert.ok(err instanceof ChainSettlementError);
  assert.equal(err.moveAbort, "E_OVER_PER_TX");
});

test("init 拒絕格式錯誤的 API key", () => {
  assert.throws(() => init("wrong_prefix_key"), /chui_sk_/);
});

test("canonicalJson 與伺服器端一致（鍵排序、無空白、UTF-8）", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, "中文"] }), '{"a":[2,"中文"],"b":1}');
});

test("computeOrderDigest 決定性", async () => {
  const d1 = await computeOrderDigest({ a: 1, b: 2 }, "00".repeat(32));
  const d2 = await computeOrderDigest({ b: 2, a: 1 }, "00".repeat(32));
  const d3 = await computeOrderDigest({ a: 1, b: 2 }, "11".repeat(32));
  assert.equal(d1, d2);
  assert.notEqual(d1, d3);
});

test("webhook 驗簽：正確簽章通過、錯誤簽章與過期 timestamp 拒絕", () => {
  const secret = "whsec_x";
  const body = '{"type":"order.settled"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v1=" + createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
  assert.ok(verifyWebhookSignature(secret, { timestamp: ts, signature: sig }, body));
  assert.ok(!verifyWebhookSignature("other", { timestamp: ts, signature: sig }, body));
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = "v1=" + createHmac("sha256", secret).update(`${oldTs}.`).update(body).digest("hex");
  assert.ok(!verifyWebhookSignature(secret, { timestamp: oldTs, signature: oldSig }, body));
});
