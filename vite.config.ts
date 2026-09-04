import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5319,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4319",
        changeOrigin: true,
        // The terminal (and any future WS endpoint) must proxy through dev
        // too — without ws:true the upgrade request 404s in the browser.
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
