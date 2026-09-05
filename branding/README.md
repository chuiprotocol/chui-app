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
| `chui-endcard.svg` | 影片片尾卡 1920×1080（含兩個 QR code） |

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
| `png/chui-mark-1024.png` | 1024×933，只有 mark、去背、邊界貼齊圖形 |
| `png/chui-mark-square-1024.png` | 1024×1024，只有 mark、去背、置中留白，給頭像／社群 |
| `png/chui-endcard-1920x1080.png` | 1920×1080，片尾卡 |

## 片尾卡與 QR code

`chui-endcard.svg` **由 `scripts/make-endcard.py` 產生，不要手改**——手改會在下次
重跑時被蓋掉。QR code 是用 segno 現算成向量路徑後嵌進 SVG，不是貼上來的圖，
所以畫面上的標籤和實際掃到的網址永遠一致。改網址請改腳本裡的 `SITE`／`REPOS`：

```bash
python3 scripts/make-endcard.py > branding/chui-endcard.svg
```

糾錯等級刻意用 **M 而不是 H**：片尾卡只在螢幕上停幾秒，模組大小比容錯重要，
H 會讓模組變密、遠距離反而更難掃。改完請實際解碼驗證（`zxing-cpp` + `pillow`），
把 PNG 縮到 25% 仍要能解出兩個網址。
