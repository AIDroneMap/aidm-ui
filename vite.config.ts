import { defineConfig } from "vite";
import pkg from "./package.json";

// The interface is plain static files embedded in the executable.
// Nothing is inlined from a CDN and no font is fetched at run time.
// The page carries the version of the build, so it can tell when the server is another one.
export default defineConfig({
  root: "web",
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
