import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun,
  LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, Tab, TextRun, WidthType,
  type ILevelsOptions, type IParagraphOptions, type IRunOptions, type ParagraphChild,
} from "docx";

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];
const MONOSPACE = { font: "Consolas" };
const BLOCK_TAGS = /^(P|H[1-6]|PRE|HR|BLOCKQUOTE|UL|OL|TABLE|DIV|SECTION|ARTICLE|FIGURE|FIGCAPTION)$/;
const SKIP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED)$/;

async function embedImage(src: string): Promise<{ data: ArrayBuffer; width: number; height: number } | null> {
  if (!/^(https?:|asset:|\/\/|data:image\/)/i.test(src)) return null;
  try {
    const response = await fetch(src, { credentials: "omit", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const url = URL.createObjectURL(await response.blob());
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const scale = Math.min(1, 576 / image.naturalWidth, 720 / image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
      return png && { data: await png.arrayBuffer(), width: canvas.width, height: canvas.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/** Convert a snapshot of the Markdown renderer's output into editable Word content. */
export async function buildDocx(
  html: string,
  title: string,
  resolveImage: (src: string) => string,
): Promise<ArrayBuffer> {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const images = new Map<string, ReturnType<typeof embedImage>>();
  const imageRuns = new Map<HTMLImageElement, ImageRun>();
  await Promise.all(Array.from(body.querySelectorAll("img"), async (image) => {
    const src = resolveImage(image.getAttribute("src") ?? "");
    if (!images.has(src)) images.set(src, embedImage(src));
    const embedded = await images.get(src);
    if (embedded) {
      const { data, width, height } = embedded;
      imageRuns.set(image, new ImageRun({
        type: "png", data, transformation: { width, height },
        altText: { name: "图片", title: image.alt, description: image.alt },
      }));
    }
  }));

  const numbering: { reference: string; levels: ILevelsOptions[] }[] = [];

  function inline(node: Node, style: IRunOptions = {}): ParagraphChild[] {
    if (node.nodeType === Node.TEXT_NODE) {
      return [new TextRun({ ...style, text: node.textContent!.replace(/[ \t\r\n]+/g, " ") })];
    }
    if (!(node instanceof Element) || SKIP_TAGS.test(node.tagName)) return [];
    if (node.classList.contains("katex")) {
      const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex != null) return [new TextRun({ ...style, ...MONOSPACE, text: latex.replace(/\s+/g, " ") })];
    }

    switch (node.tagName) {
      case "BR": return [new TextRun({ break: 1 })];
      case "IMG": {
        const image = node as HTMLImageElement;
        return [imageRuns.get(image) ?? new TextRun({ ...style, text: image.alt || "[图片无法加载]" })];
      }
      case "INPUT":
        return node.getAttribute("type") === "checkbox"
          ? [new TextRun({ ...style, text: node.hasAttribute("checked") ? "☑ " : "☐ " })]
          : [];
      case "STRONG": case "B": style = { ...style, bold: true }; break;
      case "EM": case "I": style = { ...style, italics: true }; break;
      case "S": case "DEL": style = { ...style, strike: true }; break;
      case "CODE": style = { ...style, ...MONOSPACE }; break;
      case "A": {
        const link = node.getAttribute("href") ?? "";
        if (/^(https?:|mailto:)/i.test(link)) {
          const children = Array.from(node.childNodes).flatMap((child) => inline(child, { ...style, style: "Hyperlink" }));
          return [new ExternalHyperlink({ link, children })];
        }
        break;
      }
    }
    return Array.from(node.childNodes).flatMap((child) => inline(child, style));
  }

  function table(element: HTMLTableElement): Table | null {
    const rows = Array.from(element.rows).filter((row) => row.cells.length).map((row) => new TableRow({
      tableHeader: row.parentElement?.tagName === "THEAD",
      children: Array.from(row.cells, (cell) => {
        const heading = cell.tagName === "TH";
        const alignment = cell.style.textAlign === "right" ? AlignmentType.RIGHT
          : cell.style.textAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
        return new TableCell({
          columnSpan: cell.colSpan,
          shading: heading ? { fill: "E9EDF2" } : undefined,
          children: [new Paragraph({
            alignment,
            spacing: { before: 60, after: 60 },
            children: Array.from(cell.childNodes).flatMap((node) => inline(node, { bold: heading })),
          })],
        });
      }),
    }));
    return rows.length ? new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }) : null;
  }

  function blocks(
    container: Element,
    listDepth = 0,
    quoteDepth = 0,
    itemNumbering?: IParagraphOptions["numbering"],
  ): (Paragraph | Table)[] {
    const result: (Paragraph | Table)[] = [];
    const left = (listDepth + quoteDepth) * 360;
    let pending: Node[] = [];
    function paragraph(options: IParagraphOptions = {}) {
      result.push(new Paragraph({
        spacing: { after: 120 },
        ...(itemNumbering ? { numbering: itemNumbering } : { indent: left ? { left } : undefined }),
        ...options,
      }));
      itemNumbering = undefined;
    }
    function flush() {
      while (pending.length && pending[0].nodeType === Node.TEXT_NODE && !pending[0].textContent?.trim()) pending.shift();
      while (pending.length && pending[pending.length - 1].nodeType === Node.TEXT_NODE && !pending[pending.length - 1].textContent?.trim()) pending.pop();
      if (pending.length) paragraph({ children: pending.flatMap((node) => inline(node)) });
      pending = [];
    }
    function addBlocks(children: (Paragraph | Table)[]) {
      if (itemNumbering) paragraph();
      result.push(...children);
    }

    for (const node of container.childNodes) {
      if (!(node instanceof Element) || !BLOCK_TAGS.test(node.tagName)) {
        pending.push(node);
        continue;
      }
      flush();
      switch (node.tagName) {
        case "PRE": {
          const lines = (node.textContent ?? "").replace(/\n$/, "").split("\n");
          const children = lines.map((line, index) => new TextRun({
            ...MONOSPACE, break: index ? 1 : 0,
            children: line.split("\t").flatMap((part, i) => i ? [new Tab(), part] : [part]),
          }));
          paragraph({ children, shading: { fill: "F2F4F6" } });
          break;
        }
        case "HR":
          paragraph({ border: { bottom: { style: BorderStyle.SINGLE, color: "AAB4BE", size: 6 } } });
          break;
        case "UL": case "OL": {
          const ordered = node.tagName === "OL";
          const reference = `list-${numbering.length}`;
          numbering.push({
            reference,
            levels: [{
              level: 0, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
              text: ordered ? "%1." : "•",
              start: ordered ? (node as HTMLOListElement).start : 1,
              style: { paragraph: { indent: { left: left + 360, hanging: 240 } } },
            }],
          });
          for (const item of node.children) {
            if (item.tagName === "LI") addBlocks(blocks(item, listDepth + 1, quoteDepth, { reference, level: 0 }));
          }
          break;
        }
        case "TABLE": {
          const content = table(node as HTMLTableElement);
          if (content) addBlocks([content]);
          break;
        }
        case "BLOCKQUOTE":
          addBlocks(blocks(node, listDepth, quoteDepth + 1));
          break;
        case "DIV": case "SECTION": case "ARTICLE": case "FIGURE": case "FIGCAPTION":
          addBlocks(blocks(node, listDepth, quoteDepth));
          break;
        default:
          paragraph({
            heading: HEADINGS[Number(node.tagName[1]) - 1],
            children: Array.from(node.childNodes).flatMap((child) => inline(child)),
          });
      }
    }
    flush();
    if (itemNumbering) paragraph();
    return result;
  }

  const children = blocks(body);
  return Packer.toArrayBuffer(new Document({
    title,
    numbering: { config: numbering },
    sections: [{ children: children.length ? children : [new Paragraph("")] }],
  }));
}
