/** 訂單 digest（TypeScript 移植版，對齊 apps/api/chui_api/crypto.py）。
 *
 * 上鏈內容只有 SHA-256(canonical_json ‖ salt)，salt 為每筆訂單全新的
 * 32 bytes CSPRNG 隨機值。digest 只需「同一個 Hub 產生與驗證」自我一致——
 * 前端拿它上鏈、驗證時跟鏈上事件比對的都是這裡算出的值。
 */

/** 決定性序列化：鍵排序、無多餘空白、UTF-8（等價 Python 的
 * json.dumps(sort_keys=True, separators=(",",":"))，值域限 JSON 基本型別）。 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj === "number" || typeof obj === "boolean") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(obj as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 每筆訂單全新的 32 bytes CSPRNG salt。 */
export function newSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 上鏈用 digest：SHA-256(canonical_json(details) ‖ salt)，hex 字串。 */
export async function orderDigest(details: unknown, salt: Uint8Array): Promise<string> {
  const json = new TextEncoder().encode(canonicalJson(details));
  const buf = new Uint8Array(json.length + salt.length);
  buf.set(json, 0);
  buf.set(salt, json.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(hash));
}
