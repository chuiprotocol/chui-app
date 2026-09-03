import { defineConfig } from "vite";

// 嘴付公版入口：純靜態，部署到 Cloudflare Pages
export default defineConfig({
  build: { outDir: "dist" },
});
