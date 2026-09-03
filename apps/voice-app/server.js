// 語音入口 App 的靜態伺服器：dist/ ＋ 執行期設定。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9300);
const HUB_PUBLIC_URL = process.env.HUB_PUBLIC_URL || 'http://localhost:8700';

const app = express();
app.get('/app-config.json', (_req, res) => res.json({ hub_url: HUB_PUBLIC_URL }));

const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
} else {
  app.get('/', (_req, res) => res
    .status(503)
    .send('尚未建置：請先執行 pnpm --filter @chui/voice-app build'));
}

app.listen(PORT, () => {
  console.log(`嘴付語音入口啟動 http://localhost:${PORT}（Hub: ${HUB_PUBLIC_URL}）`);
});
