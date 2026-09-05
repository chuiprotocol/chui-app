// 查單筆交易的執行狀態與事件（給 Hub 的鏈上驗證用）。
//
// 為什麼是 Node：Sui testnet 已停用公共節點 JSON-RPC，GraphQL 又沒有
// testnet 公開端點——官方遷移路徑是 gRPC，而 @mysten/sui 的 gRPC client
// 正是手機前端在用、已證明可用的那套。Hub（Python）以一次性子行程呼叫
// 本腳本，不需要常駐服務。
//
// 用法：node txevents.js <tx_digest>
// 輸出（單行 JSON）：{ok, status: SUCCESS|FAILURE, events:[{type, json}]}
//                    或 {ok:false, error}
import { SuiGrpcClient } from '@mysten/sui/grpc';

const digest = process.argv[2];
const network = process.env.SUI_NETWORK || 'testnet';

try {
  if (!digest) throw new Error('缺 tx digest 參數');
  const client = new SuiGrpcClient({
    network,
    baseUrl: process.env.SUI_FULLNODE_URL || `https://fullnode.${network}.sui.io:443`,
  });
  const result = await client.getTransaction({ digest, include: { events: true } });
  const tx = result.Transaction ?? result.FailedTransaction;
  const status = result.$kind === 'Transaction' ? 'SUCCESS' : 'FAILURE';
  const events = (tx?.events ?? []).map((e) => ({ type: e.eventType, json: e.json }));
  console.log(JSON.stringify({ ok: true, status, events }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
}
