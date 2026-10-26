import { defineConfig } from "vite";

// The interface is plain static files embedded in the executable.
// Nothing is inlined from a CDN and no font is fetched at run time.
export default defineConfig({
  root: "web",
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
