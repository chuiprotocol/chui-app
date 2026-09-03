# DECISIONS.md —— 自主決策紀錄

依任務規則：需要決策時自己選一個合理方案並記錄於此。
每筆包含「情境 → 決定 → 理由 → 代價」。

---

## D1. 合約 repo 是空的 → 以「可設定的假定介面」實作鏈上層

- **情境**：任務要求先讀 chui-contracts 的 README/SPEC 並從
  `deployments/testnet.json` 取得 package ID。實際 clone 後發現該 repo
  **沒有任何 commit**（`git ls-remote` 為空）。
- **決定**：chain-service 以一組合理的 Move 介面假定實作
  （`mandate::create(coin, per_tx_limit, total_limit)`、
  `settle(mandate, amount, digest, recipient)`、`revoke(mandate)`），
  module／function 名稱、registry 物件、abort code 對映**全部走環境變數**；
  `CHUI_PACKAGE_ID` 未設定時所有鏈上操作回 `CHAIN_NOT_CONFIGURED`。
- **理由**：硬性規定「絕不 mock 交易、做不到就明確報錯」。這樣合約
  repo 補上後只改 `.env`，不改程式碼。
- **代價**：假定介面可能與實際合約不合（引數順序、型別、事件形狀），
  屆時需要小幅修改 `chain-service/src/sui.js` 的引數組裝。

## D2. FastAPI 之外加一個 Node chain-service sidecar

- **情境**：架構指定 FastAPI，但 Sui 官方成熟 SDK 是 TypeScript
  （@mysten/sui v2；sponsored tx、zkLogin 驗簽都以它為第一公民）。
- **決定**：鏈上操作放進只綁 localhost 的 Node sidecar，FastAPI 以內部
  token 呼叫。
- **理由**：用 Python 重造 sponsored tx／zkLogin 簽章驗證的輪子風險遠
  高於多跑一個行程；sidecar 同時是結算去重的天然落點。
- **代價**：部署多一個行程；內部呼叫多一層網路跳躍（localhost，微秒級）。

## D3. 金額單位＝整數新台幣「元」；上鏈以整數比例換算

- **決定**：全系統金額為整數元（台灣菜單無角分）。鏈上以
  `AMOUNT_SCALE_MIST`（預設 1 元 = 0.01 SUI）整數換算成 MIST。
- **理由**：硬性規定禁止浮點；示意匯率讓 faucet 領一次（1 SUI）就能
  演示約百元的訂單流。
- **代價**：匯率是展示用假設，不代表真實定價；正式版應改用穩定幣。

## D4. 隱私模型：伺服器「解析時可見、落地不可見、鏈上只有 digest」

- **決定**：parse 時伺服器產生一次性 AES-256-GCM 金鑰加密明細、
  金鑰回傳消費者後即丟棄；DB 只有密文＋salt＋digest＋總額；
  鏈上只有 salted digest。
- **理由**：STT 與重排序必須在伺服器跑（本來就看得到語音內容），
  「對營運方零知識」在此架構下是謊言，直接在 README 信任假設寫明，
  把加密的保護範圍誠實界定為落地儲存與鏈上觀察者。
- **代價**：消費者弄丟 order_key 就無法解密舊明細（digest 仍可驗證）。
  總額以明文存 DB——店家記帳需要。

## D5. mandate 需要 `deposit`（資金先存入 Mandate 物件）

- **情境**：合約規格不可得，但「結算把錢從消費者轉到店家」需要資金
  來源；代扣消費者錢包餘額需要消費者每筆簽名，違背「授權後 agent
  代結算」的核心主張。
- **決定**：Mandate 創建時消費者存入一筆測試幣（`deposit`），結算從
  Mandate 內扣；撤銷時剩餘退還（合約行為）。API 強制 `deposit >= per_tx_limit`。
- **理由**：這是預授權支付（escrow-style mandate）的標準做法，也與
  「資金不在營運方帳戶」的非託管主張一致。
- **代價**：消費者要先領測試幣、先儲值；體驗多一步。

## D6. zkLogin：低階 primitives ＋ 自架 HMAC salt 服務（不用 Enoki）

- **決定**：前端用 `@mysten/sui/zklogin` 的 generateNonce／jwtToAddress／
  getZkLoginSignature 直接實作 Google OAuth implicit flow；salt 由 API 以
  `HMAC(master_secret, iss|aud|sub)` 決定性導出；prover 用 Mysten 的
  testnet 開發 prover。另提供瀏覽器 ed25519 測試錢包作為免 OAuth 設定
  的可實測路徑。
- **理由**：Enoki 是託管 SaaS，需要額外註冊與金鑰，且把信任外移給
  第三方；低階路徑全部函式已在安裝的 SDK 驗證存在。ed25519 測試錢包
  讓 E2E 測試不被 OAuth 設定卡死（它是真錢包真簽章，不是 mock）。
- **代價**：自架 salt 服務＝營運方保管 salt（已列信任假設）；
  zkLogin 全流程需要 Google Client ID 才能實測。

## D7. 消費者錢包只住在 console（LIFF 只綁定地址）

- **情境**：LIFF 與 console 是不同 origin，IndexedDB 不互通；錢包若在
  兩邊各生一把，地址就不一致。
- **決定**：私鑰與簽章操作只在 console；LIFF 綁定流程是「把 console
  顯示的地址貼進 LIFF」。點餐與確認不需要消費者簽章（Mandate 已授權），
  所以 LIFF 完全不需要碰金鑰。
- **代價**：綁定流程多一次複製貼上；換來金鑰單一來源、不跨 origin 複製。

## D8. STT 供應商抽象：雲端 Whisper API 主路徑＋本地 faster-whisper 備援

- **決定**：`STT_PROVIDER=auto`：先走 OpenAI 相容 API（華語），失敗退回
  本地 faster-whisper（選裝）；兩者皆無 → `STT_UNAVAILABLE` 明確報錯並
  引導文字輸入。faster-whisper 不暴露 n-best，因此以兩種 temperature 各取
  一候選；重排序本身不依賴 n-best（單候選也能靠語音距離救回）。
- **理由**：Whisper API 對華語準確率高、零維運；本地模型滿足「會場
  斷網」情境；文字輸入是永遠可用的保底。
- **代價**：本地模型首跑要下載數百 MB；n-best 資訊有限。

## D9. 覆誦片段改細粒度，離線拼接線性覆蓋

- **情境**：覆誦句若以「整句」為快取單位，選項組合會爆炸，離線快取
  永遠有洞。
- **決定**：線上 TTS 用整句；離線降級用細粒度片段（單一選項詞、品項名、
  「N 份」、「總共 N 元，確認嗎？」）拼接 MP3。prebuild 只需線性枚舉
  菜單詞彙＋金額 1..300。
- **代價**：拼接音檔的銜接略有頓挫感（可接受，且只在雙 TTS 都失敗時出現）。

## D10. 冪等性層次（application-level 為主、鏈上去重為輔）

- **決定**：五層防線（收據捷徑、409、原子狀態轉移、UNIQUE 約束、
  sidecar digest 去重）＋nonce/timestamp 防重放。合約端若原生支援以
  digest 冪等（理想），sidecar 去重自動變成冗餘保險。
- **代價**：sidecar 去重紀錄是本地檔案，多實例部署需共享儲存。

## D11. Explorer 用 Suiscan；連結由 `SUI_NETWORK` 樣板生成

- **理由**：官方 explorer 已退役；Suiscan 對開發者友善。樣板寫在
  `config.py`／SDK 回傳值，切網路只改 `SUI_NETWORK`。

## D12. 評估資料集使用「模擬 STT 誤辨文字」

- **決定**：55 筆樣本的 STT 文字依常見華語誤辨模式人工標註（茶→查、
  蛋→但、雞→機、粿→貴…），非真實錄音輸出。README 明確聲明。
- **理由**：沙箱無法錄音也無法呼叫雲端 STT；誤辨「型態」（同音異字、
  聲母混淆）是有據可依的，能量化重排序的救回能力。
- **代價**：數字不能宣稱為端到端準確率；真機驗證列入 TESTING.md C。

## D14.（demo 改版）支付模型改為「每筆錢包簽名」，合約只做 settle＋事件

- **情境**：新 demo 規格明定「用手機的 Slush 打開商家官網點餐並以
  USDC on Sui Testnet 結帳」——付款人親手簽每一筆。
- **決定**：合約 `chui::pay::settle<T>(coin, merchant, digest)` 一個 entry
  function：coin 直接轉給店家（非託管）、發 SettlementEvent。不做 Mandate
  預授權（demo 規則：只做列出的東西）。金額以 coin 面額為準
  （`coinWithBalance` 切出精確金額），合約不信任呼叫端另傳的數字。
- **代價**：先前 apps/api 的 mandate/sponsored 路徑與這條路徑並存於
  repo（未刪除），demo 不使用。

## D15. Hub 的鏈上驗證走 JSON-RPC，且「絕不憑空標記已付款」

- **決定**：前端回報 tx_digest 後，Hub 向 fullnode 查 SettlementEvent，
  digest／amount／merchant 三者皆符才標 `settled_verified`；查不到或
  連不上一律 `pending_verification`（可重試），並把驗證結果推上面板。
- **理由**：demo 要「回傳真實交易編號」；一個假成功就毀掉整個主張。

## D16. 跨商家路由＝對每家菜單各跑一次封閉詞彙重排序、取最高信心

- **決定**：語音入口 App 的 parse 不帶 merchant_id；Hub 對 registry 內
  每家商家的封閉詞彙各解析一次，信心最高者得單，排名推上面板。
- **理由**：重排序引擎本來就是 per-menu 的封閉詞彙比對，跨商家路由是
  它的自然推廣，也是「一段語音對 A、B 兩家下單」的最簡實作。
- **代價**：商家數量大時要改成倒排索引預篩；demo 兩家無此問題。

## D17. 商家B＝公版 template 的第一個 config 實例

- **情境**：需求 1 說「獨立寫兩家應用」，需求 2 與架構節說「商家B用
  公版 template 開店」。兩者對 B 有張力。
- **決定**：依架構節（較具體）：B 是公版 template＋`config/goodtea.json`
  的實例，有自己的行程、資料與網址；A 才是完全獨立的 legacy 系統。
  這同時完成「公版商家應用」這個交付項。
- **代價**：B 沒有「手刻」的獨立程式碼——但這正是公版的賣點。

## D18. USDC 換匯率固定於 Hub 設定（1 元 = 0.032 USDC）

- **決定**：`USDC_UNITS_PER_TWD=32000`（6 位小數），整數運算。
  Circle testnet faucet 每 2 小時 20 USDC ≈ 625 元額度，夠一場 demo。
- **代價**：不是即時匯率；正式版應由報價層決定幣別與匯率。

## D19. 零按鍵結帳＝x402「同款模式」的 session key，不是 x402 協議本體

- **情境**：需求改為「除第一次開始說話外零按鍵，說完立刻下單結帳，
  不經使用者逐筆授權」，並點名 x402。
- **事實**：Coinbase x402 協議與其 facilitator 生態不支援 Sui。
- **決定**：實作 x402 的「同款 UX 模式」——使用者用 Slush 做**一次性
  授權**（把小額 USDC＋0.05 SUI gas 撥給頁面 IndexedDB 裡的 Chui Agent
  session key），之後每筆 `chui::pay::settle` 由 agent 自動簽名直送
  fullnode，全程零確認。花完為止，損失上限＝撥入金額；再授權即加值。
- **語音端**：改「點一下說話」＋VAD 靜音自動送出；澄清問題唸完自動
  重新聆聽（上限連續 2 次，避免麥克風無限開啟）。「信心不足必須問」
  仍是底線——自動付款讓猜錯的代價更高，澄清機制反而更重要。
- **代價／風險**：session key 是瀏覽器熱錢包（僅測試幣、小額）；
  清除瀏覽器資料前需自行把餘額轉回；覆誦不再等使用者，聽錯且高信心
  的單會直接扣款（閾值 0.62 可調高）。

## D13. 單機版 rate limit 與 in-memory 菜單引擎快取

- **決定**：滑動視窗 rate limit 與 RerankEngine 快取都放行程記憶體。
- **理由**：原型階段單實例部署；外部化（Redis）是機械性替換。
- **代價**：多實例時限流不精確；已在 README 限制節註明。

## D20.（vault 版）合約全部自寫：資金留在用戶 Vault，agent 只持 Cap

- **情境**：用戶明確要求不用 Sup Wallet 的合約、合約必須自寫；並要求
  純語音零按鍵（開頁自動聆聽、口頭覆誦即扣款）。
- **決定**：新增自寫 `chui::vault`（Vault shared object＋AgentCap＋
  `agent_settle` 規則檢查＋`revoke_caps` 一鍵撤銷＋`withdraw` 領回），
  9 項 Move 單元測試涵蓋轉帳、超限、撤銷、非擁有者、餘額耗盡、重授權。
  前端 agent 從「熱錢包」降級為「只持 Cap＋gas」；額度顯示直接讀鏈上
  Vault 狀態。取餐單號改「前綴-月日-流水號」且落地持久化（FC-0903-0001），
  重啟不歸零、跨日由日期前綴保證永不重複。
- **借鏡與界線**：概念上與 programmable-delegation（如 Sup Wallet 的
  vault/cap 模式、ERC-7710 caveats）同族，但程式碼 100% 自寫、介面極簡
  （單一 per-tx 上限＋總額＝餘額），沒有引用任何第三方合約程式碼。
- **代價**：回訪「開頁自動聆聽」依賴瀏覽器已授予麥克風權限；權限第一次
  授予仍需一次點擊（瀏覽器安全規定，無法繞過）。
