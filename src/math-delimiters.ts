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
  // Run before Markdown consumes backslashes as punctuation escapes.
  md.inline.ruler.before("escape", "latex_math_inline", (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== "\\(") return false;
    const start = state.pos + 2;
    const close = findClosing(state.src, "\\)", start, state.posMax);
    if (close < 0 || !state.src.slice(start, close).trim()) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = state.src.slice(start, close);
      token.markup = "\\(";
    }
    state.pos = close + 2;
    return true;
  });

  md.block.ruler.before("fence", "latex_math_block", (state, start, end, silent) => {
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
