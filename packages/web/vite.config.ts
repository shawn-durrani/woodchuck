import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = `127.0.0.1:${process.env.WOODCHUCK_PORT || 8905}`;

export default defineConfig({
  plugins: [react()],
  // three.js alone is most of a megabyte, and this app only runs locally.
  build: { chunkSizeWarningLimit: 1600 },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WOODCHUCK_WEB_PORT || 8906),
    strictPort: true,
    proxy: {
      "/api": `http://${server}`,
      "/ws": { target: `ws://${server}`, ws: true },
    },
  },
});
