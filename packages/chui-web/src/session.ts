/** Chui Agent——「預授權額度內代付」的 Sui 自製實作（vault + cap 版）。
 *
 * 與熱錢包模式的關鍵差異：**agent 不持有本金**。
 * 用戶唯一一次用 Slush 簽 `chui::vault::create_and_authorize`：
 *   - USDC 存進「用戶自己的」Vault（shared object，只有 owner 能 withdraw/revoke）
 *   - AgentCap（純權限物件）交給本頁面的 agent key
 *   - 順帶撥 0.05 SUI 給 agent 當 gas
 * 之後每筆訂單 agent 自動簽 `agent_settle`——合約強制單筆上限與餘額檢查，
 * 錢從 Vault 直接到商家。agent key 被偷最多只能在額度內「幫你買東西」。
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import type { CheckoutParams } from "./hub.js";
import { idbGet, idbSet, idbDelete } from "./idb.js";

const KEY_STORAGE = "chui-agent.key";
const BINDING_STORAGE = "chui-agent.binding"; // { vaultId, capId, packageId }
const TOPUP_GAS_MIST = 50_000_000n; // 授權時附 0.05 SUI 給 agent 當 gas
const MIN_GAS_MIST = 10_000_000n;   // 低於 0.01 SUI 視為 gas 不足

export interface AgentBinding {
  vaultId: string;
  capId: string;
  packageId: string;
  /** Vault 擁有者（用戶錢包）地址——Seal 加密存證的身分之一 */
  ownerAddress?: string;
}

export interface AgentStatus {
  authorized: boolean;
  /** Vault 剩餘可用額度（USDC 最小單位） */
  remainingUnits: bigint;
  /** 單筆上限（USDC 最小單位） */
  perTxUnits: bigint;
  /** 累計已消費 */
  spentUnits: bigint;
  /** cap 是否仍有效（未被撤銷） */
  capActive: boolean;
  /** agent 的 gas 餘額（MIST） */
  gasMist: bigint;
}

function wrapChainError(e: unknown, network: string): Error {
  return new Error(
    `無法連線 Sui ${network} fullnode（${(e as Error).message}）——請確認這台裝置的網路可以連到 Sui Testnet`,
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class ChuiAgentSession {
  private constructor(
    public readonly keypair: Ed25519Keypair,
    private readonly client: SuiGrpcClient,
    private readonly network: string,
    private binding: AgentBinding | null,
  ) {}

  get address(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  get currentBinding(): AgentBinding | null {
    return this.binding;
  }

  /** 載入（或建立）本瀏覽器的 agent key 與 vault 綁定。 */
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
    const binding = (await idbGet<AgentBinding>(BINDING_STORAGE)) ?? null;
    return new ChuiAgentSession(keypair, client, network, binding);
  }

  static async reset(): Promise<void> {
    await idbDelete(KEY_STORAGE);
    await idbDelete(BINDING_STORAGE);
  }

  /** 只清 vault 綁定、保留 agent key（合約升級後領回舊資金→重新授權用）。 */
  async clearBinding(): Promise<void> {
    await idbDelete(BINDING_STORAGE);
    this.binding = null;
  }

  /**
   * 建立「唯一一次」授權交易（交給用戶的 Slush 簽）：
   * 存 usdcUnits 進新 Vault、設單筆上限、發 cap 給 agent、撥 gas 給 agent。
   */
  buildAuthorizeTransaction(
    packageId: string,
    moduleName: string,
    usdcCoinType: string,
    usdcUnits: bigint,
    perTxUnits: bigint,
  ): Transaction {
    if (!packageId) throw new Error("缺少 package_id（合約尚未部署？）");
    const tx = new Transaction();
    const [gasCoin] = tx.splitCoins(tx.gas, [TOPUP_GAS_MIST]);
    tx.transferObjects([gasCoin], this.address);
    tx.moveCall({
      target: `${packageId}::${moduleName}::create_and_authorize`,
      typeArguments: [usdcCoinType],
      arguments: [
        coinWithBalance({ type: usdcCoinType, balance: usdcUnits }),
        tx.pure.u64(perTxUnits),
        tx.pure.address(this.address),
      ],
    });
    return tx;
  }

  /**
   * 加值交易（交給用戶的 Slush 簽）：把 USDC 存進「既有的」Vault，額度累計。
   * 有綁定就走這條，不再建新 Vault（新 Vault 會把舊的錢丟下）。
   * includeGasTopUp：agent gas 快用完時順帶補 0.05 SUI。
   */
  buildDepositTransaction(
    moduleName: string,
    usdcCoinType: string,
    usdcUnits: bigint,
    includeGasTopUp: boolean,
  ): Transaction {
    if (!this.binding) throw new Error("尚未授權，無法加值——請先完成一次性授權");
    const tx = new Transaction();
    if (includeGasTopUp) {
      const [gasCoin] = tx.splitCoins(tx.gas, [TOPUP_GAS_MIST]);
      tx.transferObjects([gasCoin], this.address);
    }
    tx.moveCall({
      target: `${this.binding.packageId}::${moduleName}::deposit`,
      typeArguments: [usdcCoinType],
      arguments: [
        tx.object(this.binding.vaultId),
        coinWithBalance({ type: usdcCoinType, balance: usdcUnits }),
      ],
    });
    return tx;
  }

  /** 等交易最終落地（加值後刷新額度前用）。 */
  async waitForSettled(txDigest: string): Promise<void> {
    try {
      await this.client.waitForTransaction({ digest: txDigest });
    } catch (e) {
      throw wrapChainError(e, this.network);
    }
  }

  /**
   * 授權交易上鏈後，從 VaultCreated 事件取出 vault_id / cap_id 並落地綁定。
   * 事件讀不到時退回「掃 agent 名下的 AgentCap 物件」。
   */
  async completeAuthorize(txDigest: string, packageId: string, moduleName: string): Promise<AgentBinding> {
    try {
      await this.client.waitForTransaction({ digest: txDigest });
    } catch (e) {
      throw wrapChainError(e, this.network);
    }
    let vaultId = "";
    let capId = "";
    let ownerAddress = "";
    // 主路徑：交易事件
    try {
      const result = await this.client.getTransaction({
        digest: txDigest,
        include: { events: true },
      });
      const txData = result.Transaction ?? result.FailedTransaction;
      for (const event of txData?.events ?? []) {
        if (event.eventType === `${packageId}::${moduleName}::VaultCreated` && event.json) {
          vaultId = String(event.json.vault_id ?? "");
          capId = String(event.json.cap_id ?? "");
          ownerAddress = String(event.json.owner ?? "");
        }
      }
    } catch { /* 走備援 */ }
    // 備援：掃 agent 名下的 AgentCap
    if (!vaultId || !capId) {
      const owned = await this.client.listOwnedObjects({
        owner: this.address,
        type: `${packageId}::${moduleName}::AgentCap`,
        include: { json: true },
      }).catch((e) => { throw wrapChainError(e, this.network); });
      const cap = owned.objects[owned.objects.length - 1];
      if (!cap) throw new Error("授權交易完成，但找不到 AgentCap——請把交易 digest 回報給我們檢查");
      capId = cap.objectId;
      vaultId = String((cap.json as Record<string, unknown> | null)?.vault_id ?? "");
      if (!vaultId) throw new Error("AgentCap 缺少 vault_id 欄位——合約版本不符？");
    }
    const binding: AgentBinding = { vaultId, capId, packageId, ownerAddress };
    this.binding = binding;
    await idbSet(BINDING_STORAGE, binding);
    return binding;
  }

  /** Vault 擁有者（用戶錢包）地址：綁定沒存到時退回讀鏈上 Vault。 */
  async ownerAddress(): Promise<string> {
    if (!this.binding) throw new Error("尚未授權");
    if (this.binding.ownerAddress) return this.binding.ownerAddress;
    const resp = await this.client
      .getObject({ objectId: this.binding.vaultId, include: { json: true } })
      .catch((e) => { throw wrapChainError(e, this.network); });
    const owner = String((resp.object.json as Record<string, unknown> | null)?.owner ?? "");
    if (!owner) throw new Error("讀不到 Vault 擁有者地址");
    this.binding = { ...this.binding, ownerAddress: owner };
    await idbSet(BINDING_STORAGE, this.binding);
    return owner;
  }

  /** 給 Seal／Walrus 存證模組共用同一個 fullnode 連線。 */
  get grpcClient(): SuiGrpcClient {
    return this.client;
  }

  /** 查授權狀態：Vault 額度、cap 是否有效、agent gas。 */
  async status(): Promise<AgentStatus> {
    const none: AgentStatus = {
      authorized: false, remainingUnits: 0n, perTxUnits: 0n,
      spentUnits: 0n, capActive: false, gasMist: 0n,
    };
    if (!this.binding) return none;
    try {
      const [vaultResp, capResp, gas] = await Promise.all([
        this.client.getObject({ objectId: this.binding.vaultId, include: { json: true } }),
        this.client.getObject({ objectId: this.binding.capId, include: { json: true } }),
        this.client.getBalance({ owner: this.address, coinType: "0x2::sui::SUI" }),
      ]);
      const vault = (vaultResp.object.json ?? {}) as Record<string, unknown>;
      const cap = (capResp.object.json ?? {}) as Record<string, unknown>;
      // Balance 欄位在 json 表示裡通常是字串數值；funds 可能是 {value} 或純數值
      const funds = vault.funds as Record<string, unknown> | string | number | undefined;
      const remaining = BigInt(String(
        (typeof funds === "object" && funds !== null ? (funds.value ?? 0) : funds) ?? 0,
      ));
      return {
        authorized: true,
        remainingUnits: remaining,
        perTxUnits: BigInt(String(vault.per_tx_limit ?? 0)),
        spentUnits: BigInt(String(vault.spent ?? 0)),
        capActive: String(vault.cap_version ?? "") === String(cap.version ?? "-"),
        gasMist: BigInt(gas.balance?.balance ?? 0),
      };
    } catch (e) {
      throw wrapChainError(e, this.network);
    }
  }

  /** 自動結算：agent 簽 agent_settle，合約守限額，錢從 Vault 直達商家。 */
  async payAuto(checkout: CheckoutParams): Promise<string> {
    if (!checkout.package_id) throw new Error("結帳參數缺少 package_id（合約尚未部署？）");
    if (!this.binding) throw new Error("尚未授權：請先完成一次性授權（放錢進你的 Vault）");
    // 舊 Vault 打新合約會在 resolve 階段炸 TypeMismatch（真機踩過）——
    // 這裡先擋下來，給人看得懂的原因與出路
    if (this.binding.packageId !== checkout.package_id) {
      throw new Error(
        "你的授權屬於「舊版合約」的 Vault，無法用於目前的合約——" +
        "請先用畫面上的「領回舊 Vault 資金」拿回餘額，再重新授權");
    }

    const status = await this.status();
    if (!status.capActive) {
      throw new Error("授權已被撤銷——如要繼續使用請重新授權");
    }
    if (status.remainingUnits < BigInt(checkout.amount_units)) {
      throw new Error(
        `額度不足：這筆需要 ${(checkout.amount_units / 1_000_000).toFixed(2)} USDC、` +
        `Vault 只剩 ${(Number(status.remainingUnits) / 1_000_000).toFixed(2)} USDC——請再授權加值`,
      );
    }
    if (status.gasMist < MIN_GAS_MIST) {
      throw new Error("Agent 的 gas（SUI）不足——請重新授權以補充 gas");
    }

    const tx = new Transaction();
    tx.setSender(this.address);
    tx.moveCall({
      target: `${checkout.package_id}::${checkout.module}::${checkout.function}`,
      typeArguments: [checkout.coin_type],
      arguments: [
        tx.object(this.binding.vaultId),
        tx.object(this.binding.capId),
        tx.pure.u64(BigInt(checkout.amount_units)),
        tx.pure.address(checkout.merchant_address),
        tx.pure.vector("u8", Array.from(hexToBytes(checkout.order_digest_hex))),
      ],
    });
    let result;
    try {
      result = await this.client.signAndExecuteTransaction({ transaction: tx, signer: this.keypair });
    } catch (e) {
      throw wrapChainError(e, this.network);
    }
    if (result.$kind === "FailedTransaction") {
      throw new Error(`結算交易上鏈失敗（digest ${result.FailedTransaction.digest}）——請查 explorer 的 abort 原因`);
    }
    const digest = result.Transaction.digest;
    try {
      await this.client.waitForTransaction({ digest });
    } catch { /* 已有 digest，驗證交給 Hub */ }
    return digest;
  }

  /** 撤銷授權交易（由用戶的 Slush 簽）：所有 cap 立即失效。 */
  buildRevokeTransaction(moduleName: string, usdcCoinType: string): Transaction {
    if (!this.binding) throw new Error("尚未授權，無可撤銷");
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.binding.packageId}::${moduleName}::revoke_caps`,
      typeArguments: [usdcCoinType],
      arguments: [tx.object(this.binding.vaultId)],
    });
    return tx;
  }

  /** 一鍵離場交易（由用戶的 Slush 簽）：撤銷所有授權＋領回全部 USDC，
   * 同一筆交易完成——按下去的瞬間 Agent 就再也動不了任何一毛錢。 */
  buildExitTransaction(moduleName: string, usdcCoinType: string): Transaction {
    if (!this.binding) throw new Error("尚未授權，沒有可領回的 Vault");
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.binding.packageId}::${moduleName}::revoke_caps`,
      typeArguments: [usdcCoinType],
      arguments: [tx.object(this.binding.vaultId)],
    });
    tx.moveCall({
      target: `${this.binding.packageId}::${moduleName}::withdraw`,
      typeArguments: [usdcCoinType],
      arguments: [tx.object(this.binding.vaultId)],
    });
    return tx;
  }

  /** 領回剩餘資金交易（由用戶的 Slush 簽）。 */
  buildWithdrawTransaction(moduleName: string, usdcCoinType: string): Transaction {
    if (!this.binding) throw new Error("尚未授權，無可領回");
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.binding.packageId}::${moduleName}::withdraw`,
      typeArguments: [usdcCoinType],
      arguments: [tx.object(this.binding.vaultId)],
    });
    return tx;
  }
}
