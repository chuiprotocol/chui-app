/** 消費者後台：綁錢包、設定授權額度、查看收據、撤銷。
 *
 * 撤銷按鈕刻意做得非常顯眼，且撤銷在「單一鏈上交易」內生效：
 * 簽一次、送一次，合約端立即拒絕後續結算。
 */

import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { idbGet, idbSet } from "./idb.js";
import {
  Signer,
  clearZkSession,
  completeZkLogin,
  ed25519Signer,
  loadOrCreateTestWallet,
  loadZkSession,
  loginWithSigner,
  startZkLogin,
  txBytesFromB64,
  zkLoginSigner,
} from "./wallet.js";

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const PROVER_URL = (import.meta.env.VITE_ZKLOGIN_PROVER_URL as string | undefined)
  ?? "https://prover-dev.mystenlabs.com/v1";
const FAUCET_URL = "https://faucet.sui.io";

interface MandateRow {
  mandate_id: string;
  onchain_id: string;
  per_tx_limit: number;
  total_limit: number;
  status: string;
  explorer_url: string | null;
  created_at: number;
}

interface ReceiptRow {
  order_id: string;
  merchant_name: string;
  status: string;
  total: number;
  digest: string;
  salt: string;
  details_ciphertext: string;
  details_nonce: string;
  tx_digest: string;
  explorer_url: string | null;
  created_at: number;
}

export function ConsumerPanel() {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mandates, setMandates] = useState<MandateRow[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [perTx, setPerTx] = useState("100");
  const [totalLimit, setTotalLimit] = useState("500");
  const [deposit, setDeposit] = useState("500");
  const [busy, setBusy] = useState("");

  async function run(label: string, fn: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(label);
    try { await fn(); } catch (e) {
      const msg = e instanceof ApiError && e.detail.move_abort
        ? `${(e as ApiError).message}（${String((e as ApiError).detail.move_abort)}）`
        : (e as Error).message;
      setError(msg);
    } finally { setBusy(""); }
  }

  // OAuth 回跳處理 + 既有 session 載入
  useEffect(() => {
    void (async () => {
      try {
        const zk = (await completeZkLogin(PROVER_URL)) ?? (await loadZkSession());
        if (zk) { setSigner(zkLoginSigner(zk)); return; }
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  async function refresh() {
    const m = await api<{ mandates: MandateRow[] }>("GET", "/v1/mandates/me");
    setMandates(m.mandates);
    const r = await api<{ receipts: ReceiptRow[] }>("GET", "/v1/receipts");
    setReceipts(r.receipts);
  }

  async function connectAndLogin(s: Signer) {
    await loginWithSigner(s);
    setSigner(s);
    setLoggedIn(true);
    await refresh();
  }

  if (!signer || !loggedIn) {
    return (
      <div className="panel">
        {error && <p className="error">{error}</p>}
        <section className="card">
          <h3>綁定錢包</h3>
          {signer ? (
            <>
              <p>錢包地址：<code>{signer.address}</code></p>
              <button onClick={() => run("登入", () => connectAndLogin(signer))} disabled={!!busy}>
                {busy || "用這個錢包登入"}
              </button>
            </>
          ) : (
            <>
              <button
                disabled={!GOOGLE_CLIENT_ID}
                onClick={() => run("zkLogin", async () => {
                  const epochInfo = await api<{ epoch: number }>("GET", "/v1/chain/epoch");
                  await startZkLogin(GOOGLE_CLIENT_ID, epochInfo.epoch);
                })}
              >
                使用 Google 登入（zkLogin，免助記詞）
              </button>
              {!GOOGLE_CLIENT_ID && <p className="hint">（未設定 VITE_GOOGLE_CLIENT_ID，zkLogin 停用）</p>}
              <button onClick={() => run("建立錢包", async () => {
                const kp = await loadOrCreateTestWallet();
                await connectAndLogin(ed25519Signer(kp));
              })}>
                使用瀏覽器測試錢包（ed25519）
              </button>
              <p className="hint">
                測試錢包的私鑰只存在你瀏覽器的 IndexedDB。建立 Mandate 前，請先到
                <a href={FAUCET_URL} target="_blank" rel="noreferrer"> faucet.sui.io </a>
                幫地址領 Testnet SUI（deposit 需要）。
              </p>
            </>
          )}
        </section>
      </div>
    );
  }

  const activeMandates = mandates.filter((m) => m.status === "active");

  return (
    <div className="panel">
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <section className="card">
        <h3>錢包</h3>
        <p><code>{signer.address}</code></p>
        <button className="secondary" onClick={() => run("登出", async () => {
          await api("POST", "/v1/auth/logout");
          await clearZkSession();
          setLoggedIn(false); setSigner(null);
        })}>登出</button>
      </section>

      <section className="card">
        <h3>建立授權（Mandate）</h3>
        <label>單筆上限（元）</label>
        <input type="number" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
        <label>總額上限（元，0 = 不設）</label>
        <input type="number" value={totalLimit} onChange={(e) => setTotalLimit(e.target.value)} />
        <label>存入額度（元；結算從這裡扣，需先領 Testnet 測試幣）</label>
        <input type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        <button disabled={!!busy} onClick={() => run("建立授權中…", async () => {
          const built = await api<{ mandate_id: string; tx_bytes_b64: string }>(
            "POST", "/v1/mandates",
            { per_tx_limit: Number(perTx), total_limit: Number(totalLimit), deposit: Number(deposit) },
          );
          const signature = await signer.signTransaction(txBytesFromB64(built.tx_bytes_b64));
          const done = await api<{ onchain_id: string; explorer_url: string }>(
            "POST", "/v1/mandates/submit",
            { mandate_id: built.mandate_id, tx_bytes_b64: built.tx_bytes_b64, signature },
          );
          setNotice(`授權已上鏈：${done.onchain_id}`);
          await refresh();
        })}>{busy || "簽名並上鏈（gas 由 Chui 贊助）"}</button>
      </section>

      <section className="card">
        <h3>我的授權</h3>
        {mandates.length === 0 && <p className="hint">還沒有授權</p>}
        {mandates.map((m) => (
          <div key={m.mandate_id} className={`mandate ${m.status}`}>
            <div>
              <b>單筆上限 {m.per_tx_limit} 元</b>
              {m.total_limit > 0 && <span>｜總額 {m.total_limit} 元</span>}
              <span className={`badge ${m.status}`}>{m.status === "active" ? "生效中" : m.status === "revoked" ? "已撤銷" : "待上鏈"}</span>
              {m.explorer_url && <a href={m.explorer_url} target="_blank" rel="noreferrer">鏈上物件</a>}
            </div>
            {m.status === "active" && (
              <button className="revoke" disabled={!!busy} onClick={() => run("撤銷中…", async () => {
                const built = await api<{ tx_bytes_b64: string }>(
                  "POST", "/v1/mandates/revoke", { mandate_id: m.mandate_id },
                );
                const signature = await signer.signTransaction(txBytesFromB64(built.tx_bytes_b64));
                const done = await api<{ tx_digest: string; explorer_url: string }>(
                  "POST", "/v1/mandates/revoke/submit",
                  { mandate_id: m.mandate_id, tx_bytes_b64: built.tx_bytes_b64, signature },
                );
                setNotice(`已撤銷（單一交易生效）：${done.tx_digest}`);
                await refresh();
              })}>
                {busy || "立即撤銷"}
              </button>
            )}
          </div>
        ))}
        {activeMandates.length === 0 && mandates.length > 0 &&
          <p className="hint">沒有生效中的授權——新的結算都會失敗。</p>}
      </section>

      <section className="card">
        <h3>收據</h3>
        {receipts.length === 0 && <p className="hint">還沒有收據</p>}
        {receipts.map((r) => (
          <div key={r.order_id} className="receipt">
            <b>{r.merchant_name}</b>｜{r.total} 元｜{r.status === "settled" ? "已結算" : r.status}
            {r.explorer_url && <>｜<a href={r.explorer_url} target="_blank" rel="noreferrer">鏈上交易</a></>}
            <div className="hint">
              digest：<code>{r.digest.slice(0, 16)}…</code>（鏈上只看得到這個，
              明細需用你持有的金鑰解密——見 scripts/verify.ts）
            </div>
          </div>
        ))}
        <button onClick={() => run("重新整理", refresh)}>重新整理</button>
      </section>
    </div>
  );
}
