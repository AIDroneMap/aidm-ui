// Serves the component page for review: bun web/src/controls/gallery/serve.ts
// HOST and PORT choose where it listens; by default only this machine reaches it.
import page from "./index.html";

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 0),
  routes: { "/": page },
});

console.log(`Components: ${server.url}`);
