/** 店家後台：註冊、API key、菜單編輯、webhook、結算紀錄。 */

import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

interface MerchantInfo {
  merchant_id: string;
  name: string;
  payout_address: string;
  menu_version: string;
  menu: Record<string, unknown> | null;
}

interface SettlementRow {
  id: string;
  order_id: string;
  amount: number;
  tx_digest: string;
  explorer_url: string;
  created_at: number;
}

export function MerchantPanel() {
  const [me, setMe] = useState<MerchantInfo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 註冊
  const [regName, setRegName] = useState("");
  const [issuedKey, setIssuedKey] = useState("");

  // 登入
  const [loginKey, setLoginKey] = useState("");

  // 編輯區
  const [menuText, setMenuText] = useState("");
  const [payout, setPayout] = useState("");
  const [settlements, setSettlements] = useState<SettlementRow[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhooks, setWebhooks] = useState<{ webhook_id: string; url: string }[]>([]);
  const [webhookSecret, setWebhookSecret] = useState("");

  async function refresh() {
    try {
      const info = await api<MerchantInfo>("GET", "/v1/merchants/me");
      setMe(info);
      setPayout(info.payout_address);
      setMenuText(info.menu ? JSON.stringify(info.menu, null, 2) : "");
      const s = await api<{ settlements: SettlementRow[] }>("GET", "/v1/merchants/me/settlements");
      setSettlements(s.settlements);
      const w = await api<{ webhooks: { webhook_id: string; url: string }[] }>("GET", "/v1/webhooks").catch(() => ({ webhooks: [] }));
      setWebhooks(w.webhooks);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function run(fn: () => Promise<void>) {
    setError(""); setNotice("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
  }

  if (!me) {
    return (
      <div className="panel">
        {error && <p className="error">{error}</p>}
        <section className="card">
          <h3>註冊新店家</h3>
          <input placeholder="店名（例：快樂豬早餐店）" value={regName}
                 onChange={(e) => setRegName(e.target.value)} />
          <button onClick={() => run(async () => {
            const r = await api<{ merchant_id: string; api_key: string }>("POST", "/v1/merchants", { name: regName });
            setIssuedKey(r.api_key);
            setNotice("註冊成功！請立刻保存 API key——它只會出現這一次。");
          })}>註冊</button>
          {issuedKey && (
            <div className="secret-box">
              <p>你的 API key（只顯示這一次）：</p>
              <code>{issuedKey}</code>
            </div>
          )}
          {notice && <p className="notice">{notice}</p>}
        </section>
        <section className="card">
          <h3>已有 API key？登入後台</h3>
          <input placeholder="chui_sk_..." value={loginKey} type="password"
                 onChange={(e) => setLoginKey(e.target.value)} />
          <button onClick={() => run(async () => {
            await api("POST", "/v1/merchants/console-login", { api_key: loginKey });
            setLoginKey("");
            await refresh();
          })}>登入</button>
        </section>
      </div>
    );
  }

  return (
    <div className="panel">
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <section className="card">
        <h3>{me.name} <small>{me.merchant_id}</small></h3>
        <label>收款地址（Sui Testnet）</label>
        <input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x..." />
        <button onClick={() => run(async () => {
          await api("PUT", "/v1/merchants/me", { payout_address: payout });
          setNotice("收款地址已更新");
        })}>儲存</button>
      </section>

      <section className="card">
        <h3>菜單（JSON）</h3>
        <p className="hint">品項、價格（整數元）、選項與同義詞。同義詞越口語，語音救回率越高。</p>
        <textarea rows={16} value={menuText} onChange={(e) => setMenuText(e.target.value)}
                  placeholder='{"menu_version": "...", "items": [...]}' />
        <button onClick={() => run(async () => {
          const parsed = JSON.parse(menuText);
          const r = await api<{ menu_version: string; items: number }>("PUT", "/v1/merchants/me/menu", parsed);
          setNotice(`菜單已更新（版本 ${r.menu_version}，${r.items} 個品項）`);
        })}>上傳菜單</button>
      </section>

      <section className="card">
        <h3>Webhook</h3>
        <ul>{webhooks.map((w) => <li key={w.webhook_id}><code>{w.url}</code></li>)}</ul>
        <input placeholder="https://你的伺服器/chui-webhook" value={webhookUrl}
               onChange={(e) => setWebhookUrl(e.target.value)} />
        <button onClick={() => run(async () => {
          setNotice("");
          const r = await api<{ secret: string }>("POST", "/v1/webhooks", { url: webhookUrl });
          setWebhookSecret(r.secret);
          await refresh();
        })}>新增</button>
        {webhookSecret && (
          <div className="secret-box">
            <p>Webhook secret（只顯示這一次，用來驗簽）：</p>
            <code>{webhookSecret}</code>
          </div>
        )}
        <p className="hint">注意：新增 webhook 需要用 API key（Bearer）呼叫；console 登入亦可透過此頁。</p>
      </section>

      <section className="card">
        <h3>結算紀錄</h3>
        {settlements.length === 0 ? <p className="hint">還沒有結算</p> : (
          <table>
            <thead><tr><th>訂單</th><th>金額</th><th>交易</th><th>時間</th></tr></thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.id}>
                  <td>{s.order_id}</td>
                  <td>{s.amount} 元</td>
                  <td><a href={s.explorer_url} target="_blank" rel="noreferrer">{s.tx_digest.slice(0, 10)}…</a></td>
                  <td>{new Date(s.created_at * 1000).toLocaleString("zh-TW")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button onClick={() => run(refresh)}>重新整理</button>
      </section>
    </div>
  );
}
