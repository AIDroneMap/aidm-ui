const bandNamespace = "http://pix4d.com/camera/1.0/";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";
const qualifiedName = /^(?:[\p{L}_][\p{L}\p{N}\p{M}_.-]*:)?[\p{L}_][\p{L}\p{N}\p{M}_.-]*$/u;

function invalid(): never { throw new Error("Invalid XMP"); }
function character(code: number): string {
  if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) invalid();
  return String.fromCodePoint(code);
}
function decode(text: string): string {
  return text.replace(/&([^;]*);|&/g, (entity: string, name: string | undefined) => {
    const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
    if (name !== undefined && Object.hasOwn(known, name)) return known[name]!;
    if (name === undefined || !/^#(?:x[\da-f]+|\d+)$/i.test(name)) invalid();
    return character(name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1)));
  });
}

/** Reads literal band properties. DTDs, external entities and compressed packets are not supported. */
export function xmpBand(xml: string): string | null {
  if (xml.length > 256 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(xml)) invalid();
  const stack: Array<{ name: string; namespaces: Map<string, string>; band: boolean; text: string }> = [];
  let position = 0, tokens = 0, roots = 0;
  let result: string | null = null;
  const record = (value: string) => {
    const text = value.trim();
    if (!text) return;
    if (result !== null && result !== text) invalid();
    result = text;
  };
  const expand = (name: string, namespaces: Map<string, string>, attribute: boolean): [string, string] => {
    if (!qualifiedName.test(name) || name.length > 256) invalid();
    const parts = name.split(":");
    if (parts.length === 1) return [attribute ? "" : namespaces.get("") ?? "", name];
    const uri = namespaces.get(parts[0]!);
    if (!uri) invalid();
    return [uri, parts[1]!];
  };
  while (position < xml.length) {
    if (++tokens > 20000) invalid();
    if (xml.startsWith("<!--", position)) {
      const end = xml.indexOf("-->", position + 4);
      if (end < 0 || xml.slice(position + 4, end).includes("--")) invalid();
      position = end + 3; continue;
    }
    if (xml.startsWith("<?", position)) {
      const end = xml.indexOf("?>", position + 2);
      if (end < 0) invalid();
      position = end + 2; continue;
    }
    if (xml.startsWith("<![CDATA[", position)) {
      const end = xml.indexOf("]]>", position + 9);
      if (end < 0 || !stack.length) invalid();
      if (stack.at(-1)!.band) stack.at(-1)!.text += xml.slice(position + 9, end);
      position = end + 3; continue;
    }
    if (xml[position] !== "<") {
      const next = xml.indexOf("<", position);
      const end = next < 0 ? xml.length : next;
      const text = xml.slice(position, end);
      if (text.includes("]]>")) invalid();
      const value = decode(text);
      if (!stack.length && value.trim()) invalid();
      if (stack.at(-1)?.band) stack.at(-1)!.text += value;
      position = end; continue;
    }
    if (xml.startsWith("<!", position)) invalid();
    let end = position + 1, quote = "";
    for (; end < xml.length; end++) {
      const char = xml[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") invalid();
    }
    if (end === xml.length || quote) invalid();
    let body = xml.slice(position + 1, end);
    position = end + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const frame = stack.pop();
      if (!frame || frame.name !== name) invalid();
      if (frame.band) record(frame.text);
      continue;
    }
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const name = /^[^\s]+/.exec(body)?.[0];
    if (!name || !qualifiedName.test(name) || name.length > 256 || stack.length >= 64) invalid();
    if (!stack.length && ++roots !== 1) invalid();
    if (stack.at(-1)?.band) invalid();
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [["xml", xmlNamespace]]);
    const attributes: Array<[string, string]> = [];
    const pattern = /\s+([^\s=]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
    let cursor = name.length;
    while (cursor < body.length && body.slice(cursor).trim()) {
      pattern.lastIndex = cursor;
      const match = pattern.exec(body);
      if (!match || attributes.length >= 256 || !qualifiedName.test(match[1]!)) invalid();
      attributes.push([match[1]!, decode(match[2] ?? match[3] ?? "")]);
      cursor = pattern.lastIndex;
    }
    const declared = new Set<string>();
    for (const [name, value] of attributes) {
      if (declared.has(name)) invalid();
      declared.add(name);
      if (name === "xmlns" || name.startsWith("xmlns:")) {
        const prefix = name === "xmlns" ? "" : name.slice(6);
        if (prefix === "xmlns" || value === xmlnsNamespace || (prefix === "xml" && value !== xmlNamespace) || (prefix !== "xml" && value === xmlNamespace) || (prefix && !value)) invalid();
        namespaces.set(prefix, value);
      }
    }
    const expanded = new Set<string>();
    for (const [name, value] of attributes) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const [uri, local] = expand(name, namespaces, true);
      const key = JSON.stringify([uri, local]);
      if (expanded.has(key)) invalid();
      expanded.add(key);
      if (uri === bandNamespace && local === "BandName") record(value);
    }
    const [uri, local] = expand(name, namespaces, false);
    if (!selfClosing) stack.push({ name, namespaces, band: uri === bandNamespace && local === "BandName", text: "" });
  }
  if (stack.length || roots !== 1) invalid();
  return result;
}
