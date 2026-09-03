/** Chui Agent session 錢包——x402 同款「代理自動付款」模式。
 *
 * 使用者只做一次授權：用 Slush 簽一筆交易，把小額 USDC＋一點 SUI（gas）
 * 撥給頁面裡的 session key。之後每筆訂單由這把 key 自動簽名執行
 * `chui::pay::settle`，使用者不再看到任何確認畫面——花完為止，
 * 損失上限就是撥入的金額。
 *
 * 誠實聲明：Coinbase x402 協議本身不支援 Sui；這裡實作的是同款
 * UX 模式（預授權 spending key，代理自動付款），非 x402 協議本體。
 * session key 存在使用者自己瀏覽器的 IndexedDB，是一把熱錢包——
 * 只放測試幣、只放小額。
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import type { CheckoutParams } from "./hub.js";
import { idbGet, idbSet, idbDelete } from "./idb.js";

const KEY_STORAGE = "chui-agent.session-key";
const SUI_DECIMALS = 1_000_000_000n;

export interface SessionBalances {
  /** USDC 最小單位（6 位小數） */
  usdcUnits: bigint;
  /** SUI MIST */
  suiMist: bigint;
}

export class ChuiAgentSession {
  private constructor(
    public readonly keypair: Ed25519Keypair,
    private readonly client: SuiGrpcClient,
    private readonly network: string,
  ) {}

  get address(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /** 載入（或建立）本瀏覽器的 session key。 */
  static async load(network = "testnet", fullnodeUrl?: string): Promise<ChuiAgentSession> {
    const client = new SuiGrpcClient({
      network: network as "testnet",
      baseUrl: fullnodeUrl ?? `https://fullnode.${network}.sui.io:443`,
    });
    const stored = await idbGet<string>(KEY_STORAGE);
    let keypair: Ed25519Keypair;
    if (stored) {
      keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(stored).secretKey);
    } else {
      keypair = new Ed25519Keypair();
      await idbSet(KEY_STORAGE, keypair.getSecretKey());
    }
    return new ChuiAgentSession(keypair, client, network);
  }

  /** 清除 session key（登出／重置）。餘額還在鏈上該地址，清除前請先領回。 */
  static async reset(): Promise<void> {
    await idbDelete(KEY_STORAGE);
  }

  /** 查 session 錢包餘額（USDC＋gas）。 */
  async balances(usdcCoinType: string): Promise<SessionBalances> {
    try {
      const [usdc, sui] = await Promise.all([
        this.client.getBalance({ owner: this.address, coinType: usdcCoinType }),
        this.client.getBalance({ owner: this.address, coinType: "0x2::sui::SUI" }),
      ]);
      return {
        usdcUnits: BigInt(usdc.balance?.balance ?? 0),
        suiMist: BigInt(sui.balance?.balance ?? 0),
      };
    } catch (e) {
      throw new Error(
        `無法連線 Sui ${this.network} fullnode（${(e as Error).message}）——請確認這台裝置的網路可以連到 Sui Testnet`,
      );
    }
  }

  /**
   * 建立「一次性授權」交易（由使用者的 Slush 簽名）：
   * 把 usdcUnits 的 USDC 與 suiMist 的 SUI 撥給 session 地址。
   * 這是整個體驗中唯一一次錢包確認。
   */
  buildTopUpTransaction(usdcCoinType: string, usdcUnits: bigint, suiMist: bigint): Transaction {
    const tx = new Transaction();
    const usdcCoin = coinWithBalance({ type: usdcCoinType, balance: usdcUnits });
    const [gasCoin] = tx.splitCoins(tx.gas, [suiMist]);
    tx.transferObjects([usdcCoin, gasCoin], this.address);
    return tx;
  }

  /**
   * 自動結帳：session key 直接簽名執行 settle，不經任何使用者確認。
   * 回傳鏈上交易 digest。餘額不足時擲出明確錯誤（不會偷偷失敗）。
   */
  async payAuto(checkout: CheckoutParams): Promise<string> {
    if (!checkout.package_id) {
      throw new Error("結帳參數缺少 package_id（合約尚未部署？）");
    }
    const { usdcUnits, suiMist } = await this.balances(checkout.coin_type);
    if (usdcUnits < BigInt(checkout.amount_units)) {
      throw new Error(
        `Chui Agent 餘額不足：需 ${checkout.amount_units} USDC 單位、只有 ${usdcUnits}。請再授權一次撥款。`,
      );
    }
    if (suiMist < SUI_DECIMALS / 100n) { // 0.01 SUI 以下視為 gas 不足
      throw new Error("Chui Agent 的 gas（SUI）不足，請再授權一次撥款。");
    }

    const digestBytes = hexToBytes(checkout.order_digest_hex);
    const tx = new Transaction();
    tx.setSender(this.address);
    tx.moveCall({
      target: `${checkout.package_id}::${checkout.module}::${checkout.function}`,
      typeArguments: [checkout.coin_type],
      arguments: [
        coinWithBalance({ type: checkout.coin_type, balance: BigInt(checkout.amount_units) }),
        tx.pure.address(checkout.merchant_address),
        tx.pure.vector("u8", Array.from(digestBytes)),
      ],
    });
    // v2 gRPC 回傳 tagged union：成功在 Transaction、上鏈失敗在 FailedTransaction
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        `結算交易上鏈失敗（digest ${result.FailedTransaction.digest}），請檢查 explorer`,
      );
    }
    const digest = result.Transaction.digest;
    await this.client.waitForTransaction({ digest });
    return digest;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
