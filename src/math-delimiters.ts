import type MarkdownIt from "markdown-it";

// Find a delimiter whose backslash is not itself escaped.
function findClosing(source: string, delimiter: string, start: number, end: number): number {
  for (let pos = source.indexOf(delimiter, start); pos >= 0 && pos + 2 <= end;
    pos = source.indexOf(delimiter, pos + 2)) {
    let preceding = pos - 1;
    while (preceding >= 0 && source[preceding] === "\\") preceding--;
    if ((pos - preceding) % 2 === 1) return pos;
  }
  return -1;
}

/** Add LaTeX delimiters, reusing the KaTeX plugin's math token renderers. */
export default function mathDelimiters(md: MarkdownIt): void {
  // Display math can also occur inside a paragraph (including lazy list
  // continuations). Keep the renderer's options, but use a phrasing wrapper
  // so it does not produce a nested <p> inside the surrounding paragraph.
  md.renderer.rules.latex_math_display = (tokens, index, options, env, renderer) =>
    md.renderer.rules.math_block!(tokens, index, options, env, renderer)
      .replace(/^<p\b/, "<span")
      .replace(/<\/p>\n?$/, "</span>");

  // Run before Markdown consumes backslashes as punctuation escapes.
  md.inline.ruler.before("escape", "latex_math_inline", (state, silent) => {
    const opening = state.src.slice(state.pos, state.pos + 2);
    if (opening !== "\\(" && opening !== "\\[") return false;
    const display = opening === "\\[";
    const start = state.pos + 2;
    const close = findClosing(state.src, display ? "\\]" : "\\)", start, state.posMax);
    if (close < 0 || !state.src.slice(start, close).trim()) return false;
    if (!silent) {
      const token = state.push(display ? "latex_math_display" : "math_inline", "math", 0);
      token.content = state.src.slice(start, close);
      token.markup = opening;
    }
    state.pos = close + 2;
    return true;
  });

  md.block.ruler.before("fence", "latex_math_block", (state, start, end, silent) => {
    // Let unindented list continuations stay in their paragraph; the inline
    // rule handles their math without breaking list numbering or membership.
    if (state.sCount[start] < state.blkIndent) return false;
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const pos = state.bMarks[start] + state.tShift[start];
    if (state.src.slice(pos, pos + 2) !== "\\[") return false;

    const lines: string[] = [];
    for (let line = start; line < end; line++) {
      if (line > start && state.tShift[line] < state.blkIndent && !state.isEmpty(line)) break;
      const from = state.bMarks[line] + state.tShift[line] + (line === start ? 2 : 0);
      const max = state.eMarks[line];
      const close = findClosing(state.src, "\\]", from, max);
      if (close >= 0) {
        // A display block must end on its own line, without trailing prose.
        if (state.src.slice(close + 2, max).trim()) return false;
        lines.push(state.src.slice(from, close));
        if (!lines.join("\n").trim()) return false;
        if (silent) return true;
        const token = state.push("math_block", "math", 0);
        token.block = true;
        token.content = lines.join("\n").trim();
        token.markup = "\\[";
        token.map = [start, line + 1];
        state.line = line + 1;
        return true;
      }
      lines.push(state.src.slice(from, max));
    }
    // An unfinished formula must not swallow the remainder of the document.
    return false;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
}
