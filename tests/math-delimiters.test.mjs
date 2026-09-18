import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import MarkdownIt from "markdown-it";
import katexModule from "@vscode/markdown-it-katex";

const source = readFileSync(new URL("../src/math-delimiters.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { default: mathDelimiters } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const md = new MarkdownIt().use(katexModule.default, { throwOnError: false }).use(mathDelimiters);

test("screenshot formulas render without blank lines between paragraphs and blocks", () => {
  const html = md.render(String.raw`面心立方中：
\[
\frac{a}{2}[1\bar{1}0]\rightarrow \frac{a}{6}[1\bar{2}1]+\frac{a}{6}[2\bar{1}\bar{1}]
\]
两位错间排斥力：
\[
F=\frac{G b_1\cdot b_2}{2\pi d}
\]
平衡时\(F=\gamma\)，得：
\[
d=\frac{G a^2}{24\pi \gamma}
\]
后续正文`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /katex-error/);
  assert.match(html, /<p>后续正文<\/p>/);
});

test("inline formulas and one-line display blocks", () => {
  assert.match(md.render(String.raw`中文\(x^2\)中文`), /class="katex"/);
  assert.match(md.render(String.raw`\[x^2\]`), /class="katex-display"/);
});

test("formulas in blockquotes and lists", () => {
  for (const source of ["> \\[\nx\n\\]".replaceAll("\n", "\n> "), "- \\[\n  x\n  \\]"]) {
    assert.match(md.render(source), /class="katex-display"/);
  }
});

test("code, escaped delimiters and unmatched delimiters remain non-math", () => {
  for (const source of [
    "`" + String.raw`\(x\)` + "`",
    "```tex\n\\[x\\]\n```",
    "    \\[x\\]",
    String.raw`\\(x\\)`,
    String.raw`\\[x\\]`,
    "\\[\nx\n\n# Following heading",
    String.raw`text \(x`,
  ]) assert.doesNotMatch(md.render(source), /class="katex/);
  assert.match(md.render("\\[\nx\n\n# Following heading"), /<h1>Following heading<\/h1>/);
});

test("escaped closing delimiter does not end the formula", () => {
  const tokens = md.parseInline(String.raw`\(a\\)b\)`, {})[0].children;
  assert.equal(tokens[0].type, "math_inline");
  assert.equal(tokens[0].content, String.raw`a\\)b`);
});

test("existing dollar math still renders", () => {
  assert.match(md.render("$x^2$"), /class="katex"/);
  assert.match(md.render("$$\nx^2\n$$"), /class="katex-display"/);
});
