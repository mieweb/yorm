import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The eSheet packages declare their own React copy; dedupe pins everything to
// this example's React 18 install so hooks share one dispatcher.
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "dist" },
  server: {
    port: 5173,
    proxy: {
      "/yorm": { target: "http://localhost:5178", ws: true },
      "/api": { target: "http://localhost:5178" },
    },
  },
});
