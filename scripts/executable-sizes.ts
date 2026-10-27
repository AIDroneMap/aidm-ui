// The size of each platform's executable, as a Markdown table for the release
// notes. It reads the executables the build wrote and prints the table.
// usage: bun scripts/executable-sizes.ts <dist folder>
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The platforms the build makes, in the order the notes list them. */
const PLATFORMS = [
  { file: "aidm-ui-linux-x64", name: "Linux x64" },
  { file: "aidm-ui-linux-arm64", name: "Linux arm64" },
  { file: "aidm-ui-macos-arm64", name: "macOS arm64 (Apple silicon)" },
  { file: "aidm-ui-windows-x64.exe", name: "Windows x64" },
];

/** The table for these files and sizes. A platform whose file is missing is an error: the notes must not leave one out. */
export function sizesTable(sizes: Map<string, number>): string {
  const rows = PLATFORMS.map(({ file, name }) => {
    const bytes = sizes.get(file);
    if (bytes === undefined) throw new Error(`${file} is missing, so its size cannot go into the release notes.`);
    const mib = (bytes / 1024 ** 2).toFixed(1);
    return `| ${name} | \`${file}\` | ${bytes.toLocaleString("en-US")} bytes (${mib} MiB) |`;
  });
  return ["### Executables", "", "| Platform | File | Size |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

export function sizesOf(folder: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const file of readdirSync(folder)) sizes.set(file, statSync(join(folder, file)).size);
  return sizes;
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error("usage: bun scripts/executable-sizes.ts <dist folder>");
    process.exit(2);
  }
  process.stdout.write(`${sizesTable(sizesOf(folder))}\n`);
}
