/** 鏈上結算驗證。
 *
 * 查交易的 SettlementEvent，digest／amount／merchant 三者皆符才標記已結算。
 * 查詢走官方 gRPC（testnet 公共節點 JSON-RPC 已停用）——@mysten/sui 的
 * gRPC client 是 fetch 基底，Worker 內直接用，不再需要 Node 子行程。
 * Hub 絕不憑空標記已付款：查不到、連不上一律 pending_verification。
 */

import type { Env } from "./external.js";

export function suiNetwork(env: Env): string {
  const network = env.SUI_NETWORK ?? "testnet";
  if (network === "mainnet") {
    // 與整個專案一致的防呆：mainnet 明確封鎖
    throw new Error("SUI_NETWORK=mainnet 目前被明確封鎖：只允許 testnet/devnet。");
  }
  return network;
}

export function explorerTxUrl(env: Env, digest: string): string {
  return `https://suiscan.xyz/${suiNetwork(env)}/tx/${digest}`;
}

/** 事件裡的 vector<u8> 依節點版本可能是 int 陣列或 base64／hex 字串。 */
function digestBytesFromEvent(value: unknown): Uint8Array {
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (typeof value === "string") {
    try {
      return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    } catch {
      const hex = value.replace(/^0x/, "");
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
  }
  return new Uint8Array(0);
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface VerifyOutcome {
  verified: boolean;
  reason: string;
  owner?: string;
}

/** 回傳 {verified, reason, owner?}。查不到／連不上一律 verified=false。 */
export async function verifySettlement(
  env: Env,
  txDigest: string,
  expectedDigestHex: string,
  expectedAmountUnits: number,
  expectedMerchant: string,
): Promise<VerifyOutcome> {
  if (!env.CHUI_PACKAGE_ID) {
    return { verified: false, reason: "CHUI_PACKAGE_ID 未設定，無法核對事件型別" };
  }
  const module = env.CHUI_MODULE ?? "vault";
  const eventType = `${env.CHUI_PACKAGE_ID}::${module}::SettlementEvent`;
  const network = suiNetwork(env);

  let status: string;
  let events: Array<{ type: string; json: Record<string, unknown> }>;
  try {
    // 動態 import：@mysten/sui 的依賴在模組頂層會做 Workers 禁止的
    // 全域操作（隨機值預計算）——延到請求處理中載入才合法
    const { SuiGrpcClient } = await import("@mysten/sui/grpc");
    const client = new SuiGrpcClient({
      network: network as "testnet",
      baseUrl: env.SUI_FULLNODE_URL || `https://fullnode.${network}.sui.io:443`,
    });
    const result = await client.getTransaction({ digest: txDigest, include: { events: true } });
    const anyResult = result as unknown as {
      $kind: string;
      Transaction?: { events?: Array<{ eventType: string; json: unknown }> };
      FailedTransaction?: { events?: Array<{ eventType: string; json: unknown }> };
    };
    const tx = anyResult.Transaction ?? anyResult.FailedTransaction;
    status = anyResult.$kind === "Transaction" ? "SUCCESS" : "FAILURE";
    events = (tx?.events ?? []).map((e) => ({
      type: e.eventType,
      json: (e.json ?? {}) as Record<string, unknown>,
    }));
  } catch (error) {
    return { verified: false, reason: `鏈上查詢失敗：${(error as Error).message ?? String(error)}` };
  }

  if (status !== "SUCCESS") {
    return { verified: false, reason: `交易未成功（status=${status || "未知"}）` };
  }

  for (const event of events) {
    if (event.type !== eventType) continue;
    const parsed = event.json;
    const gotDigest = toHex(digestBytesFromEvent(parsed.order_digest));
    const gotAmount = parseInt(String(parsed.amount ?? "0"), 10);
    const gotMerchant = String(parsed.merchant ?? "");
    if (gotDigest !== expectedDigestHex) {
      return { verified: false, reason: "事件中的 order_digest 與訂單不符" };
    }
    if (gotAmount !== expectedAmountUnits) {
      return { verified: false, reason: `事件金額 ${gotAmount} ≠ 預期 ${expectedAmountUnits}` };
    }
    if (gotMerchant.toLowerCase() !== expectedMerchant.toLowerCase()) {
      return { verified: false, reason: "事件收款地址與店家不符" };
    }
    // owner＝鏈上事件裡的 Vault 擁有者（消費者錢包）——歷史查詢頁靠它
    // 對應「這筆訂單是誰的」，來源是鏈上事實而非前端自報
    return {
      verified: true,
      reason: "digest／amount／merchant 三者皆符",
      owner: String(parsed.owner ?? ""),
    };
  }
  return { verified: false, reason: "交易中沒有本協議的 SettlementEvent" };
}
