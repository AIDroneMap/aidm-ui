const transpiler = new Bun.Transpiler({ loader: "tsx" });

export function literalText(source: string): string[] {
  const js = transpiler.transformSync(source);
  const found: string[] = [];
  const literal = '"(?:\\\\.|[^"\\\\])*"';
  for (const match of js.matchAll(new RegExp(`\\bchildren:\\s*(${literal})`, "g"))) found.push(JSON.parse(match[1]!).trim());
  for (const match of js.matchAll(new RegExp(`\\bchildren:\\s*\\[([\\s\\S]*?)\\]`, "g"))) {
    for (const item of match[1]!.matchAll(new RegExp(`(?:^|,)\\s*(${literal})\\s*(?=,|$)`, "g"))) found.push(JSON.parse(item[1]!).trim());
  }
  for (const match of js.matchAll(new RegExp(`(?:\\b(?:title|placeholder|alt|label)|"aria-label"):\\s*(${literal})`, "g"))) found.push(JSON.parse(match[1]!));
  return found.filter(Boolean);
}
