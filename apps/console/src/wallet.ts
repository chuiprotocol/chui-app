/** 消費者錢包。
 *
 * 兩種模式：
 * 1. zkLogin（Google）：正式路徑。ephemeral key + zkLogin 簽章，
 *    不需要助記詞；gas 由 Chui 贊助。
 * 2. 測試錢包（ed25519）：在瀏覽器產生真實的 Sui keypair，
 *    私鑰只存 IndexedDB。所有簽章都是真簽章，沒有任何模擬。
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from "@mysten/sui/zklogin";
import { fromBase64 } from "@mysten/sui/utils";
import { api } from "./api.js";
import { idbGet, idbSet, idbDelete } from "./idb.js";

export interface WalletSession {
  kind: "ed25519" | "zklogin";
  address: string;
}

// ---- 測試錢包（ed25519）----

const ED_KEY = "wallet.ed25519.secret";

export async function loadOrCreateTestWallet(): Promise<Ed25519Keypair> {
  const stored = await idbGet<string>(ED_KEY);
  if (stored) {
    const { secretKey } = decodeSuiPrivateKey(stored);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const kp = new Ed25519Keypair();
  await idbSet(ED_KEY, kp.getSecretKey());
  return kp;
}

export async function clearTestWallet(): Promise<void> {
  await idbDelete(ED_KEY);
}

// ---- zkLogin ----

interface ZkState {
  ephemeralSecret: string;      // bech32 suiprivkey
  randomness: string;
  maxEpoch: number;
}

interface ZkSession {
  address: string;
  salt: string;
  jwt: string;
  proof: unknown;               // prover 回傳的 zk proof inputs（不含 addressSeed）
  ephemeralSecret: string;
  maxEpoch: number;
}

const ZK_STATE_KEY = "wallet.zklogin.pending";
const ZK_SESSION_KEY = "wallet.zklogin.session";

/** 第一步：產生 ephemeral key 與 nonce，導向 Google OAuth。 */
export async function startZkLogin(googleClientId: string, currentEpoch: number): Promise<void> {
  const ephemeral = new Ed25519Keypair();
  const maxEpoch = currentEpoch + 10; // ephemeral key 約可用 10 個 epoch（testnet 約 10 天）
  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);
  const state: ZkState = { ephemeralSecret: ephemeral.getSecretKey(), randomness, maxEpoch };
  await idbSet(ZK_STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: googleClientId,
    response_type: "id_token",
    redirect_uri: window.location.origin + window.location.pathname,
    scope: "openid",
    nonce,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** 第二步：OAuth 回跳後，用 JWT 換 salt、算地址、取得 zk proof。 */
export async function completeZkLogin(proverUrl: string): Promise<ZkSession | null> {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const jwt = hash.get("id_token");
  if (!jwt) return null;
  const state = await idbGet<ZkState>(ZK_STATE_KEY);
  if (!state) throw new Error("找不到 zkLogin 起始狀態，請重新登入");
  history.replaceState(null, "", window.location.pathname); // 把 token 從網址列拿掉

  const { salt } = await api<{ salt: string }>("POST", "/v1/auth/zklogin-salt", { jwt });
  // 第三個參數 legacyAddress 在 SDK v2 為必填；一律使用新版地址推導
  const address = jwtToAddress(jwt, BigInt(salt), false);

  const { secretKey } = decodeSuiPrivateKey(state.ephemeralSecret);
  const ephemeral = Ed25519Keypair.fromSecretKey(secretKey);
  const extendedPk = getExtendedEphemeralPublicKey(ephemeral.getPublicKey());

  const proofResp = await fetch(proverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jwt,
      extendedEphemeralPublicKey: extendedPk,
      maxEpoch: state.maxEpoch,
      jwtRandomness: state.randomness,
      salt,
      keyClaimName: "sub",
    }),
  });
  if (!proofResp.ok) {
    throw new Error(`zkLogin prover 失敗（HTTP ${proofResp.status}）：${await proofResp.text()}`);
  }
  const proof = await proofResp.json();
  const session: ZkSession = {
    address, salt, jwt, proof,
    ephemeralSecret: state.ephemeralSecret,
    maxEpoch: state.maxEpoch,
  };
  await idbSet(ZK_SESSION_KEY, session);
  await idbDelete(ZK_STATE_KEY);
  return session;
}

export async function loadZkSession(): Promise<ZkSession | null> {
  return (await idbGet<ZkSession>(ZK_SESSION_KEY)) ?? null;
}

export async function clearZkSession(): Promise<void> {
  await idbDelete(ZK_SESSION_KEY);
}

// ---- 簽章（兩種模式統一介面）----

export interface Signer {
  address: string;
  signPersonalMessage(message: Uint8Array): Promise<string>;
  signTransaction(txBytes: Uint8Array): Promise<string>;
}

export function ed25519Signer(kp: Ed25519Keypair): Signer {
  return {
    address: kp.getPublicKey().toSuiAddress(),
    async signPersonalMessage(message) {
      const { signature } = await kp.signPersonalMessage(message);
      return signature;
    },
    async signTransaction(txBytes) {
      const { signature } = await kp.signTransaction(txBytes);
      return signature;
    },
  };
}

export function zkLoginSigner(session: ZkSession): Signer {
  const { secretKey } = decodeSuiPrivateKey(session.ephemeralSecret);
  const ephemeral = Ed25519Keypair.fromSecretKey(secretKey);
  const wrap = (userSignature: string) =>
    getZkLoginSignature({
      inputs: session.proof as Parameters<typeof getZkLoginSignature>[0]["inputs"],
      maxEpoch: session.maxEpoch,
      userSignature,
    });
  return {
    address: session.address,
    async signPersonalMessage(message) {
      const { signature } = await ephemeral.signPersonalMessage(message);
      return wrap(signature);
    },
    async signTransaction(txBytes) {
      const { signature } = await ephemeral.signTransaction(txBytes);
      return wrap(signature);
    },
  };
}

/** 用錢包對 API 做 challenge/response 登入，取得 httpOnly session cookie */
export async function loginWithSigner(signer: Signer): Promise<{ consumer_id: string }> {
  const { challenge, message_to_sign } = await api<{ challenge: string; message_to_sign: string }>(
    "POST", "/v1/auth/challenge",
  );
  const signature = await signer.signPersonalMessage(new TextEncoder().encode(message_to_sign));
  return api("POST", "/v1/auth/login", { address: signer.address, challenge, signature });
}

export function txBytesFromB64(b64: string): Uint8Array {
  return fromBase64(b64);
}
