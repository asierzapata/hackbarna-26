import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// The landing page is a single static document. No router, no framework:
// whatever we ship here has to stay legible to whoever edits the copy next.
export default defineConfig({
  plugins: [tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
