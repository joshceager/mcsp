import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
  // No @vitejs/plugin-react: esbuild (Vite's default TS/TSX transform) suffices.
});
