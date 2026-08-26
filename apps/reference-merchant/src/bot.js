// LINE bot 的對話邏輯。所有與 Chui 的互動「只」透過 @chui/sdk——
// 這是參考實作的鐵律：證明第三方店家真的能只靠公開 SDK 介接。

import {
  ChainSettlementError,
  ClarificationNeededError,
  MandateRequiredError,
  SttUnavailableError,
} from '@chui/sdk';
import {
  bindAddress,
  clearPendingOrder,
  getAddress,
  getPendingOrder,
  setPendingOrder,
} from './store.js';

// 語音／文字確認只接受這些「明確」的肯定詞；任何模糊回應一律重問。
// 在支付情境下，猜錯比多問一輪糟糕得多。
const AFFIRMATIVES = new Set(['對', '好', '是', '是的', '沒錯', '確認', '確定', 'ok', 'OK', 'Ok', '好的', '對啊']);
const NEGATIVES = new Set(['不要', '不用', '取消', '不對', '錯了', '不是', '算了']);

export function createBot({ chui, liffUrl, consoleUrl }) {
  // 回覆訊息陣列的組裝工具
  const text = (t) => ({ type: 'text', text: t });

  const confirmQuickReply = {
    items: [
      { type: 'action', action: { type: 'postback', label: '✅ 確認付款', data: 'confirm', displayText: '確認' } },
      { type: 'action', action: { type: 'postback', label: '❌ 取消', data: 'cancel', displayText: '取消' } },
    ],
  };

  async function handleParsedOrder(lineUserId, parsed) {
    setPendingOrder(lineUserId, parsed.order_id, parsed.readback.text);
    return [{
      type: 'text',
      text: `${parsed.readback.text}\n（也可以直接說「對」或「取消」）`,
      quickReply: confirmQuickReply,
    }];
  }

  async function doConfirm(lineUserId) {
    const pending = getPendingOrder(lineUserId);
    if (!pending) {
      return [text('目前沒有待確認的訂單喔，請再點一次餐。')];
    }
    try {
      const receipt = await chui.confirmOrder(pending.orderId);
      clearPendingOrder(lineUserId);
      return [text(
        `付款完成！共 ${receipt.amount} 元。\n` +
        `這筆交易已寫進 Sui Testnet：\n${receipt.explorer_url}\n` +
        `（鏈上只看得到雜湊值，看不到你點了什麼）`,
      )];
    } catch (e) {
      if (e instanceof MandateRequiredError) {
        return [text(`你還沒有設定付款授權。請先到後台綁定錢包並建立授權：\n${consoleUrl}`)];
      }
      if (e instanceof ChainSettlementError) {
        const reason = e.moveAbort === 'E_OVER_PER_TX' ? '這筆金額超過你設定的單筆上限（E_OVER_PER_TX）'
          : e.moveAbort === 'E_REVOKED' ? '你的授權已撤銷（E_REVOKED）'
          : e.moveAbort === 'E_OVER_TOTAL' ? '已超過授權總額上限（E_OVER_TOTAL）'
          : `鏈上拒絕：${e.moveAbort || e.message}`;
        return [text(`付款沒有成功：${reason}。\n訂單保留中，調整授權後再說「對」即可重試。`)];
      }
      return [text(`付款失敗：${e.message}\n訂單保留中，稍後再說「對」即可重試。`)];
    }
  }

  async function handleOrderInput(lineUserId, input) {
    const consumerAddress = getAddress(lineUserId);
    if (!consumerAddress) {
      return [text(`歡迎光臨快樂豬！點餐前請先綁定錢包（不用助記詞、不用付 gas）：\n${liffUrl}`)];
    }
    try {
      const parsed = await chui.parseOrder({ ...input, consumerAddress });
      return handleParsedOrder(lineUserId, parsed);
    } catch (e) {
      if (e instanceof ClarificationNeededError) {
        // 信心不足：把澄清問題丟回去，絕不猜
        return [text(e.question)];
      }
      if (e instanceof SttUnavailableError) {
        return [text('語音辨識暫時不可用，請直接打字點餐（例如：中冰奶）。')];
      }
      return [text(`點餐沒有成功：${e.message}`)];
    }
  }

  return {
    /** LINE 文字訊息 */
    async onText(lineUserId, messageText) {
      const trimmed = messageText.trim();
      if (AFFIRMATIVES.has(trimmed)) return doConfirm(lineUserId);
      if (NEGATIVES.has(trimmed)) {
        clearPendingOrder(lineUserId);
        return [text('好的，已取消這筆訂單。')];
      }
      const pending = getPendingOrder(lineUserId);
      if (pending) {
        // 有待確認訂單時，模糊回應一律重問，不服用不明確的答案
        if (trimmed.length <= 4) {
          return [text(`不好意思，我需要明確的答案。${pending.readbackText}\n請回答「對」或「取消」。`)];
        }
        // 較長的內容視為重新點餐
        clearPendingOrder(lineUserId);
      }
      return handleOrderInput(lineUserId, { text: trimmed });
    },

    /** LINE 語音訊息（audio bytes 已由 server 下載好） */
    async onAudio(lineUserId, audioBytes) {
      return handleOrderInput(lineUserId, { audio: audioBytes, filename: 'line-audio.m4a' });
    },

    /** 按鈕 postback */
    async onPostback(lineUserId, data) {
      if (data === 'confirm') return doConfirm(lineUserId);
      if (data === 'cancel') {
        clearPendingOrder(lineUserId);
        return [text('好的，已取消這筆訂單。')];
      }
      return [text('嗯？我不認得這個操作。')];
    },

    /** LIFF 綁定錢包 */
    bindWallet(lineUserId, suiAddress) {
      bindAddress(lineUserId, suiAddress);
    },
  };
}
