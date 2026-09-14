import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
