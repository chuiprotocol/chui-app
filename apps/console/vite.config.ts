import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 後台開發伺服器。API 位址由 VITE_CHUI_API_URL 控制（預設 127.0.0.1:8787）
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
