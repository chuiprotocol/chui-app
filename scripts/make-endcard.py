#!/usr/bin/env python3
"""產生影片片尾卡（1920×1080）。

QR code 用 segno 現算，不是貼圖：改網址重跑就好，掃描永遠對得上畫面標籤。
糾錯等級刻意用 M 而不是 H——片尾卡只在螢幕上停幾秒，模組大小比容錯重要，
H 會讓模組變密、遠距離反而難掃。

用法：python3 scripts/make-endcard.py > branding/chui-endcard.svg
"""
import segno

SITE = "https://chuiprotocol.com"
REPOS = "https://github.com/orgs/chuiprotocol/repositories"

INK, MUTED, IVORY, SKY, LINE = "#101A2E", "#5A6879", "#FAF9F5", "#6A9BCC", "#E3E7EC"
CJK = "'PingFang TC','Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif"
LAT = "'Avenir Next','Helvetica Neue',ui-rounded,system-ui,sans-serif"


def qr_path(data, x, y, size):
    """把 QR 矩陣壓成單一 path：每列連續的黑模組合併成一個矩形。"""
    qr = segno.make(data, error="m")
    m = [list(row) for row in qr.matrix]
    n = len(m)
    unit = size / n
    seg = []
    for r, row in enumerate(m):
        c = 0
        while c < n:
            if row[c]:
                start = c
                while c < n and row[c]:
                    c += 1
                px, py = x + start * unit, y + r * unit
                w, h = (c - start) * unit, unit
                seg.append(f"M{px:.2f} {py:.2f}h{w:.2f}v{h:.2f}h-{w:.2f}z")
            else:
                c += 1
    return "".join(seg), qr.version, n


site_d, site_v, site_n = qr_path(SITE, 570, 540, 300)
repo_d, repo_v, repo_n = qr_path(REPOS, 1050, 540, 300)

MARK = f'''  <g transform="translate(865.2 49.6) scale(1.573)">
    <g transform="translate(-3 1.5)" stroke="{INK}" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path stroke-width="8" d="M33 77 L24 99 L46 84 Q60 89 71 81 Q86 71 86 54 Q86 35 70 26 Q54 18 39 25 Q22 33 21 51 Q20 66 30 74 Z"/>
      <path stroke-width="7"   d="M55 32 L54.6 68"/>
      <path stroke-width="6.5" d="M44 43.5 L67 42.7"/>
      <path stroke-width="6.5" d="M44.2 54 L67.2 53.2"/>
      <path stroke-width="6.5" d="M93 38 Q100 52 93 66"/>
      <path stroke-width="6"   d="M103 31 Q112 52 103 73"/>
    </g>
  </g>'''

print(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" fill="none"
     role="img" aria-labelledby="chui-endcard-title">
  <title id="chui-endcard-title">Chui Protocol 嘴付協議 — 開口就買單，嘴付真簡單。官網 chuiprotocol.com，GitHub chuiprotocol</title>
  <!-- 影片片尾卡 1920×1080。由 scripts/make-endcard.py 產生，勿手改。
       QR code 是現算的（segno，糾錯等級 M），改網址請改腳本裡的 SITE／REPOS 再重跑。
       官網 QR＝{SITE}（版本 {site_v}，{site_n}×{site_n} 模組）
       GitHub QR＝{REPOS}（版本 {repo_v}，{repo_n}×{repo_n} 模組） -->
  <rect width="1920" height="1080" fill="{SKY}"/>
  <path fill="{IVORY}" d="M128 42 Q60 50 54 118 L48 878 Q44 1002 136 1008 L1764 1010 Q1860 1012 1864 926 L1868 124 Q1868 42 1780 40 Z"/>
{MARK}
  <text x="960" y="296" text-anchor="middle" textLength="436" lengthAdjust="spacingAndGlyphs"
        font-family="{LAT}" font-size="68" font-weight="800" fill="{INK}">Chui Protocol</text>
  <text x="960" y="342" text-anchor="middle" textLength="184" lengthAdjust="spacingAndGlyphs"
        font-family="{CJK}" font-size="32" font-weight="700" fill="{MUTED}">嘴付協議</text>
  <text x="960" y="456" text-anchor="middle" textLength="858" lengthAdjust="spacingAndGlyphs"
        font-family="{CJK}" font-size="78" font-weight="800" fill="{INK}">開口就買單，嘴付真簡單</text>

  <rect x="550" y="520" width="340" height="340" rx="24" fill="#FFFFFF" stroke="{LINE}" stroke-width="2"/>
  <path fill="{INK}" d="{site_d}"/>
  <rect x="1030" y="520" width="340" height="340" rx="24" fill="#FFFFFF" stroke="{LINE}" stroke-width="2"/>
  <path fill="{INK}" d="{repo_d}"/>

  <text x="720" y="908" text-anchor="middle" textLength="290" lengthAdjust="spacingAndGlyphs"
        font-family="{CJK}" font-size="30" font-weight="700" fill="{INK}">官網 chuiprotocol.com</text>
  <text x="1200" y="908" text-anchor="middle" textLength="290" lengthAdjust="spacingAndGlyphs"
        font-family="{CJK}" font-size="30" font-weight="700" fill="{INK}">GitHub · chuiprotocol</text>
  <text x="960" y="962" text-anchor="middle" textLength="600" lengthAdjust="spacingAndGlyphs"
        font-family="{CJK}" font-size="26" font-weight="600" fill="{MUTED}">Sui Testnet · USDC · 對話紀錄端對端加密</text>
</svg>''')
