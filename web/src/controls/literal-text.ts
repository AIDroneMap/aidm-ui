import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "typescript/unstable/async";
import { SyntaxKind, type Node } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";

const textAttributes = new Set(["title", "placeholder", "aria-label", "aria-description", "aria-valuetext", "alt", "label"]);

function inspect(file: Node): string[] {
  const found: string[] = [];
  const add = (text: string) => { if (text.trim()) found.push(text); };
  function output(node: Node): void {
    if (is.isStringLiteral(node) || is.isNoSubstitutionTemplateLiteral(node)) add(node.text);
    else if (is.isTemplateExpression(node)) {
      const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(node.head.text);
      if (!address) add(node.head.text);
      for (const span of node.templateSpans) {
        output(span.expression);
        if (!address || /[\p{L}\p{N}]/u.test(span.literal.text)) add(span.literal.text);
      }
    } else if (is.isConditionalExpression(node)) {
      output(node.whenTrue); output(node.whenFalse);
    } else if (is.isBinaryExpression(node)) {
      if (node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken) output(node.right);
      else if ([SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken, SyntaxKind.PlusToken].includes(node.operatorToken.kind)) { output(node.left); output(node.right); }
    } else if (is.isParenthesizedExpression(node) || is.isAsExpression(node) || is.isNonNullExpression(node) || is.isSatisfiesExpression(node)) output(node.expression);
    else if (is.isArrayLiteralExpression(node)) for (const item of node.elements) output(item);
  }
  function visit(node: Node): void {
    if (is.isJsxText(node)) add(node.text.trim());
    if (is.isJsxAttribute(node) && textAttributes.has(node.name.getText()) && node.initializer) {
      if (is.isJsxExpression(node.initializer)) { if (node.initializer.expression) output(node.initializer.expression); }
      else output(node.initializer);
    }
    if (is.isJsxExpression(node) && (is.isJsxElement(node.parent) || is.isJsxFragment(node.parent)) && node.expression) output(node.expression);
    node.forEachChild(visit);
  }
  visit(file);
  return found;
}

export async function literalTexts(sources: string[]): Promise<string[][]> {
  const dir = await mkdtemp(join(tmpdir(), "aidm-text-"));
  const paths = sources.map((_, index) => join(dir, `${index}.tsx`));
  const api = new API();
  try {
    await Promise.all(paths.map((path, index) => writeFile(path, sources[index]!)));
    const snapshot = await api.updateSnapshot({ openFiles: paths });
    try {
      return await Promise.all(paths.map(async (path) => {
        const project = await snapshot.getDefaultProjectForFile(path);
        const file = await project?.program.getSourceFile(path);
        if (!file) throw new Error(`Cannot parse ${path}`);
        return inspect(file);
      }));
    } finally { await snapshot.dispose(); }
  } finally { await api.close(); await rm(dir, { recursive: true, force: true }); }
}

export async function literalText(source: string): Promise<string[]> {
  return (await literalTexts([source]))[0]!;
}
