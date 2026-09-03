import { defineConfig } from "vite";

// 快樂鹽酥雞官網：build 出 dist/ 由 backend/server.js（自家系統）供應
export default defineConfig({
  build: { outDir: "dist" },
});
