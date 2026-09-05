# DEMO.md —— 兩分鐘演示腳本

> 全部跑在雲上（Cloudflare Worker＋Pages＋Sui Testnet），不需要任何本機服務。

## 事前準備（一次性）

1. 兩支手機裝 [Slush 錢包](https://slush.app)、切 **Testnet**、
   領測試幣：SUI（faucet.sui.io）＋USDC（faucet.circle.com 選 Sui Testnet）。
2. 大螢幕開 https://hub.chuiprotocol.com/panel （協議封包即時面板）。

## 演示流程

1. **手機A（消費者）**：Slush 內建瀏覽器開 https://happy-chicken.chuiprotocol.com
   → 按「🎙 嘴付下單」→ 授權 3 USDC（唯一一次簽名）
   → 說「鹽酥雞加辣跟一份米血」→ 聽覆誦 → 說「確認下單」
   → 5 秒防呆倒數 → 自動扣款 → 取餐單號＋explorer 連結。
2. **手機B（店家）**：開 https://chuiprotocol.com → 店家專區 → 用店家錢包登入
   → 看板即時跳單（下單時間＋品項規格逐行）→ 簽名解密對話紀錄。
3. **加碼：現場開一家店**：chuiprotocol.com → 我要開店 → 填店名/菜單/客製化
   → Slush 簽名 → 立刻用手機A對新店語音點餐、新店錢包看自己的看板。
4. **收尾**：手機A 語音面板按「⏏ 一鍵領回全部」——撤銷授權＋餘額回錢包，
   一筆交易完成。

## 排查

| 症狀 | 解法 |
|---|---|
| 覆誦沒聲音 | iOS 需先點過任一按鈕（手勢解鎖 TTS）；確認沒開靜音鍵 |
| 額度不足 | faucet 多領 USDC → 語音面板重新授權（加值累計） |
| 付款失敗含 abort code | `2`=授權已撤銷、`3`=超過單筆上限、`4`=額度不足 |
| 想確認後端狀態 | curl https://hub.chuiprotocol.com/healthz |
