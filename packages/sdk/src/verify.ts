/** 收據驗證：解密明細、重算 digest、與鏈上 digest 比對。
 *
 * 這是消費者「不必信任 Chui」就能驗證帳目的工具：
 * 只要有明細密文＋salt（伺服器提供）與金鑰（消費者持有），
 * 就能證明鏈上 digest 對應的正是這份明細。
 */

/** 決定性 JSON 序列化：鍵排序、無空白，與伺服器端 canonical_json 完全一致 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("binary") : atob(b64);
  // 一律配置全新的 ArrayBuffer，滿足 WebCrypto 的 BufferSource 型別要求
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** AES-256-GCM 解密訂單明細（金鑰由消費者持有） */
export async function decryptOrderDetails(
  ciphertextB64: string,
  nonceB64: string,
  keyB64: string,
): Promise<Record<string, unknown>> {
  const key = await crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(nonceB64) },
    key,
    b64ToBytes(ciphertextB64),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** 重算 salted digest：SHA-256(canonical_json(details) ‖ salt) */
export async function computeOrderDigest(
  details: Record<string, unknown>,
  saltHex: string,
): Promise<string> {
  const detailBytes = new TextEncoder().encode(canonicalJson(details));
  const salt = hexToBytes(saltHex);
  const joined = new Uint8Array(new ArrayBuffer(detailBytes.length + salt.length));
  joined.set(detailBytes);
  joined.set(salt, detailBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", joined);
  return bytesToHex(new Uint8Array(hash));
}

export interface VerifyResult {
  ok: boolean;
  computedDigest: string;
  expectedDigest: string;
  details?: Record<string, unknown>;
}

/** 一步到位：解密 → 重算 → 比對 */
export async function verifyReceipt(input: {
  ciphertextB64: string;
  nonceB64: string;
  keyB64: string;
  saltHex: string;
  expectedDigestHex: string;
}): Promise<VerifyResult> {
  const details = await decryptOrderDetails(input.ciphertextB64, input.nonceB64, input.keyB64);
  const computedDigest = await computeOrderDigest(details, input.saltHex);
  return {
    ok: computedDigest === input.expectedDigestHex,
    computedDigest,
    expectedDigest: input.expectedDigestHex,
    details,
  };
}
