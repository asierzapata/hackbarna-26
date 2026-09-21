import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// The landing page is a single static document. No router, no framework:
// whatever we ship here has to stay legible to whoever edits the copy next.
export default defineConfig({
  plugins: [tailwindcss()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:1434", changeOrigin: false } } },
  preview: { proxy: { "/api": { target: "http://127.0.0.1:1434", changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true },
});
