# SETUP.md —— 你必須手動做的事

依順序執行。標註的時間是實際操作時間（不含等待審核）。
全部做完後，照 `README.md` 的「快速上手」啟動四個行程。

---

## 1. 產生本地密鑰（約 2 分鐘）

```bash
cp .env.example .env
openssl rand -hex 32   # 填入 CHUI_SESSION_SECRET
openssl rand -hex 32   # 填入 CHAIN_SERVICE_TOKEN
openssl rand -hex 32   # 填入 ZKLOGIN_SALT_MASTER_SECRET（⚠️ 務必備份：
                       #    遺失＝所有 zkLogin 使用者地址無法重建）
```

## 2. 建立贊助者錢包＋領 Testnet 測試幣（約 5 分鐘）

這把 key 負責幫所有消費者付 gas，並執行結算。

1. 安裝 Sui CLI（已裝可跳過）：https://docs.sui.io/guides/developer/getting-started/sui-install
2. ```bash
   sui client new-address ed25519        # 記下地址
   sui keytool export --key-identity <地址>   # 取得 suiprivkey... 開頭的私鑰
   ```
   把私鑰填入 `.env` 的 `SPONSOR_SECRET_KEY`。
3. 到 **https://faucet.sui.io** 貼上地址領 Testnet SUI（建議按兩三次，
   gas 贊助會持續消耗）。

## 3. 填入合約部署參數（約 1 分鐘；⚠️ 目前被擋）

從 `chui-contracts` repo 的 `deployments/testnet.json` 取得：

- `CHUI_PACKAGE_ID`
- `CHUI_REGISTRY_ID`（若合約有 registry）

**現況**：chui-contracts repo 目前是空的（沒有任何 commit）。在它補上
之前，鏈上結算會明確回報 `CHAIN_NOT_CONFIGURED`（其餘功能不受影響）。
repo 補上後，除了兩個 ID，請把 `SPEC.md` 的 module／function 名稱與
abort code 常數對照 `.env` 的 `CHUI_MODULE`／`CHUI_FN_*`／`CHUI_ABORT_CODES`
核對一次。

## 4. ElevenLabs 金鑰（約 5 分鐘）

1. https://elevenlabs.io → 註冊／登入 → 右上角頭像 → **API Keys** →
   建立 key，填入 `ELEVENLABS_API_KEY`。
2. 左側 **Voices / Voice Library** → 搜尋 Chinese → 試聽挑一個台灣腔
   voice → 複製 Voice ID，填入 `ELEVENLABS_VOICE_ID`。
3. 不填也能跑：會直接用 edge-tts 備援（免金鑰）。

## 5. STT 金鑰（約 3 分鐘）

- https://platform.openai.com/api-keys 建一把 key，填入 `STT_API_KEY`。
- 想用其他 OpenAI 相容供應商（如 Groq）：改 `STT_API_BASE` 與 `STT_API_MODEL`。
- 完全不填：語音輸入退回本地 faster-whisper（需 `pip install faster-whisper`，
  首跑會下載模型數百 MB）；兩者皆無時語音會明確報錯、文字點餐照常。

## 6. zkLogin provider——Google OAuth（約 10 分鐘）

（只想先用「瀏覽器測試錢包」跑通全流程的話，這步可以先跳過。）

1. https://console.cloud.google.com → 建專案 → **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**。
2. Application type 選 **Web application**；
   Authorized redirect URIs 加 `http://localhost:5173`（console 網址）。
3. 把 Client ID 填入：
   - `.env` 的 `ZKLOGIN_ALLOWED_AUDIENCES`
   - `apps/console/.env` 的 `VITE_GOOGLE_CLIENT_ID`
4. `VITE_ZKLOGIN_PROVER_URL` 維持 `https://prover-dev.mystenlabs.com/v1`
   （Mysten 提供的 testnet 開發 prover，免申請）。

## 7. LINE 後台——Messaging API 與 LIFF（約 15 分鐘）

1. https://developers.line.biz/console → 建 Provider →
   **Create a Messaging API channel**（名稱例：快樂豬早餐店）。
2. Channel 頁面取得：
   - **Channel secret** → `LINE_CHANNEL_SECRET`
   - **Messaging API → Channel access token**（Issue）→ `LINE_CHANNEL_ACCESS_TOKEN`
3. 讓 bot 收得到訊息：Messaging API 分頁把 **Webhook** 打開、
   **Auto-reply messages** 關掉。
4. 本機開發需要公開網址：
   ```bash
   cloudflared tunnel --url http://localhost:8790   # 或 ngrok http 8790
   ```
   把得到的 https 網址填入 `.env` 的 `BASE_URL`，
   並到 LINE console 設 Webhook URL 為 `{BASE_URL}/line-webhook` → Verify。
5. LIFF（語音點餐頁）：同一 channel（或另建 LINE Login channel）→
   **LIFF → Add**：Endpoint URL 填 `{BASE_URL}/liff/`、Size 選 Full →
   把 LIFF ID 填入 `LIFF_ID`。

## 8. 註冊快樂豬、拿 Chui API key（約 3 分鐘）

API 與 console 跑起來後：

1. 開 http://localhost:5173 → 「店家」→ 註冊「快樂豬早餐店」→
   **立刻保存 API key**（只顯示一次）→ 填入 `.env` 的 `CHUI_API_KEY`。
2. 同頁上傳菜單：貼上 `examples/happy-pig/menu.json` 的內容。
3. 填店家收款地址（可以再開一個 Sui 地址，或直接用贊助者地址收款測試）。

## 9. 預合成 TTS 快取（約 3 分鐘，跑一次）

```bash
python scripts/prebuild-tts.py --menu examples/happy-pig/menu.json
```

會場斷網時的覆誦完全靠這批快取；菜單改版後重跑一次。

## 10. 消費者側：綁錢包、領測試幣、建授權（約 5 分鐘）

1. 手機或電腦開 console → 「消費者」→ 「使用瀏覽器測試錢包」
   （或 Google zkLogin）→ 登入。
2. 複製地址 → https://faucet.sui.io 領 Testnet SUI（Mandate 的 deposit 要用）。
3. 建立授權：單筆上限 100、總額 500、存入 500 → 簽名上鏈。
4. 打開快樂豬 LINE bot → 傳任意訊息 → 點連結開 LIFF → 貼上地址完成綁定。

完成。接著照 `TESTING.md` 從測試 A 開始跑。
