import { useState } from "react";
import { MerchantPanel } from "./MerchantPanel.js";
import { ConsumerPanel } from "./ConsumerPanel.js";

export function App() {
  const [tab, setTab] = useState<"merchant" | "consumer">("consumer");
  return (
    <div className="app">
      <header>
        <h1>Chui 後台</h1>
        <nav>
          <button className={tab === "consumer" ? "active" : ""} onClick={() => setTab("consumer")}>
            消費者
          </button>
          <button className={tab === "merchant" ? "active" : ""} onClick={() => setTab("merchant")}>
            店家
          </button>
        </nav>
      </header>
      {tab === "merchant" ? <MerchantPanel /> : <ConsumerPanel />}
      <footer>
        <small>目前網路：Sui Testnet（測試幣，非真實資金）</small>
      </footer>
    </div>
  );
}
