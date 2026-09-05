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

## D21.（UX 實測回饋）加值累計、口頭確認再下單、結束對話鍵、內部測試降價

- **情境**：真機實測回報四個痛點：再次授權不累計（其實是每次都建
  「新 Vault」把舊的錢丟下）、點餐過程無法中止聆聽、agent 不與用戶
  對話確認就直接扣款、測試幣太貴。
- **決定**：
  1. 授權按鈕改雙路：已有同套合約的有效 Vault → 走 `vault::deposit`
     加值（額度累計、gas 低時順帶補 0.05 SUI）；否則才建新 Vault。
  2. 單筆上限改為寬鬆常數 50 USDC（合約沒有調整上限的入口；實際可花
     上限永遠＝Vault 餘額，安全性由餘額與可撤銷 cap 保證）。
  3. 語音流程改「覆誦＋口頭問確認」：說「確認」才 `agent_settle` 扣款、
     「取消」放棄、講新品項直接換單；判讀靠 Hub 422 澄清回應附帶的
     `stt_text`（封閉詞彙外的話也拿得到原文）。這把 D20 的「覆誦即扣款」
     改為「覆誦→口頭同意→扣款」——仍是零按鍵，但把不可逆的扣款
     動作放在明確口頭同意之後。
  4. 新增「⏹ 結束對話」鍵（錄到一半按下直接丟棄、不下單）；連續兩次
     聽不清楚自動暫停，不再跳針。
  5. 內部測試降價：兩家菜單全部砍半（整數元），台幣旁標注 ≈USDC
     （匯率由 Hub /healthz 提供，前端零硬編碼）；go-live 每次執行
     強制把 .env 的 USDC_UNITS_PER_TWD 矯正為 1538（舊 .env 殘留
     32000 是「40 元被算成 1.28 USDC」的根因）。
- **代價**：多一輪「確認」對話（約 2 秒）；單筆上限不再等於首儲金額
  （內部測試接受，正式版應在合約加 owner-only 的上限調整入口）。

## D22.（真機實測第二輪）量詞誤判、同義詞拆分、預設值靜默、無聲錄音防跳針

- **情境**：「點一杯四季春青茶」被聽成 1＋4 共 5 杯；agent 強行宣告
  用戶沒說的「中杯」；沒人講話時對話會莫名暫停。
- **決定**：
  1. 中文數字必須跟著量詞（一「杯」）才算數量——「四」季春青茶的
     「四」不再被抽走當 4 份（阿拉伯數字維持可省量詞）。
  2. 區間 DP 每段扣固定成本 0.02：完整比對與「同義詞拆兩段」
     （四季春＋青茶）打平時，偏好單一長比對，同品項不再拆成兩筆。
  3. ParsedItem 新增 explicit_options：覆誦（readback／澄清描述）只唸
     使用者明講的選項；必填預設值靜默套用、給商家的訂單仍帶完整選項。
  4. 好喝奶茶店改「統一大杯」（拿掉 size 選項）；冰塊全品項補「少冰」
     （同義詞含「小冰」）。
  5. 錄音全程沒偵測到人聲（VAD）→ 直接丟棄不送辨識、不計失敗；
     連續聽不清的自動暫停門檻 2 → 3。
- **代價**：「三鹽酥雞」這種省略量詞的中文數字講法不再當數量
  （會被當成雜訊或同義詞比對），實測上台灣口語點餐幾乎必帶量詞，
  可接受。

## D23. 防呆倒數棄單＋foodpanda 式改版＋對話紀錄 Seal/Walrus 端對端加密

- **情境**：用戶要求 (1) 送出後仍可反悔的防呆機制 (2) foodpanda/ubereats
  風格 RWD 首頁（菜單常駐＋頂部嘴付下單鍵）(3) 點餐對話 log 加密存證，
  只有用戶與店家能解、平台無權看 (4) 認真設計 logo/favicon。
- **決定**：
  1. 防呆倒數：口頭「確認」之後、`agent_settle` 扣款之前固定 5 秒
     倒數，畫面出現大顆「✋ 反悔棄單」；按下即整單放棄、零扣款
     （Hub 訂單停留在 quoted，無副作用）。結束對話鍵也會中止倒數。
  2. 三站改版（快樂鹽酥雞／好喝奶茶店公版／嘴付入口）：亮色外送
     風設計系統（sticky app bar＋品牌 hero＋卡片菜單 grid＋overlay
     bottom sheet 語音面板），手機單欄、桌機三欄、面板置中；
     手繪 SVG logo（嘴付＝對話框＋嘴唇＋付字金幣；鹽酥雞＝紙袋
     炸雞＋辣椒；奶茶＝珍奶杯）兼作 favicon。
  3. 對話存證：log 在「用戶瀏覽器內」以 Seal（門檻式 IBE，threshold 1/2
     Mysten testnet key servers）加密，身分 id＝用戶地址(32B)‖店家
     地址(32B)；密文由瀏覽器直傳 Walrus（5 epochs）。合約新增
     `chui::log_policy::seal_approve`：只放行 id 內兩方，key server
     發鑰前 dry-run 之——Hub 全程接觸不到明文與金鑰。前端附
     「用 Slush 解密查看」證明鑰匙在用戶手上。存證失敗誠實顯示、
     不影響付款。
  4. go-live 以 CHUI_CONTRACTS_REV 追蹤合約版本，main 有新 commit
     （如本次 log_policy）自動重佈署並提示重新授權。
- **代價**：每筆訂單多 5 秒；重佈署使舊授權失效（testnet 可接受）。
  沙箱無 sui CLI／無鏈上與 Walrus 出網，Move 測試與存證上傳由
  deploy.sh 與真機驗證把關。

## D24. Chui 品牌系統落地：tokens、mark 家族、anthropic-art 手繪插畫語彙

- **情境**：用戶提供 chui-tokens.css（深藍品牌 #2340E6、狀態色綠黃紅
  保留給支付、含深色模式），指定四件品牌資產的用途，並要求安裝
  anthropic-art skill 應用到 UI。
- **決定**：
  1. `branding/`：chui-tokens.css（canonical）＋自繪 chui-mark.svg
     （深藍單色：對話框＋硬幣＋聲波點）、chui-lockup.svg（橫式加
     Chui Protocol 字樣，README 頂圖）、chui-mark-inverse.svg
     （currentColor）、追加 chui-app-icon.svg（象牙白承載形打底——
     純深藍 mark 在深色 UI 上不可見，App/favicon 場景需要底）。
  2. 三站 CSS 全面改吃 tokens：品牌深藍只用於互動元素；支付狀態
     嚴格用 --chui-ok/-pending/-fail（聆聽中＝pending 黃、倒數棄單
     ＝fail 紅、鏈上驗證卡＝ok 綠）；扁平化（去掉漸層，符合手繪
     語彙的 flat 原則）；依系統偏好自動深色（data-theme 腳本）。
  3. anthropic-art skill 安裝於 .claude/skills/anthropic-art（供
     之後的 Claude session 使用）。本環境無點陣圖生成工具，改以
     「SVG 手寫」實作其三層式規範（滿版 accent 底、55–80% 不規則
     象牙白承載形、#141413 圓頭粗線）：三張 hero 插畫（portal＝
     sky 手遞話語成硬幣、鹽酥雞＝clay 紙袋熱氣、奶茶＝oat 珍奶
     聲波）＋兩顆商家 logo 重繪，並記錄於本條目以示誠實。
- **代價**：voice-app（舊入口）僅換 icon 未整套改版；商家站不再有
  各自主色（識別交給 logo 與 hero 插畫），符合「品牌色不越界」規則。

## D25. 贊助資源整合：GMI Cloud 上雲、Atlas 訂單持久化、EastRouter LLM 備援

- **情境**：手機打不到 localhost；黑客松贊助資源（GMI Cloud／MongoDB
  Atlas／EastRouter）能用就用、限免費額度。Fly.io 方案棄用（殘留檔已刪）。
- **決定**：
  1. GMI 上雲（主流前後端分離）：後端整包單容器（既有 Dockerfile）＋
     Caddy 自動 HTTPS（<IP>.sslip.io，免買網域）via docker-compose；
     scripts/deploy-gmi.sh 一鍵 SSH 部署（裝 Docker→rsync 程式碼與
     .env→compose up→等憑證與 healthz→印固定網址）。手機 ?hub= 帶一次
     固定網址即可，永不再變。
  2. Atlas 持久化：新增 OrderStore——MONGODB_URI 有設走 Atlas（訂單
     整份 upsert、啟動即 ping 驗證，壞設定直接失敗絕不無聲退回）；
     沒設退回記憶體（本地原行為）。healthz 誠實揭露 order_store。
  3. EastRouter 備援：封閉詞彙解析信心不足時，把 STT 原文交給
     EastRouter（OpenAI 相容 API）重述成「只含菜單詞彙」的標準句再
     解析一次。安全邊界：LLM 只做重述——重述句仍要過封閉詞彙解析、
     口頭確認、5 秒防呆倒數；三個 env 齊才啟用（不猜端點）；失敗一律
     走原澄清流程。healthz 揭露 llm_assist。
- **代價／誠實聲明**：沙箱無法連 GMI／Atlas／EastRouter——單元測試
  只覆蓋退回行為與純函式（36 pytest 全綠、本地 Hub 冒煙 healthz＝
  memory/off、點餐 API 正常）；三條線上路徑須部署後以 healthz 與
  真機流程驗證。pymongo 為同步驅動，在 async handler 內呼叫（訂單
  寫入極小，demo 可接受；正式版應換 motor）。

## D26. Atlas Oracle 即時匯率（贊助商整合＝Atlas Oracle，非 MongoDB Atlas）

- **情境**：賽方的「Atlas」是 Atlas Oracle（價格預言機，Pull API 回帶
  簽章報價）——與已接的 MongoDB Atlas（訂單持久化）只是撞名，兩者並存。
- **決定**：菜單台幣→鏈上 USDC 的匯率改為可插拔：設定
  ATLAS_ORACLE_API_KEY＋ATLAS_FEED_ID 即用 Atlas Oracle 即時報價
  （30 秒快取；ATLAS_FEED_MEANING 支援 TWD_USD／USD_TWD 兩種 feed
  語意；ATLAS_RATE_MULTIPLIER 供內部測試把真實匯率縮小省測試幣），
  匯率在「報價當下」鎖進訂單（整數運算），fx 來源與 units 一併落單。
  沒設定或呼叫失敗一律退回 .env 固定匯率——healthz 的 fx_source 如實
  顯示 atlas-oracle／static-env，面板同步發 fx.rate 事件。
- **代價／誠實聲明**：oracle 回應的 ECDSA 簽章目前保留原文供稽核但
  「未做鏈下驗章」（需 keccak/secp256k1 相依，列正式版 TODO）；
  沙箱無法連 atlasoracle.io——單元測試覆蓋換算（TWD_USD/USD_TWD/
  縮放/非法值）、回應解析與停用路徑（40 pytest 全綠），線上路徑
  待金鑰發放後以 healthz fx_source=atlas-oracle 驗證。USD≈USDC 的
  近似（未疊第二條 USDC/USD feed）也如實記錄。

## D27. 語音對話品質五修＋三個新頁（用戶訂單史／店家即時看板／店家流水）

- **語音**：
  1. 「忽大忽小聲」根因＝speak() 用估時保險提早放行，麥克風在 Agent
     還沒講完就打開，iOS 進錄音工作階段即壓低播放——改為輪詢
     speechSynthesis.speaking「確定講完」＋250ms 音訊路由歸位緩衝
     才開麥；歡迎語也改 await 完才開始聆聽（開頭無聲／搶拍同因）。
  2. 確認詞聽力：請用戶說「確認下單」（長句誤辨率低）＋同音容錯
     詞表（雀認／確任／缺人…）＋含「確」即肯定（否定詞先擋）。
  3. 結單後主動問「還要再點餐嗎？想離開就說結束對話」；聽到離場
     語意即道別「收到，關閉程式…」並走與 ✕ 相同的關閉流程。
- **三新頁（portal）**：
  1. ?history=1 用戶訂單史：owner 由鏈上 SettlementEvent 回填（非
     前端自報），連 Slush 列出該錢包的訂單；每筆 log 解密都要該
     錢包對 Seal session key 簽名——換一顆錢包 key server 就不發鑰。
  2. ?dash=<merchant_id> 店家即時看板：訂單商業資料（品項／金額／
     單號／鏈上交易）為店家可見明文；訂 Hub SSE，用戶 5 秒反悔期
     結束送單即刻出現；摘要含已收 USDC 總額。
  3. 同頁即店家流水史；log 解密需「店家收款錢包」簽名（消費者與
     平台之外唯一的另一把鑰匙）——身分係從密文自帶 id 推導，新店
     進駐自動隔離，無「發鑰匙發錯店」的環節。
- **Hub**：verify 回傳事件 owner；OrderStore.list_by；
  /v1/logs?owner=、/v1/merchants/{id}/orders、POST /v1/orders/{id}/logref
  （只存 blob id，平台拿到也解不開）。
- **代價**：歷史歸戶依賴鏈上驗證成功（pending 的單不出現在用戶史）；
  店家看板以 URL 直達（demo 未做店家登入）。

## D28. 上雲定案：Fly.io 跑後端整包（不再 localhost，Mac 可關機）
- **背景**：用戶明示「不要再 localhost 請部署至雲」。贊助商資源盤點
  後無一可host後端（AMD／GMI＝LLM token API、Atlas＝資料庫/預言機、
  EastRouter＝LLM 路由），而用戶手上已有 Fly.io token——它是唯一
  「現在就能動」的雲。Named Tunnel 仍需 Mac 開機，不符合新要求。
- **決策**：fly.toml＋scripts/deploy-fly.sh 一鍵部署（單機
  shared-cpu-1x/1GB、常駐不休眠保 SSE 與語音低延遲）；`fly secrets
  import` 注入 .env，新增 .dockerignore 確保 .env 與金鑰絕不烤進
  映像檔、token 只走環境變數不落 git（先前被拒絕的正是「token 進
  git」，本作法迴避之）。網域 hub.chuiprotocol.com 由用戶在
  Cloudflare 把 CNAME 從隧道改指 <app>.fly.dev（DNS only）——前端
  PUBLIC_HUB_URL 不變，零改動。
- **備援**：deploy-gmi.sh 通用 Ubuntu VM 路徑保留；setup-tunnel.sh
  降級為本機開發。**代價**：Fly 最小機約 US$5–7/月（用戶自付）；
  沙箱無外網，deploy-fly.sh 首跑由用戶在 Mac 執行驗證。
- **記憶體單快取警告**：訂單若未接 MongoDB Atlas，雲端重啟＝訂單
  記憶消失（單號流水已持久化於商家端不受影響）——上雲後應盡快完成
  NEXT-STEPS 的 Atlas 接線。

## D29. 上雲改定案：Cloudflare 免費 Worker（用戶指示，取代 D28 的 Fly.io）
- **背景**：用戶明示「用 cloudflare（後端上雲）免費 worker，不要用
  fly.io」。Workers 跑不動 Python——把 Hub 核心整個移植成 TypeScript
  （apps/hub-worker/）：重排序引擎（pypinyin→pinyin-pro；DP／混淆表
  ／字首縮寫／數量量詞規則 1:1 移植）、報價／覆誦、STT 轉發、Atlas
  Oracle／LLM 備援、鏈上 gRPC 驗證（@mysten/sui fetch 基底，Worker
  直接用，不再需要 Node 子行程）。
- **持久化**：Durable Object（SQLite，免費層可用）存訂單＋取餐單號
  流水＋SSE 匯流排——「單號永不重複」在雲上仍成立（重啟實測 0003
  續號）。MongoDB Atlas 角色由 DO 取代（VM 備援模式仍可接）。
- **商家端**：雲端版兩家店協議端點為內建實作（happy-chicken 菜單＝
  adapter 翻譯輸出的快照；接單＝DO 發號）；legacy＋adapter 整合示範
  保留於本機版。如實揭露於 SETUP-CLOUD。
- **部署**：與兩個前端同模式（儀表板 Git 整合、push 即部署、免費、
  免綁卡）；hub.chuiprotocol.com 改綁 Worker custom domain，前端零改動。
- **品質防線**：test_rerank.py 全部案例＋55 筆評估集 90% 門檻移植成
  vitest（9/9 過）；wrangler dev 端到端實測 parse／澄清／confirm 流水
  ／settlement 誠實 pending／看板明細／SSE／panel。已知踩雷記錄：
  pinyin-pro 與 @mysten/sui 都在模組頂層做 Workers 禁止的全域操作
  （setTimeout／隨機值）→ 一律改 handler 內動態 import。
- **代價**：Python 版與 TS 版引擎需雙軌維護（CI 兩邊測試都跑）；
  fly.toml／deploy-fly.sh 已刪。
