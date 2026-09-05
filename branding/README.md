# Chui Protocol 品牌素材

顏色一律取自 `chui-tokens.css`：`--chui-ink #101A2E`（線稿）、`--chui-ink-muted #5A6879`（副標）、
`--chui-primary #2340E6`（互動色）、象牙白 `#FAF9F5`、承載底色 `#6A9BCC`。
綠／黃／紅保留給支付狀態，永不進品牌素材。

## Mark

一個字符講完整個協議：**對話框＝開口，框裡的 ¥＝就付了，右側聲波＝語音**。
手繪語彙（anthropic-art）：圓不正、線條粗細不均、圓頭端點、刻意不對稱。

| 檔案 | 用在哪 |
|---|---|
| `chui-mark.svg` | 白底／淺色底的純線稿 |
| `chui-mark-inverse.svg` | `currentColor` 版，深色底或彩色底 |
| `chui-app-icon.svg` | favicon、app icon、頁面左上角（象牙白承載形打底） |
| `chui-lockup.svg` | 橫式：文件頁首、簡報頁首 |
| `chui-lockup-stacked.svg` | 直式：影片片尾卡、正方形頭像、海報中央 |
| `chui-banner.svg` | README 頁首橫幅 1280×440 |

## 規則

- **字樣一律帶 `textLength` + `lengthAdjust="spacingAndGlyphs"`。**
  素材會在沒有 PingFang TC 的系統上被檢視（GitHub 的算繪、Windows），
  沒有這兩個屬性版面會被撐破、文字被裁掉。改字時記得同步改 `textLength`。
- **橫幅用滿版底色**，深色／淺色 GitHub 主題下看起來才一樣。
- `apps/portal/public/` 與 `apps/voice-app/public/` 的 `logo.svg`／`favicon.svg`
  是 `chui-app-icon.svg` 的複本，改 mark 時要一起複製過去。

## PNG 匯出

`png/` 底下是去背 PNG，給不吃 SVG 的工具用（iMovie、Keynote、簡報範本、社群圖）：

| 檔案 | 尺寸 |
|---|---|
| `png/chui-banner@2x.png` | 2560×880 |
| `png/chui-lockup@2x.png` | 1320×408（去背） |
| `png/chui-lockup-stacked@2x.png` | 1200×900（去背） |
| `png/chui-app-icon-512.png` | 512×512 |
