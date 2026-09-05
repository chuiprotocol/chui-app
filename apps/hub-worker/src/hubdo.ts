/** ChuiHubDO：雲端 Hub 的心臟（Durable Object，SQLite 持久化）。
 *
 * 一顆 DO 承擔三件事（對齊本機版的 store.py＋bus.py＋main.py 業務邏輯）：
 * 1. 訂單儲存——SQLite 表，跨重啟持久化（取代 MongoDB Atlas 的角色）
 * 2. 取餐單號流水——日期前綴＋持久化流水號，永不重複（FC-0905-0001）
 * 3. 封包匯流排——面板／店家看板的 SSE 即時流
 * 業務端點（parse／confirm／settlement…）也在這裡處理：DO 是單一
 * 執行緒 actor，訂單狀態流轉天然無競態。
 */

import { newSalt, orderDigest } from "./crypto.js";
import {
  assistEnabled, assistProvider, effectiveUnitsPerTwd, rephraseOrder,
  sttChain, transcribe, SttUnavailableError, type Env,
} from "./external.js";
import { getMerchant, MERCHANTS, type BuiltinMerchant } from "./merchants.js";
import { quoteItems, readbackText, validateMenu, type QuoteLine } from "./menu.js";
import { ensurePinyin } from "./phonetics.js";
import { RerankEngine, type Menu, type ParseResult } from "./rerank.js";
import { explorerTxUrl, suiNetwork, verifySettlement } from "./verify.js";
import panelHtml from "./panel.html";

const USDC_COIN_TYPE_DEFAULT =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

// Seal／Walrus 預設值＝Mysten 官方 testnet 公開節點（同本機版 main.py）
const SEAL_KEY_SERVERS_DEFAULT =
  "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75," +
  "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8";
const WALRUS_PUBLISHERS_DEFAULT =
  "https://publisher.walrus-testnet.walrus.space," +
  "https://wal-publisher-testnet.staketab.org," +
  "https://walrus-testnet-publisher.nodes.guru";
const WALRUS_AGGREGATORS_DEFAULT =
  "https://aggregator.walrus-testnet.walrus.space," +
  "https://wal-aggregator-testnet.staketab.org," +
  "https://walrus-testnet-aggregator.nodes.guru";

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

type Order = Record<string, unknown> & {
  order_id: string;
  merchant_id: string;
  lines: QuoteLine[];
  total: number;
  digest_hex: string;
  salt_hex: string;
  amount_units: number;
  status: string;
  merchant_ref: string;
  tx_digest: string;
  verify_reason: string;
  owner_address?: string;
  log_blob_id?: string;
  created_at: number;
};

interface BusEvent {
  seq: number; ts: number; from: string; to: string; kind: string;
  summary: string; payload: Record<string, unknown>;
}

class HttpError extends Error {
  constructor(public code: string, message: string, public status: number,
              public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export class ChuiHubDO implements DurableObject {
  private sql: SqlStorage;
  private env: Env;
  private engines = new Map<string, RerankEngine>();
  private busSeq = 0;
  private busHistory: BusEvent[] = [];
  private subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders(
      order_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL DEFAULT '',
      owner_address TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ticket_seq(
      merchant_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      seq INTEGER NOT NULL
    )`);
    // 自助入駐的店家（Slush 簽名證明收款地址所有權後寫入；
    // 內建兩家 demo 店在 merchants.ts，查詢時合併）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS merchants(
      merchant_id TEXT PRIMARY KEY,
      payout_address TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      ticket_prefix TEXT NOT NULL,
      menu TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  // ---- 訂單儲存（SQLite；等價本機版 OrderStore） ----

  private saveOrder(order: Order): void {
    this.sql.exec(
      `INSERT INTO orders(order_id, merchant_id, owner_address, created_at, data)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         merchant_id=excluded.merchant_id, owner_address=excluded.owner_address,
         created_at=excluded.created_at, data=excluded.data`,
      order.order_id, order.merchant_id, String(order.owner_address ?? ""),
      order.created_at, JSON.stringify(order),
    );
  }

  private getOrder(orderId: string): Order {
    const row = this.sql.exec("SELECT data FROM orders WHERE order_id = ?", orderId).toArray()[0];
    if (!row) throw new HttpError("NOT_FOUND", `訂單 ${orderId} 不存在`, 404);
    return JSON.parse(String(row.data)) as Order;
  }

  private listOrdersBy(field: "merchant_id" | "owner_address", value: string, limit = 100): Order[] {
    const rows = this.sql.exec(
      `SELECT data FROM orders WHERE ${field} = ? ORDER BY created_at DESC LIMIT ?`,
      value, limit,
    ).toArray();
    return rows.map((r) => JSON.parse(String(r.data)) as Order);
  }

  /** 取餐單號：日期前綴＋SQLite 持久化流水號——跨重啟不歸零、永不重複。
   * 日期取台灣時間（UTC+8），與店家出餐現場一致。 */
  private nextOrderRef(merchant: BuiltinMerchant): string {
    const tw = new Date(Date.now() + 8 * 3600 * 1000);
    const today = `${String(tw.getUTCMonth() + 1).padStart(2, "0")}${String(tw.getUTCDate()).padStart(2, "0")}`;
    const row = this.sql.exec(
      "SELECT date, seq FROM ticket_seq WHERE merchant_id = ?", merchant.merchant_id,
    ).toArray()[0];
    const seq = row && String(row.date) === today ? Number(row.seq) + 1 : 1;
    this.sql.exec(
      `INSERT INTO ticket_seq(merchant_id, date, seq) VALUES(?, ?, ?)
       ON CONFLICT(merchant_id) DO UPDATE SET date=excluded.date, seq=excluded.seq`,
      merchant.merchant_id, today, seq,
    );
    return `${merchant.ticket_prefix}-${today}-${String(seq).padStart(4, "0")}`;
  }

  // ---- 封包匯流排（SSE；等價本機版 PacketBus） ----

  private emit(from: string, to: string, kind: string, summary: string,
               payload: Record<string, unknown> = {}): void {
    this.busSeq += 1;
    const event: BusEvent = {
      seq: this.busSeq, ts: Math.round(Date.now()) / 1000,
      from, to, kind, summary, payload,
    };
    this.busHistory.push(event);
    if (this.busHistory.length > 200) this.busHistory.shift();
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of [...this.subscribers]) {
      try {
        controller.enqueue(chunk);
      } catch {
        this.subscribers.delete(controller); // 面板斷線就放生，不影響主流程
      }
    }
  }

  private sseResponse(): Response {
    const encoder = new TextEncoder();
    const subscribers = this.subscribers;
    const history = [...this.busHistory];
    let held: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        held = controller;
        for (const event of history) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        subscribers.add(controller);
      },
      cancel() {
        subscribers.delete(held);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  // ---- 商家 registry（內建 demo 店＋自助入駐店，合併查詢） ----

  private rowToMerchant(row: Record<string, unknown>): BuiltinMerchant {
    return {
      merchant_id: String(row.merchant_id),
      name: String(row.name),
      integration: "native",
      payout_address: String(row.payout_address),
      web_url: `https://chuiprotocol.com/?m=${String(row.merchant_id)}`,
      ticket_prefix: String(row.ticket_prefix),
      menu: JSON.parse(String(row.menu)),
    };
  }

  private allMerchants(): BuiltinMerchant[] {
    const rows = this.sql.exec("SELECT * FROM merchants ORDER BY created_at").toArray();
    return [...MERCHANTS, ...rows.map((r) => this.rowToMerchant(r))];
  }

  private merchantById(id: string): BuiltinMerchant | undefined {
    const builtin = getMerchant(id);
    if (builtin) return builtin;
    const row = this.sql.exec("SELECT * FROM merchants WHERE merchant_id = ?", id).toArray()[0];
    return row ? this.rowToMerchant(row) : undefined;
  }

  // ---- 重排序引擎（記憶體快取；商家菜單更新時失效） ----

  private engineFor(merchant: BuiltinMerchant): RerankEngine {
    let engine = this.engines.get(merchant.merchant_id);
    if (!engine) {
      engine = new RerankEngine(merchant.menu);
      this.engines.set(merchant.merchant_id, engine);
    }
    return engine;
  }

  // ---- 路由 ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === "/healthz") return this.healthz();
      if (path === "/" ) return json({ service: "Chui Hub（Cloudflare Worker）", panel: "/panel", spec: "見 repo 的 PROTOCOL.md" });
      if (path === "/panel") {
        return new Response(panelHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (path === "/v1/events") return this.sseResponse();
      if (path === "/v1/merchants" && method === "GET") return this.listMerchants();
      if (path === "/v1/merchants/register" && method === "POST") {
        return await this.registerMerchant(request);
      }

      let m = path.match(/^\/v1\/merchants\/([^/]+)\/menu$/);
      if (m && method === "GET") return this.merchantMenu(m[1]);
      m = path.match(/^\/v1\/merchants\/([^/]+)\/orders$/);
      if (m && method === "GET") return this.merchantOrders(m[1]);

      if (path === "/v1/orders/parse" && method === "POST") return await this.parseOrder(request);
      if (path === "/v1/orders/confirm" && method === "POST") return await this.confirmOrder(request);

      m = path.match(/^\/v1\/orders\/([^/]+)\/settlement$/);
      if (m && method === "POST") return await this.reportSettlement(m[1], request);
      m = path.match(/^\/v1\/orders\/([^/]+)\/verify$/);
      if (m && method === "POST") return await this.reverify(m[1]);
      m = path.match(/^\/v1\/orders\/([^/]+)\/logref$/);
      if (m && method === "POST") return await this.attachLogref(m[1], request);
      m = path.match(/^\/v1\/orders\/([^/]+)$/);
      if (m && method === "GET") return this.getOrderResponse(m[1]);

      if (path === "/v1/logs" && method === "GET") {
        return this.userOrders(url.searchParams.get("owner") ?? "");
      }
      return json({ detail: { code: "NOT_FOUND", message: `沒有這個端點：${method} ${path}` } }, 404);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ detail: { code: e.code, message: e.message, ...e.extra } }, e.status);
      }
      if (e instanceof SttUnavailableError) {
        return json({ detail: { code: e.code, message: e.message } }, e.status);
      }
      return json({ detail: { code: "INTERNAL", message: String((e as Error).message ?? e) } }, 500);
    }
  }

  // ---- 基本端點 ----

  private async healthz(): Promise<Response> {
    const [units, fxSource] = await effectiveUnitsPerTwd(this.env);
    return json({
      ok: true,
      runtime: "cloudflare-worker",
      network: suiNetwork(this.env),
      package_configured: Boolean(this.env.CHUI_PACKAGE_ID),
      package_id: this.env.CHUI_PACKAGE_ID ?? "",
      module: this.env.CHUI_MODULE ?? "vault",
      settle_function: this.env.CHUI_FN_SETTLE ?? "agent_settle",
      usdc_coin_type: this.env.CHUI_USDC_COIN_TYPE ?? USDC_COIN_TYPE_DEFAULT,
      usdc_units_per_twd: units,
      fx_source: fxSource,
      seal_key_servers: splitList(this.env.SEAL_KEY_SERVERS ?? SEAL_KEY_SERVERS_DEFAULT),
      walrus_publisher: splitList(this.env.WALRUS_PUBLISHERS ?? WALRUS_PUBLISHERS_DEFAULT)[0],
      walrus_aggregator: splitList(this.env.WALRUS_AGGREGATORS ?? WALRUS_AGGREGATORS_DEFAULT)[0],
      walrus_publishers: splitList(this.env.WALRUS_PUBLISHERS ?? WALRUS_PUBLISHERS_DEFAULT),
      walrus_aggregators: splitList(this.env.WALRUS_AGGREGATORS ?? WALRUS_AGGREGATORS_DEFAULT),
      order_store: "durable-object-sqlite",
      stt_chain: sttChain(this.env),
      llm_assist: assistEnabled(this.env) ? assistProvider(this.env) : "off",
      merchants: this.allMerchants().map((m) => m.merchant_id),
    });
  }

  /** 店家自助入駐：Slush 簽個人訊息證明「收款地址是我的」才能開店。
   * 平台自此不持有店家私鑰——錢包即店家身分（同地址重複註冊＝更新自己的店）。 */
  private async registerMerchant(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string; ticket_prefix?: string; payout_address?: string;
      menu?: Menu; signature?: string;
    };
    const name = String(body.name ?? "").trim();
    const prefix = String(body.ticket_prefix ?? "").trim().toUpperCase();
    const address = String(body.payout_address ?? "").trim().toLowerCase();
    if (!name || [...name].length > 20) {
      throw new HttpError("VALIDATION_FAILED", "店名必填、最長 20 字", 422);
    }
    // 前綴只取 2 字母就夠：店主錢包地址唯一（一錢包一店），
    // 取餐單號僅需店內唯一（日期＋流水已保證），前綴純粹是叫號辨識用
    if (!/^[A-Z]{2}$/.test(prefix)) {
      throw new HttpError("VALIDATION_FAILED", "取餐單號前綴需為 2 個大寫英文字母（例：TF）", 422);
    }
    if (!/^0x[0-9a-f]{64}$/.test(address)) {
      throw new HttpError("VALIDATION_FAILED", "收款地址格式不正確（需為 0x 開頭的 Sui 地址）", 422);
    }
    if (!body.menu || !Array.isArray(body.menu.items) || body.menu.items.length > 30) {
      throw new HttpError("VALIDATION_FAILED", "菜單必填、品項最多 30 項", 422);
    }
    validateMenu(body.menu);
    if (MERCHANTS.some((m) => m.payout_address.toLowerCase() === address)) {
      throw new HttpError("VALIDATION_FAILED", "此地址已是內建 demo 店家的收款地址", 422);
    }
    if (!body.signature) throw new HttpError("VALIDATION_FAILED", "缺錢包簽名", 422);

    // 驗簽：訊息綁地址＋店名，簽得出來＝私鑰在店家手上（平台零代管）
    const message = new TextEncoder().encode(`chui-open-shop:v1:${address}:${name}`);
    let signer: string;
    try {
      // 動態 import：@mysten/sui 依賴在模組頂層有 Workers 禁止的全域操作。
      // zkLogin 帳戶（Google 登入型 Slush）的簽名要連鏈上驗證——必須帶
      // client 與 address，否則會炸「A Sui Client is required to verify
      // zkLogin signatures」（真機踩過）
      const [{ verifyPersonalMessageSignature }, { SuiGrpcClient }] = await Promise.all([
        import("@mysten/sui/verify"),
        import("@mysten/sui/grpc"),
      ]);
      const network = suiNetwork(this.env);
      const client = new SuiGrpcClient({
        network: network as "testnet",
        baseUrl: this.env.SUI_FULLNODE_URL || `https://fullnode.${network}.sui.io:443`,
      });
      const publicKey = await verifyPersonalMessageSignature(
        message, body.signature, { client, address });
      signer = publicKey.toSuiAddress().toLowerCase();
    } catch (e) {
      throw new HttpError("SIGNATURE_INVALID", `簽名驗證失敗：${(e as Error).message}`, 401);
    }
    if (signer !== address) {
      throw new HttpError("SIGNATURE_INVALID",
        "簽名者與收款地址不符——請用「收款地址那顆錢包」簽名", 401);
    }

    const merchantId = "m_" + address.slice(2, 12);
    this.sql.exec(
      `INSERT INTO merchants(merchant_id, payout_address, name, ticket_prefix, menu, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(payout_address) DO UPDATE SET
         name=excluded.name, ticket_prefix=excluded.ticket_prefix, menu=excluded.menu`,
      merchantId, address, name, prefix, JSON.stringify(body.menu),
      Math.floor(Date.now() / 1000),
    );
    this.engines.delete(merchantId); // 菜單可能更新——重排序引擎重建
    this.emit(`merchant:${merchantId}`, "hub", "chui.merchant.registered",
      `店家入駐：${name}（${merchantId}）`);
    return json({
      merchant_id: merchantId,
      name,
      web_url: `https://chuiprotocol.com/?m=${merchantId}`,
      dashboard_hint: "用同一顆錢包到「店家後台」連線即可看接單看板",
    });
  }

  private listMerchants(): Response {
    return json({
      merchants: this.allMerchants().map((m) => ({
        merchant_id: m.merchant_id, name: m.name, integration: m.integration,
        web_url: m.web_url,
        // 收款地址本來就是鏈上公開資訊；店家後台用它做「錢包即身分」
        payout_address: m.payout_address,
      })),
    });
  }

  private merchantMenu(merchantId: string): Response {
    const merchant = this.merchantById(merchantId);
    if (!merchant) throw new HttpError("NOT_FOUND", `registry 沒有商家 ${merchantId}`, 404);
    return json({ merchant_id: merchantId, name: merchant.name, menu: merchant.menu });
  }

  // ---- ① 解析 ----

  private async parseOrder(request: Request): Promise<Response> {
    await ensurePinyin(); // pinyin-pro 惰性載入（全域 scope 禁 setTimeout）
    const form = await request.formData();
    const text = form.get("text");
    const merchantId = form.get("merchant_id");
    // workers-types 的 FormData.get 型別窄成 string|null，實際上傳檔案時是 File
    const audio = form.get("audio") as unknown as File | string | null;
    const source = merchantId ? `web:${merchantId}` : "voice-app";

    let candidates: string[];
    if (audio && typeof audio === "object" && audio.size > 0) {
      this.emit(source, "hub", "chui.parse.audio", `語音輸入 ${audio.size} bytes`);
      candidates = await transcribe(this.env, audio);
      this.emit("hub", "hub", "stt.result", `STT：${candidates[0].slice(0, 40)}`);
    } else if (typeof text === "string" && text) {
      candidates = [text];
      this.emit(source, "hub", "chui.parse.text", `文字輸入：${text.slice(0, 40)}`);
    } else {
      throw new HttpError("VALIDATION_FAILED", "需要 text 或 audio 其中之一", 422);
    }

    const targets = merchantId
      ? [this.merchantById(String(merchantId))].filter((m): m is BuiltinMerchant => Boolean(m))
      : this.allMerchants();
    if (merchantId && !targets.length) {
      throw new HttpError("NOT_FOUND", `registry 沒有商家 ${merchantId}`, 404);
    }

    // 未指定 merchant_id 時對所有商家的封閉詞彙各解析一次，取信心度最高者路由
    const results: Array<[BuiltinMerchant, ParseResult]> = targets.map(
      (m) => [m, this.engineFor(m).parse(candidates)]);
    let [merchant, result] = results.reduce((a, b) => (b[1].confidence > a[1].confidence ? b : a));

    if (results.length > 1) {
      const ranking = [...results].sort((a, b) => b[1].confidence - a[1].confidence)
        .map(([m, r]) => `${m.name} ${r.confidence.toFixed(2)}`).join("、");
      this.emit("hub", "hub", "route.rank", `跨商家路由：${ranking}`);
    }

    if (!result.ok) {
      // LLM 備援：信心不足時請 LLM 把原文重述成「只含菜單詞彙」的標準句
      // 再解析一次。LLM 只做重述——重述句仍要過封閉詞彙解析、口頭確認
      // 與 5 秒防呆倒數，永不直接觸發扣款。
      if (assistEnabled(this.env)) {
        const menuNames: string[] = [];
        for (const m of targets) {
          for (const it of m.menu.items) {
            menuNames.push(it.name);
            for (const opt of it.options ?? []) menuNames.push(...opt.choices.map((c) => c.name));
          }
        }
        const rephrased = await rephraseOrder(this.env, result.source_text, menuNames);
        if (rephrased) {
          this.emit("hub", "hub", "llm.rephrase", `LLM 重述：${rephrased.slice(0, 40)}`);
          const retry: Array<[BuiltinMerchant, ParseResult]> = targets.map(
            (m) => [m, this.engineFor(m).parse([rephrased])]);
          const [m2, r2] = retry.reduce((a, b) => (b[1].confidence > a[1].confidence ? b : a));
          if (r2.ok) { merchant = m2; result = r2; }
        }
      }
      if (!result.ok) {
        this.emit("hub", source, "chui.clarify", result.clarification_question ?? "請再說一次");
        throw new HttpError("CLARIFICATION_NEEDED",
          result.clarification_question ?? "請再說一次", 422, {
            question: result.clarification_question,
            candidates: result.clarification_candidates ?? [],
            confidence: Math.round(result.confidence * 1000) / 1000,
            stt_text: result.source_text,
          });
      }
    }

    const [lines, total] = quoteItems(merchant.menu, result.items);
    const readback = readbackText(lines, total);
    const salt = newSalt();
    const createdAt = Math.floor(Date.now() / 1000);
    const details = { merchant_id: merchant.merchant_id, lines, total, created_at: createdAt };
    const digestHex = await orderDigest(details, salt);

    const [unitsPerTwd, fxSource] = await effectiveUnitsPerTwd(this.env);
    if (fxSource === "atlas-oracle") {
      this.emit("hub", "hub", "fx.rate",
        `Atlas Oracle 即時匯率：1 元 = ${(unitsPerTwd / 1_000_000).toFixed(6)} USDC`);
    }
    const orderId = "ord_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const order: Order = {
      order_id: orderId,
      merchant_id: merchant.merchant_id,
      lines,
      total,
      digest_hex: digestHex,
      salt_hex: [...salt].map((b) => b.toString(16).padStart(2, "0")).join(""),
      amount_units: total * unitsPerTwd, // 匯率鎖定在報價當下（整數運算）
      fx_source: fxSource,
      units_per_twd: unitsPerTwd,
      status: "quoted",
      readback,
      created_at: createdAt,
      merchant_ref: "",
      tx_digest: "",
      verify_reason: "",
    };
    this.saveOrder(order);
    this.emit("hub", source, "chui.quote",
      `${merchant.name}：${readback}（信心 ${result.confidence.toFixed(2)}）`,
      { order_id: orderId, total });
    return json({
      order_id: orderId,
      merchant_id: merchant.merchant_id,
      merchant_name: merchant.name,
      intent: {
        items: result.items.map((i) => ({ item_id: i.item_id, name: i.name, qty: i.qty, options: i.options })),
        confidence: Math.round(result.confidence * 1000) / 1000,
        stt_text: result.source_text,
      },
      quote: { lines, total, currency: "TWD" },
      readback: { text: readback },
      // 這筆訂單「鎖定」的匯率：前端顯示 ≈USDC 一律用它
      fx: { units_per_twd: unitsPerTwd, source: fxSource },
    });
  }

  // ---- ②③ 確認＋接單＋結帳參數 ----

  private async confirmOrder(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { order_id?: string };
    if (!body.order_id) throw new HttpError("VALIDATION_FAILED", "缺 order_id", 422);
    const order = this.getOrder(body.order_id);
    const merchant = this.merchantById(order.merchant_id)!;
    if (!this.env.CHUI_PACKAGE_ID) {
      throw new HttpError("CHAIN_NOT_CONFIGURED",
        "CHUI_PACKAGE_ID 未設定：請在 Worker 的 Variables 填入已部署的合約 package id。", 503);
    }

    if (order.status === "quoted") {
      // builtin 商家：接單＝發取餐單號（本機版是轉發 /chui/orders 給商家行程）
      this.emit("hub", `merchant:${merchant.merchant_id}`, "chui.order",
        `轉發訂單 ${order.order_id}（${order.total} 元）`,
        { order_id: order.order_id, lines: order.lines, total: order.total, currency: "TWD" });
      order.merchant_ref = this.nextOrderRef(merchant);
      order.status = "confirmed";
      this.saveOrder(order);
      this.emit(`merchant:${merchant.merchant_id}`, "hub", "chui.order.accepted",
        `接單成功（單號 ${order.merchant_ref}）`);
    }

    const checkout = {
      network: suiNetwork(this.env),
      package_id: this.env.CHUI_PACKAGE_ID,
      module: this.env.CHUI_MODULE ?? "vault",
      function: this.env.CHUI_FN_SETTLE ?? "agent_settle",
      coin_type: this.env.CHUI_USDC_COIN_TYPE ?? USDC_COIN_TYPE_DEFAULT,
      amount_units: order.amount_units,
      merchant_address: merchant.payout_address,
      order_digest_hex: order.digest_hex,
    };
    this.emit("hub", "user", "chui.checkout",
      `結帳參數：${order.amount_units} USDC 單位 → ${merchant.name}`, checkout);
    return json({ order_id: order.order_id, merchant_ref: order.merchant_ref, checkout });
  }

  // ---- ⑤⑥⑦ 結算回報＋鏈上驗證＋出餐通知 ----

  private async verifyAndNotify(order: Order): Promise<void> {
    const merchant = this.merchantById(order.merchant_id)!;
    this.emit("hub", "sui", "chain.verify",
      `驗證交易 ${order.tx_digest.slice(0, 12)}…（查 SettlementEvent）`);
    const outcome = await verifySettlement(
      this.env, order.tx_digest, order.digest_hex, order.amount_units, merchant.payout_address);
    if (outcome.verified) {
      order.status = "settled_verified";
      order.verify_reason = outcome.reason;
      order.owner_address = String(outcome.owner ?? ""); // 鏈上事實
      this.emit("sui", "hub", "chain.verified", `鏈上驗證通過：${outcome.reason}`);
      // ⑦ 出餐通知：builtin 商家＝廣播到看板（店家看板本來就吃這條 SSE）
      this.emit("hub", `merchant:${merchant.merchant_id}`, "chui.paid",
        `通知出餐：${order.order_id}（${order.merchant_ref}）`);
    } else {
      order.status = "pending_verification";
      order.verify_reason = outcome.reason;
      this.emit("sui", "hub", "chain.unverified", `暫未驗證：${outcome.reason}`);
    }
    this.saveOrder(order);
  }

  private async reportSettlement(orderId: string, request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { tx_digest?: string };
    if (!body.tx_digest) throw new HttpError("VALIDATION_FAILED", "缺 tx_digest", 422);
    const order = this.getOrder(orderId);
    if (order.status === "settled_verified") {
      // 冪等：已驗證的訂單重複回報直接回同一結果
      return json({ order_id: orderId, status: order.status,
        explorer_url: explorerTxUrl(this.env, order.tx_digest) });
    }
    if (order.tx_digest && order.tx_digest !== body.tx_digest) {
      throw new HttpError("VALIDATION_FAILED", "這筆訂單已綁定另一個 tx_digest，拒絕覆寫", 422);
    }
    order.tx_digest = body.tx_digest;
    order.status = "paid_submitted";
    this.saveOrder(order);
    this.emit("user", "hub", "chui.settlement", `回報交易 ${body.tx_digest.slice(0, 12)}…`);
    await this.verifyAndNotify(order);
    return json({ order_id: orderId, status: order.status,
      verify_reason: order.verify_reason,
      explorer_url: explorerTxUrl(this.env, order.tx_digest) });
  }

  private async reverify(orderId: string): Promise<Response> {
    const order = this.getOrder(orderId);
    if (!order.tx_digest) throw new HttpError("VALIDATION_FAILED", "尚未回報 tx_digest", 422);
    await this.verifyAndNotify(order);
    return json({ order_id: orderId, status: order.status,
      verify_reason: order.verify_reason,
      explorer_url: explorerTxUrl(this.env, order.tx_digest) });
  }

  // ---- 歷史查詢／店家看板 ----

  private async attachLogref(orderId: string, request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { blob_id?: string };
    if (!body.blob_id) throw new HttpError("VALIDATION_FAILED", "缺 blob_id", 422);
    // Hub 只存 blob id——拿到也解不開（解密權限在鏈上 log_policy）
    const order = this.getOrder(orderId);
    order.log_blob_id = body.blob_id;
    this.saveOrder(order);
    return json({ ok: true });
  }

  private orderRow(order: Order): Record<string, unknown> {
    const merchant = this.merchantById(order.merchant_id);
    const row: Record<string, unknown> = {
      order_id: order.order_id,
      merchant_id: order.merchant_id,
      merchant_name: merchant?.name ?? order.merchant_id,
      merchant_address: merchant?.payout_address ?? "",
      merchant_ref: order.merchant_ref ?? "",
      total: order.total ?? 0,
      amount_units: order.amount_units ?? 0,
      status: order.status ?? "",
      tx_digest: order.tx_digest ?? "",
      log_blob_id: order.log_blob_id ?? "",
      owner_address: order.owner_address ?? "",
      created_at: order.created_at ?? 0,
      // 品項明細（看板逐行顯示：名稱＋規格＋數量＋小計）
      lines: (order.lines ?? []).map((ln) => ({
        name: ln.name ?? "", option_names: ln.option_names ?? [],
        qty: ln.qty ?? 1, line_total: ln.line_total ?? 0,
      })),
    };
    if (order.tx_digest) row.explorer_url = explorerTxUrl(this.env, order.tx_digest);
    return row;
  }

  private userOrders(owner: string): Response {
    // owner＝消費者錢包地址（由鏈上 SettlementEvent 回填，非前端自報）
    return json({ orders: this.listOrdersBy("owner_address", owner).map((o) => this.orderRow(o)) });
  }

  private merchantOrders(merchantId: string): Response {
    if (!this.merchantById(merchantId)) {
      throw new HttpError("NOT_FOUND", `registry 沒有商家 ${merchantId}`, 404);
    }
    return json({ orders: this.listOrdersBy("merchant_id", merchantId).map((o) => this.orderRow(o)) });
  }

  private getOrderResponse(orderId: string): Response {
    const order = this.getOrder(orderId);
    const body: Record<string, unknown> = { ...order };
    if (order.tx_digest) body.explorer_url = explorerTxUrl(this.env, order.tx_digest);
    return json(body);
  }
}
