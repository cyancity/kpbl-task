import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // "::" dual-stack: accept both ::1 and 127.0.0.1 — plain "localhost"
    // resolves to ::1 on this machine and would leave IPv4 browsers refused.
    host: "::",
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "http://localhost:3000", changeOrigin: true, ws: true },
    },
  },
});
