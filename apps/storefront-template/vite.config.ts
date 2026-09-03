import { defineConfig } from "vite";

// 公版店面：build 出 dist/ 由 server.js 供應（同一個 port 同時服務協議端點）
export default defineConfig({
  build: { outDir: "dist" },
});
