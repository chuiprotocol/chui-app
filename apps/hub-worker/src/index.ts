/** Worker 入口：CORS＋轉發到單例 Durable Object（訂單狀態、單號流水、
 * SSE 匯流排都在那顆 DO 裡，天然無競態）。 */

import type { Env } from "./external.js";

export { ChuiHubDO } from "./hubdo.js";

const CORS_HEADERS: Record<string, string> = {
  // demo：商家官網與語音 App 各自的 origin 都要能打（同本機版設定）
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const stub = env.HUB_DO.get(env.HUB_DO.idFromName("hub"));
    const resp = await stub.fetch(request);
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;
