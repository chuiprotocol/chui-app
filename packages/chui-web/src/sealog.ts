/** 點餐對話紀錄的端對端加密存證（Seal ＋ Walrus）。
 *
 * 隱私設計：
 * - 對話 log 在「用戶的瀏覽器」內用 Mysten Seal（門檻式 IBE）加密，
 *   身分 id ＝ 用戶地址(32B) ‖ 店家地址(32B)。
 * - 密文直接從瀏覽器上傳 Walrus（去中心化 blob 儲存）——
 *   嘴付平台（Hub）從頭到尾接觸不到明文，也拿不到金鑰。
 * - 解密時 Seal key server 會 dry-run 鏈上 `chui::log_policy::seal_approve`：
 *   只有「id 裡的用戶或店家」簽名請求才發金鑰。平台無權看。
 */

import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

export interface SealogConfig {
  /** chui 合約 package（內含 log_policy 模組） */
  packageId: string;
  /** Seal key server 物件 id（testnet 公開伺服器，由 Hub /healthz 提供） */
  keyServerIds: string[];
  /** Walrus publisher／aggregator base URL（由 Hub /healthz 提供；
   *  陣列＝依序輪替，公共 testnet 節點偶爾陣亡，多備援才穩） */
  walrusPublishers: string[];
  walrusAggregators: string[];
}

export interface LogEntry {
  role: "user" | "agent" | "system";
  text: string;
  ts: number;
}

export interface SealedLogResult {
  blobId: string;
  /** 密文在 Walrus 上的公開網址（拿到也解不開） */
  blobUrl: string;
  /** Seal 身分 id（hex）：用戶地址‖店家地址 */
  idHex: string;
}

function addressBytes(addr: string): Uint8Array {
  const hex = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (hex.length !== 64) throw new Error(`地址格式錯誤：${addr}`);
  return fromHex(hex);
}

/** 身分 id：owner(32B) ‖ merchant(32B) → 鏈上 seal_approve 據此驗身分 */
export function buildLogIdHex(ownerAddr: string, merchantAddr: string): string {
  const id = new Uint8Array(64);
  id.set(addressBytes(ownerAddr), 0);
  id.set(addressBytes(merchantAddr), 32);
  return toHex(id);
}

/** 從 Hub /healthz 回應組出 SealLogVault（設定不齊回 null）。 */
export function sealogFromHealth(
  suiClient: SuiGrpcClient,
  health: Record<string, unknown>,
): SealLogVault | null {
  const asList = (plural: unknown, single: unknown): string[] => {
    if (Array.isArray(plural) && plural.length) return plural.map(String);
    return single ? [String(single)] : [];
  };
  try {
    return new SealLogVault(suiClient, {
      packageId: String(health.package_id ?? ""),
      keyServerIds: (health.seal_key_servers as string[] | undefined) ?? [],
      walrusPublishers: asList(health.walrus_publishers, health.walrus_publisher),
      walrusAggregators: asList(health.walrus_aggregators, health.walrus_aggregator),
    });
  } catch {
    return null;
  }
}

export class SealLogVault {
  private sealClient: SealClient;

  constructor(
    private readonly suiClient: SuiGrpcClient,
    private readonly config: SealogConfig,
  ) {
    if (!config.packageId) throw new Error("缺少 package_id，無法建立加密存證");
    if (!config.keyServerIds.length) throw new Error("Hub 未提供 Seal key server 設定");
    if (!config.walrusPublishers.length || !config.walrusAggregators.length) {
      throw new Error("Hub 未提供 Walrus 節點設定");
    }
    this.sealClient = new SealClient({
      suiClient: suiClient as never,
      serverConfigs: config.keyServerIds.map((objectId) => ({ objectId, weight: 1 })),
      // demo：不驗證 key server 憑證鏈（省一輪往返）；正式環境應開啟
      verifyKeyServers: false,
    });
  }

  /** 加密整段對話並上傳 Walrus。回傳 blobId（永遠只有密文出門）。 */
  async encryptAndUpload(
    entries: LogEntry[],
    ownerAddr: string,
    merchantAddr: string,
    meta: Record<string, unknown> = {},
  ): Promise<SealedLogResult> {
    const idHex = buildLogIdHex(ownerAddr, merchantAddr);
    const plaintext = new TextEncoder().encode(JSON.stringify({
      v: 1,
      owner: ownerAddr,
      merchant: merchantAddr,
      created_at: Date.now(),
      meta,
      entries,
    }));
    let encryptedObject: Uint8Array;
    try {
      ({ encryptedObject } = await this.sealClient.encrypt({
        threshold: 1,
        packageId: this.config.packageId,
        id: idHex,
        data: plaintext,
      }));
    } catch (e) {
      throw new Error(`Seal 加密失敗（key server 連線或政策問題）：${(e as Error).message}`);
    }
    // 密文上 Walrus（5 個 epoch；公共 testnet publisher 偶爾陣亡→依序輪替）
    let lastError = "";
    for (const publisher of this.config.walrusPublishers) {
      try {
        const resp = await fetch(`${publisher}/v1/blobs?epochs=5`, {
          method: "PUT",
          body: new Uint8Array(encryptedObject) as unknown as BodyInit,
        });
        if (!resp.ok) {
          lastError = `${publisher} 回 ${resp.status}`;
          continue;
        }
        const body = await resp.json();
        const blobId: string | undefined =
          body?.newlyCreated?.blobObject?.blobId ?? body?.alreadyCertified?.blobId;
        if (!blobId) { lastError = `${publisher} 回應缺少 blobId`; continue; }
        return {
          blobId,
          blobUrl: `${this.config.walrusAggregators[0]}/v1/blobs/${blobId}`,
          idHex,
        };
      } catch (e) {
        lastError = `${publisher}：${(e as Error).message}`;
      }
    }
    throw new Error(
      `Walrus 上傳失敗（試了 ${this.config.walrusPublishers.length} 個 publisher，` +
      `最後錯誤：${lastError}）`);
  }

  /**
   * 解密一份 Walrus 上的 log。
   * signPersonalMessage：由「用戶自己的錢包」（Slush）簽 Seal session key
   * 的個人訊息——這一步就是「只有當事人拿得到鑰匙」的落地。
   */
  async fetchAndDecrypt(
    blobId: string,
    requesterAddr: string,
    signPersonalMessage: (message: Uint8Array) => Promise<string>,
  ): Promise<{ owner: string; merchant: string; entries: LogEntry[]; meta: Record<string, unknown> }> {
    let ciphertext: Uint8Array | null = null;
    let lastError = "";
    for (const aggregator of this.config.walrusAggregators) {
      try {
        const resp = await fetch(`${aggregator}/v1/blobs/${blobId}`);
        if (!resp.ok) { lastError = `${aggregator} 回 ${resp.status}`; continue; }
        ciphertext = new Uint8Array(await resp.arrayBuffer());
        break;
      } catch (e) {
        lastError = `${aggregator}：${(e as Error).message}`;
      }
    }
    if (ciphertext === null) throw new Error(`Walrus 下載失敗：${lastError}`);
    // 密文自帶身分 id——不用外部記錄
    const parsed = EncryptedObject.parse(ciphertext);
    const idHex = parsed.id;

    const sessionKey = await SessionKey.create({
      address: requesterAddr,
      packageId: this.config.packageId,
      ttlMin: 10,
      suiClient: this.suiClient as never,
    });
    const signature = await signPersonalMessage(sessionKey.getPersonalMessage());
    await sessionKey.setPersonalMessageSignature(signature);

    // key server 會以 requester 為 sender dry-run 這筆 seal_approve
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::log_policy::seal_approve`,
      arguments: [tx.pure.vector("u8", Array.from(fromHex(idHex)))],
    });
    const txBytes = await tx.build({ client: this.suiClient as never, onlyTransactionKind: true });

    const plaintext = await this.sealClient.decrypt({ data: ciphertext, sessionKey, txBytes });
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
}
