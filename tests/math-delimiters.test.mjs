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

test("screenshot display formulas in unindented numbered-list continuations", () => {
  const html = md.render(String.raw`### 14. 面心立方滑移系
1) 单位位错柏氏矢量：
\[
\vec b=\frac{a}{2}[011]
\]
2) 纯刃位错时，位错线方向：
\[
\vec t=\vec b\times\vec n=[011]\times[111]=[\bar{1}1\bar{1}]
\]
纯螺位错时，位错线方向平行于柏氏矢量：
\[
\vec t=[011]
\]

### 15. 二元相图题
1) 合金为过共晶合金。
若共晶点50%B，则：
\[
\beta_{\text{初}}\%=\frac{80-50}{90-50}=75\%
\]
\[
\text{共晶组织}\%=25\%
\]
相组成物：
\[
\alpha\%=\frac{90-80}{90-5}\approx11.8\%
\]
\[
\beta\%\approx88.2\%
\]
2) 冷却速度越快。
3) 扩散退火温度。`);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 7);
  assert.doesNotMatch(html, /katex-error/);
  assert.equal((html.match(/<ol>/g) ?? []).length, 2);
  assert.equal((html.match(/<li>/g) ?? []).length, 5);
  assert.match(html, /<li>冷却速度越快。<\/li>/);
  assert.match(html, /<li>扩散退火温度。<\/li>/);
});

test("display math embedded in prose and loose list paragraphs", () => {
  for (const source of [
    String.raw`前文\[x^2\]后文`,
    "1. 前文\n\\[\nx^2\n\\]\n后文\n\n2. 下一项",
  ]) {
    const html = md.render(source);
    assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
    assert.match(html, /后文/);
    assert.doesNotMatch(html, /<p class="katex-block">/);
    assert.match(html, /<span class="katex-block">/);
  }
});

test("display fallback respects code, escaping and paragraph boundaries", () => {
  for (const source of [
    "`" + String.raw`\[x\]` + "`",
    String.raw`前文\\[x\\]后文`,
    String.raw`前文\[x`,
    "前文\\[x\n\n下一段\\]",
    "1. 前文\\[x\n2. 下一项\\]",
  ]) assert.doesNotMatch(md.render(source), /class="katex/);
  const tokens = md.parseInline(String.raw`前文\[a\\]b\]后文`, {})[0].children;
  assert.equal(tokens[1].type, "latex_math_display");
  assert.equal(tokens[1].content, String.raw`a\\]b`);
});
