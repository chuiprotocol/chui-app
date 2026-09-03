/** 零按鍵自動下單結帳流程。
 *
 * 語音（或文字）→ Hub 解析 → 立即向商家確認 → Chui Agent（session key）
 * 自動簽名付款 → 回報鏈上驗證。中間沒有任何使用者確認步驟。
 *
 * 唯一會停下來的情況：信心不足（Hub 回澄清問題）——付款情境下
 * 「不確定就問」仍然是底線，因為連要買什麼都不知道就不可能扣對錢。
 */

import { ClarificationNeeded, HubClient, type ParseResponse, type SettlementResponse } from "./hub.js";
import { ChuiAgentSession } from "./session.js";

export interface AutoOrderCallbacks {
  /** 解析完成（同步唸出覆誦；不等待、不確認） */
  onQuote?: (parsed: ParseResponse) => void;
  /** 需要澄清：把問題唸給使用者聽並重新聆聽 */
  onClarify?: (question: string) => void;
  /** 各階段進度訊息 */
  onProgress?: (message: string) => void;
  /** 全部完成 */
  onSettled?: (result: {
    parsed: ParseResponse;
    merchantRef: string;
    txDigest: string;
    settlement: SettlementResponse;
  }) => void;
  onError?: (error: Error) => void;
}

export type AutoOrderInput = { text: string } | { audio: Blob };

/** 跑完整的零按鍵流程。回傳 true = 已完成付款；false = 澄清中或失敗。 */
export async function runAutoOrder(
  hub: HubClient,
  session: ChuiAgentSession,
  input: AutoOrderInput,
  callbacks: AutoOrderCallbacks,
  merchantId?: string,
): Promise<boolean> {
  try {
    callbacks.onProgress?.("辨識中…");
    const parsed = "text" in input
      ? await hub.parseText(input.text, merchantId)
      : await hub.parseAudio(input.audio, merchantId);
    callbacks.onQuote?.(parsed);

    callbacks.onProgress?.(`向 ${parsed.merchant_name} 下單…`);
    const confirmed = await hub.confirm(parsed.order_id);

    callbacks.onProgress?.(
      `Chui Agent 自動付款中（${(confirmed.checkout.amount_units / 1_000_000).toFixed(2)} USDC）…`,
    );
    const txDigest = await session.payAuto(confirmed.checkout);

    callbacks.onProgress?.("交易已上鏈，等待驗證…");
    const settlement = await hub.reportSettlement(parsed.order_id, txDigest);

    callbacks.onSettled?.({ parsed, merchantRef: confirmed.merchant_ref, txDigest, settlement });
    return true;
  } catch (err) {
    if (err instanceof ClarificationNeeded) {
      callbacks.onClarify?.(err.question);
    } else {
      callbacks.onError?.(err as Error);
    }
    return false;
  }
}
