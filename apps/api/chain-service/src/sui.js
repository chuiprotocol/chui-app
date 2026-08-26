// Sui 鏈上操作核心。
//
// 重要背景：chui-contracts repo 在開發當下是空的，拿不到 SPEC 與部署資訊。
// 因此這裡的 Move call 形狀是「假定介面」（見 README 與 DECISIONS.md），
// module／function 名稱與引數全部可用環境變數覆寫；package ID 未設定時
// 所有鏈上操作一律明確報錯，絕不偽造結果。

import fs from 'node:fs';
import path from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

// ---- 網路設定：預設 testnet，mainnet 明確封鎖 ----
export const NETWORK = process.env.SUI_NETWORK || 'testnet';
if (NETWORK === 'mainnet') {
  throw new Error('SUI_NETWORK=mainnet 目前被明確封鎖：本專案現階段只允許 testnet/devnet。');
}

const client = new SuiGrpcClient({
  network: NETWORK,
  baseUrl: process.env.SUI_FULLNODE_URL || `https://fullnode.${NETWORK}.sui.io:443`,
});

// ---- 合約目標（假定介面，需與實際部署的合約核對）----
export const PACKAGE_ID = process.env.CHUI_PACKAGE_ID || '';
const MODULE = process.env.CHUI_MODULE || 'mandate';
const FN_CREATE = process.env.CHUI_FN_CREATE || 'create';
const FN_SETTLE = process.env.CHUI_FN_SETTLE || 'settle';
const FN_REVOKE = process.env.CHUI_FN_REVOKE || 'revoke';
// 選用的 shared registry 物件（合約若需要就設定，會作為第一個引數傳入）
const REGISTRY_ID = process.env.CHUI_REGISTRY_ID || '';

// 金額換算：1 元（整數）= AMOUNT_SCALE_MIST MIST。預設 0.01 SUI／元，
// 只是測試幣的示意匯率；一律整數運算。
const AMOUNT_SCALE_MIST = BigInt(process.env.AMOUNT_SCALE_MIST || '10000000');

// 合約 abort code → 具名錯誤。需與合約的 const 定義核對。
const ABORT_CODES = JSON.parse(
  process.env.CHUI_ABORT_CODES ||
    '{"1":"E_OVER_PER_TX","2":"E_OVER_TOTAL","3":"E_REVOKED","4":"E_EXPIRED","5":"E_NOT_OPERATOR"}',
);

// ---- 贊助者／操作者金鑰（同一把；見信任假設）----
function loadSponsor() {
  const raw = process.env.SPONSOR_SECRET_KEY || '';
  if (!raw) return null;
  if (raw.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(fromBase64(raw));
}
export const sponsor = loadSponsor();

export function requireConfigured() {
  if (!PACKAGE_ID) {
    const err = new Error('CHUI_PACKAGE_ID 未設定：合約 repo（chui-contracts）的 deployments/testnet.json 尚未提供 package ID，鏈上操作停用。');
    err.code = 'CHAIN_NOT_CONFIGURED';
    throw err;
  }
  if (!sponsor) {
    const err = new Error('SPONSOR_SECRET_KEY 未設定：無法贊助 gas 或執行結算。');
    err.code = 'CHAIN_NOT_CONFIGURED';
    throw err;
  }
}

export function scaleAmount(amountTwd) {
  // 元（整數）→ MIST（BigInt），全程整數，絕無浮點
  if (!Number.isInteger(amountTwd) || amountTwd < 0) {
    throw new Error(`金額必須是非負整數（元）：${amountTwd}`);
  }
  return BigInt(amountTwd) * AMOUNT_SCALE_MIST;
}

// ---- 結算去重：以訂單 digest 為鍵的本地紀錄 ----
// API 在鏈上送出後、寫回資料庫前崩潰時，重試會先查這裡，避免重複扣款。
const DEDUPE_PATH = process.env.SETTLE_DEDUPE_PATH ||
  path.join(process.cwd(), 'settle-dedupe.json');

function readDedupe() {
  try {
    return JSON.parse(fs.readFileSync(DEDUPE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeDedupe(map) {
  fs.writeFileSync(DEDUPE_PATH, JSON.stringify(map));
}

// ---- Move abort 解析 ----
function extractMoveAbort(error) {
  const msg = String(error?.message || error);
  // 常見格式：MoveAbort(MoveLocation { ... }, 1) 或 "abort_code: 1"
  const m = msg.match(/MoveAbort[^,]*,\s*(\d+)\)/) || msg.match(/abort_code[":\s]+(\d+)/i);
  if (m) {
    const code = m[1];
    return ABORT_CODES[code] || `MOVE_ABORT_${code}`;
  }
  return '';
}

// ---- 個人訊息簽章驗證（支援 zkLogin 與一般錢包）----
export async function verifySignature({ address, messageB64, signature }) {
  const message = fromBase64(messageB64);
  try {
    const publicKey = await verifyPersonalMessageSignature(message, signature, {
      client,
      address,
    });
    // 雙重確認：簽章者導出的地址要等於宣稱的地址
    return publicKey.toSuiAddress() === address;
  } catch {
    return false;
  }
}

// ---- Sponsored tx：address-balance sponsorship ----
// setGasPayment([]) = 由 gasOwner 的地址餘額扣 gas，免協調 gas coin 版本，
// 消費者可以先簽名（@mysten/sui v2 的建議路徑）。
async function buildSponsored(txMutator, senderAddress) {
  requireConfigured();
  const tx = new Transaction();
  tx.setSender(senderAddress);
  tx.setGasOwner(sponsor.toSuiAddress());
  tx.setGasPayment([]);
  tx.setGasBudget(50_000_000n);
  txMutator(tx);
  const bytes = await tx.build({ client });
  return toBase64(bytes);
}

export async function buildMandateTx({ consumer, perTxLimit, totalLimit, deposit }) {
  return buildSponsored((tx) => {
    const args = [];
    if (REGISTRY_ID) args.push(tx.object(REGISTRY_ID));
    // 消費者存入的測試幣（從消費者自己的 coin 拿，不是 gas coin）。
    // coinWithBalance 回傳 intent，交給 Transaction 在 build 時解析
    args.push(coinWithBalance({ balance: scaleAmount(deposit), useGasCoin: false }));
    args.push(tx.pure.u64(BigInt(perTxLimit)));
    args.push(tx.pure.u64(BigInt(totalLimit)));
    tx.moveCall({ target: `${PACKAGE_ID}::${MODULE}::${FN_CREATE}`, arguments: args });
  }, consumer);
}

export async function buildRevokeTx({ consumer, mandateId }) {
  return buildSponsored((tx) => {
    tx.moveCall({
      target: `${PACKAGE_ID}::${MODULE}::${FN_REVOKE}`,
      arguments: [tx.object(mandateId)],
    });
  }, consumer);
}

// 執行「消費者已簽名」的 sponsored tx：補上贊助者簽名後送鏈
export async function executeSponsored({ txBytesB64, userSignature }) {
  requireConfigured();
  const bytes = fromBase64(txBytesB64);
  const { signature: sponsorSig } = await sponsor.signTransaction(bytes);
  const result = await client.executeTransaction({
    transaction: bytes,
    signatures: [userSignature, sponsorSig],
    include: { effects: true, events: true },
  });
  await client.waitForTransaction({ digest: result.digest });
  return {
    txDigest: result.digest,
    mandateId: extractCreatedSharedObject(result),
  };
}

// 從交易結果找出新建立的 shared object（Mandate）
function extractCreatedSharedObject(result) {
  const effects = result.effects || result.Effects || {};
  const candidates = [];
  // gRPC 與 JSON-RPC 的 effects 形狀不同，逐一嘗試已知欄位
  for (const list of [effects.created, effects.changedObjects, result.objectChanges]) {
    if (!Array.isArray(list)) continue;
    for (const obj of list) {
      const id = obj?.objectId || obj?.reference?.objectId || obj?.object_id;
      const changeType = obj?.type || obj?.idOperation || obj?.change_type;
      if (id && (changeType === undefined || /creat|new/i.test(String(changeType)))) {
        candidates.push(id);
      }
    }
  }
  return candidates[0] || '';
}

// ---- 結算（operator 簽名執行）----
export async function settle({ mandateId, merchant, amount, digestHex }) {
  requireConfigured();

  // 冪等去重：同一個訂單 digest 已經上過鏈就直接回同一筆交易
  const dedupe = readDedupe();
  if (dedupe[digestHex]) {
    return { txDigest: dedupe[digestHex], deduped: true };
  }

  const tx = new Transaction();
  tx.setSender(sponsor.toSuiAddress());
  tx.setGasBudget(50_000_000n);
  const digestBytes = Array.from(Buffer.from(digestHex, 'hex'));
  const args = [];
  if (REGISTRY_ID) args.push(tx.object(REGISTRY_ID));
  args.push(tx.object(mandateId));
  args.push(tx.pure.u64(scaleAmount(amount)));
  args.push(tx.pure.vector('u8', digestBytes));
  args.push(tx.pure.address(merchant));
  tx.moveCall({ target: `${PACKAGE_ID}::${MODULE}::${FN_SETTLE}`, arguments: args });

  let result;
  try {
    result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: sponsor,
      include: { effects: true },
    });
  } catch (error) {
    const abort = extractMoveAbort(error);
    const err = new Error(abort ? `鏈上結算被合約拒絕：${abort}` : `鏈上結算失敗：${error.message}`);
    err.moveAbort = abort;
    throw err;
  }
  await client.waitForTransaction({ digest: result.digest });

  dedupe[digestHex] = result.digest;
  writeDedupe(dedupe);
  return { txDigest: result.digest, deduped: false };
}

// 目前 epoch（zkLogin 的 maxEpoch 計算用）
export async function currentEpoch() {
  const state = await client.getCurrentSystemState();
  // 不同版本欄位名不同，逐一嘗試
  const epoch = state?.epoch ?? state?.systemState?.epoch ?? state?.currentEpoch;
  if (epoch === undefined || epoch === null) {
    throw new Error('無法從 getCurrentSystemState 取得 epoch');
  }
  return Number(epoch);
}

export async function health() {
  return {
    ok: true,
    network: NETWORK,
    packageConfigured: Boolean(PACKAGE_ID),
    sponsorConfigured: Boolean(sponsor),
    sponsorAddress: sponsor ? sponsor.toSuiAddress() : null,
    registryConfigured: Boolean(REGISTRY_ID),
  };
}
