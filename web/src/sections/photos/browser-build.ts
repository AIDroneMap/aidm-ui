import type { BunPlugin } from "bun";

/** Stands in for the `?url` imports the build tool resolves in a release: the map worker gets a path under /assets. */
const assetUrls: BunPlugin = { name: "asset-urls", setup(builder) {
  builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "asset-url" }));
  builder.onLoad({ filter: /.*/, namespace: "asset-url" }, args => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
} };

/**
 * Builds a small test page that renders the Photos section: its script, and one style sheet holding the shared
 * styles (as the interface ships them) and whatever the page imports itself. The map worker is not served; a page
 * only reaches it when a photo has a position.
 */
export async function buildPhotosPage(entry: string): Promise<{ script: string; styles: string }> {
  const [page, shared] = await Promise.all([
    Bun.build({ entrypoints: [entry], target: "browser", plugins: [assetUrls] }),
    Bun.build({ entrypoints: [new URL("../../styles.css", import.meta.url).pathname], target: "browser" }),
  ]);
  if (!page.success || !shared.success) throw new Error([...page.logs, ...shared.logs].join("\n"));
  const script = page.outputs.find(output => output.path.endsWith(".js"));
  if (!script) throw new Error("The test page built no script");
  const sheets = await Promise.all([...shared.outputs, ...page.outputs].filter(output => output.path.endsWith(".css")).map(output => output.text()));
  return { script: await script.text(), styles: sheets.join("\n") };
}
