/** Slush（Wallet Standard）USDC 結帳。
 *
 * 使用者在 Slush 手機 App 的內建瀏覽器開啟商家官網時，
 * Wallet Standard 會自動偵測到錢包——不需要任何額外 SDK。
 * 交易內容：chui::pay::settle<USDC>(coinWithBalance(金額), 店家地址, 訂單digest)
 * ——coin 直接轉給店家（非託管），鏈上只留 digest。
 */

import {
  getWallets,
  isWalletWithRequiredFeatureSet,
  signAndExecuteTransaction,
  type Wallet,
  type WalletAccount,
  type WalletWithFeatures,
  type MinimallyRequiredFeatures,
} from "@mysten/wallet-standard";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import type { CheckoutParams } from "./hub.js";

type SuiWallet = WalletWithFeatures<MinimallyRequiredFeatures>;

/** 找出頁面上可用的 Sui 錢包（Slush 等）。晚註冊的錢包也等得到。 */
export async function findSuiWallet(timeoutMs = 3000): Promise<SuiWallet> {
  const api = getWallets();
  const pick = (): SuiWallet | undefined =>
    api.get().find((w: Wallet) =>
      isWalletWithRequiredFeatureSet(w, ["sui:signAndExecuteTransaction"]),
    ) as SuiWallet | undefined;

  const now = pick();
  if (now) return now;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(
        "找不到 Sui 錢包。請用 Slush App 的內建瀏覽器開啟本頁（或安裝 Slush 擴充功能）。",
      ));
    }, timeoutMs);
    const off = api.on("register", () => {
      const found = pick();
      if (found) {
        clearTimeout(timer);
        off();
        resolve(found);
      }
    });
  });
}

export interface PayResult {
  txDigest: string;
  account: WalletAccount;
}

/** 用「使用者的」錢包（Slush）簽名並執行任意交易——一次性授權撥款用。 */
export async function signAndExecuteWithUserWallet(
  tx: Transaction,
  network: string,
): Promise<{ txDigest: string; account: WalletAccount }> {
  const wallet = await findSuiWallet();
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts[0];
  if (!account) throw new Error("錢包沒有可用帳戶");
  // coinWithBalance 等 intent 在序列化時就需要 sender 才能解析——
  // 連上錢包拿到地址後立刻補上（錢包端仍會覆核）
  tx.setSenderIfNotSet(account.address);
  const result = await signAndExecuteTransaction(wallet, {
    transaction: tx,
    account,
    chain: `sui:${network}` as `${string}:${string}`,
  });
  return { txDigest: result.digest, account };
}

/** 連線錢包並簽名執行結算交易。回傳鏈上交易 digest。 */
export async function payWithSuiWallet(checkout: CheckoutParams): Promise<PayResult> {
  if (!checkout.package_id) {
    throw new Error("結帳參數缺少 package_id（合約尚未部署？）");
  }
  const wallet = await findSuiWallet();
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts[0];
  if (!account) throw new Error("錢包沒有可用帳戶");

  const digestBytes = hexToBytes(checkout.order_digest_hex);
  const tx = new Transaction();
  tx.setSender(account.address); // coinWithBalance 解析需要 sender
  // 錢包會自行補 sender 與 gas；coinWithBalance 從使用者的 USDC 切出精確金額
  tx.moveCall({
    target: `${checkout.package_id}::${checkout.module}::${checkout.function}`,
    typeArguments: [checkout.coin_type],
    arguments: [
      coinWithBalance({ type: checkout.coin_type, balance: BigInt(checkout.amount_units) }),
      tx.pure.address(checkout.merchant_address),
      tx.pure.vector("u8", Array.from(digestBytes)),
    ],
  });

  // 便利函式會自動 fallback 舊版 feature 並把回傳正規化
  const result = await signAndExecuteTransaction(wallet, {
    transaction: tx,
    account,
    chain: `sui:${checkout.network}` as `${string}:${string}`,
  });
  return { txDigest: result.digest, account };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
