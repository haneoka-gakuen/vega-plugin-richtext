import LineBreaker from "linebreak";
import { parseAdvRichText, type AdvRichTextNode } from "../adv/parser";
import type {
  SdfColor,
  SdfFont,
  SdfGlyph,
  SdfGlyphQuad,
  SdfMarkQuad,
  SdfTextLayout,
  SdfTextLayoutOptions,
} from "./types.js";

interface Style {
  size: number;
  color: SdfColor;
  bold: boolean;
  italic: boolean;
  offset: number;
  noBreak: boolean;
  align?: "left" | "center" | "right";
  rotate?: number;
  cspace?: number;
  mark?: SdfColor;
}
interface Atom {
  text: string;
  advance: number;
  spacing?: number;
  ascent: number;
  descent: number;
  quads: SdfGlyphQuad[];
  noBreak: boolean;
  newline?: boolean;
  /** Per-run paragraph alignment (<align>). */
  align?: Style["align"];
  /** <pos>: absolute horizontal origin jump, resolved once during the width walk. */
  posX?: number;
  /** <mark> highlight painted behind the atom's run. */
  mark?: SdfColor;
  /** Code-point offset of this atom in the plain text, for typewriter reveal. */
  characterIndex?: number;
}
const LENGTH_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
const SIMPLE_LENGTH = new RegExp(`^(${LENGTH_NUMBER})(px|em|%)?$`, "u");
// These are the two calibrated-pixel forms emitted by the ADV parser.
const PIXEL_LENGTH = `calc\\((${LENGTH_NUMBER}) \\* var\\(--vega-adv-pixel, 1px\\)\\)`;
const ABSOLUTE_PIXEL_LENGTH = new RegExp(`^${PIXEL_LENGTH}$`, "u");
const RELATIVE_PIXEL_LENGTH = new RegExp(`^calc\\(1em \\+ ${PIXEL_LENGTH}\\)$`, "u");

const length = (value: string, size: number, pixelScale: number): number => {
  const simple = SIMPLE_LENGTH.exec(value);
  if (simple) {
    const number = Number(simple[1]);
    if (!Number.isFinite(number)) return 0;
    return simple[2] === "em" ? number * size : simple[2] === "%" ? (number * size) / 100 : number * pixelScale;
  }
  const absolute = ABSOLUTE_PIXEL_LENGTH.exec(value);
  const relative = absolute ? null : RELATIVE_PIXEL_LENGTH.exec(value);
  const number = Number((absolute ?? relative)?.[1]);
  if (!Number.isFinite(number)) return 0;
  return (relative ? size : 0) + number * pixelScale;
};
const selectGlyph = (
  fonts: readonly SdfFont[],
  char: string,
): { font: SdfFont; glyph: SdfGlyph; scale: number } | undefined => {
  const code = String(char.codePointAt(0));
  for (const font of fonts) {
    const record = font.characters[code];
    if (!record) continue;
    const glyph = font.glyphs[String(record[0])];
    if (glyph) return { font, glyph, scale: record[1] };
  }
  return undefined;
};

export function layoutSdfText(source: string, options: SdfTextLayoutOptions): SdfTextLayout {
  const primary = options.fonts[0];
  if (!primary) return { quads: [], width: 0, height: 0, text: source, missing: [...source], lines: 0 };
  const baseSize = Math.max(0, options.fontSize);
  const pixelScale = options.pixelScale ?? 1;
  const missing = new Set<string>();
  const atoms: Atom[] = [];
  const em = baseSize * 0.01;
  const baseScale = (baseSize / primary.size) * primary.scale;
  const baseAscent = primary.ascent * baseScale;
  const baseDescent = primary.descent * baseScale;
  const baseLineGap = (primary.lineHeight - primary.ascent + primary.descent) * baseScale;
  const explicitSpacing = (options.lineSpacing ?? 0) * em;
  const style: Style = {
    size: baseSize,
    color: options.color ?? [1, 1, 1, 1],
    bold: options.bold ?? false,
    italic: false,
    offset: 0,
    noBreak: false,
  };
  const addText = (text: string, state: Style) => {
    for (const char of text) {
      if (char === "\n" || char === "\r") {
        atoms.push({
          text: "\n",
          advance: 0,
          ascent: baseAscent,
          descent: baseDescent,
          quads: [],
          noBreak: false,
          newline: true,
        });
        continue;
      }
      const selected = selectGlyph(options.fonts, char);
      if (!selected) {
        if (!/[\u200b\u200c\u200d\ufeff]/u.test(char)) missing.add(char);
        atoms.push({
          text: char,
          advance: /\s/u.test(char) ? state.size * 0.25 : 0,
          ascent: baseAscent,
          descent: baseDescent,
          quads: [],
          noBreak: state.noBreak,
        });
        continue;
      }
      const { font, glyph } = selected;
      const scale = (state.size / font.size) * font.scale * glyph.scale * selected.scale;
      const [width, height, bearingX, bearingY, advance] = glyph.metrics;
      const padding = font.padding;
      const space = /\s/u.test(char);
      const quads: SdfGlyphQuad[] =
        width > 0 && height > 0 && !space
          ? [
              {
                font,
                glyph,
                character: char,
                x: (bearingX - padding) * scale,
                y: -(bearingY + padding) * scale + state.offset,
                width: (width + padding * 2) * scale,
                height: (height + padding * 2) * scale,
                scale,
                color: state.color,
                bold: state.bold,
                italic: state.italic,
              },
            ]
          : [];
      const spacing = ((options.characterSpacing ?? 0) + (state.bold ? font.boldSpacing : 0)) * em;
      const extraSpacing = state.cspace ?? 0;
      atoms.push({
        text: char,
        advance: advance * scale + spacing + extraSpacing + (space ? (options.wordSpacing ?? 0) * em : 0),
        spacing: spacing + extraSpacing,
        ascent: ((font.ascent * state.size) / font.size) * font.scale,
        descent: ((font.descent * state.size) / font.size) * font.scale,
        quads: quads.map((q) => (state.rotate ? { ...q, rotate: state.rotate } : q)),
        noBreak: state.noBreak,
        ...(state.align ? { align: state.align } : {}),
        ...(state.mark ? { mark: state.mark } : {}),
      });
    }
  };
  const visit = (nodes: readonly AdvRichTextNode[], state: Style): void => {
    for (const node of nodes) {
      if (node.type === "text") addText(node.value, state);
      else if (node.type === "break") addText("\n", state);
      else if (node.type === "space") {
        const advance =
          node.value * (node.unit === "px" ? pixelScale : node.unit === "%" ? state.size / 100 : state.size);
        atoms.push({
          text: "",
          advance,
          ascent: baseAscent,
          descent: baseDescent,
          quads: [],
          noBreak: true,
        });
      } else if (node.type === "size") visit(node.children, { ...state, size: (baseSize * node.percent) / 100 });
      else if (node.type === "style") {
        const next = { ...state };
        if (node.style.fontWeight) next.bold = Number(node.style.fontWeight) >= 600 || node.style.fontWeight === "bold";
        if (node.style.fontStyle) next.italic = node.style.fontStyle === "italic";
        if (node.style.fontSize) {
          next.size = Math.max(0, length(node.style.fontSize, baseSize, pixelScale));
        }
        if (node.style.top) next.offset += length(node.style.top, next.size, pixelScale);
        if (node.style.whiteSpace === "nowrap") next.noBreak = true;
        if (node.style.color && options.parseColor) next.color = options.parseColor(node.style.color);
        if (node.style.textAlign) {
          const value = node.style.textAlign.toLowerCase();
          if (value === "left" || value === "center" || value === "right") next.align = value;
        }
        if (node.style.rotate) {
          const value = parseFloat(node.style.rotate);
          if (Number.isFinite(value) && value !== 0) next.rotate = value;
        }
        if (node.style.letterSpacing) next.cspace = length(node.style.letterSpacing, next.size, pixelScale);
        if (node.style.background && options.parseColor) next.mark = options.parseColor(node.style.background);
        // <pos>: jump the absolute horizontal origin before the children. The
        // jump is resolved against the accumulating line width in the break
        // walk, so it stays consistent with wrapping and alignment.
        if (node.style.position === "absolute" && node.style.left) {
          atoms.push({
            text: "",
            advance: 0,
            ascent: baseAscent,
            descent: baseDescent,
            quads: [],
            noBreak: true,
            ...(next.align ? { align: next.align } : {}),
            posX: length(node.style.left, next.size, pixelScale),
          });
        }
        visit(node.children, next);
      } else if (node.type === "ruby") {
        const rubyScale = options.ruby?.scale ?? 0.5;
        const base = layoutSdfText(node.base, {
          ...options,
          fontSize: state.size,
          color: state.color,
          bold: state.bold,
          maxWidth: Infinity,
        });
        const annotation = layoutSdfText(node.annotation, {
          ...options,
          fontSize: state.size * rubyScale,
          color: state.color,
          bold: state.bold,
          maxWidth: Infinity,
        });
        base.missing.forEach((c) => missing.add(c));
        annotation.missing.forEach((c) => missing.add(c));
        const scale = (state.size / primary.size) * primary.scale;
        const ascent = primary.ascent * scale;
        const alignment = options.ruby?.alignment ?? "center";
        const leading = alignment === "base" ? 0 : Math.max(0, (annotation.width - base.width) / 2);
        const baseX = leading;
        const annotationX = leading + (base.width - annotation.width) / 2;
        // Keep the authored overhang (notably for base/annotation alignment),
        // but advance past the rightmost ruby content so the next atom cannot
        // overlap an annotation that extends beyond the base.
        const advance = Math.max(baseX + base.width, annotationX + annotation.width);
        const annotationTop =
          options.ruby?.verticalOffset === undefined
            ? -ascent - annotation.height
            : -(annotation.baseline ?? ascent * rubyScale) - state.size * options.ruby.verticalOffset;
        atoms.push({
          text: node.base,
          advance,
          ascent,
          descent: primary.descent * scale,
          noBreak: true,
          quads: [
            ...base.quads.map((q) => ({ ...q, x: q.x + baseX, y: q.y - (base.baseline ?? ascent) + state.offset })),
            ...annotation.quads.map((q) => ({
              ...q,
              x: q.x + annotationX,
              y: q.y + annotationTop + state.offset,
            })),
          ],
        });
      }
    }
  };
  visit(parseAdvRichText(source), style);
  let characterIndex = 0;
  for (const atom of atoms) {
    atom.characterIndex = characterIndex;
    atom.quads = atom.quads.map((quad, index) => ({
      ...quad,
      characterIndex: characterIndex + Math.min(index, Math.max(0, [...atom.text].length - 1)),
    }));
    characterIndex += [...atom.text].length;
  }
  for (let i = 1; i < atoms.length; i++) {
    const left = atoms[i - 1]!,
      right = atoms[i]!;
    const a = left.quads[0],
      b = right.quads[0];
    if (!a || !b || a.font !== b.font || left.quads.length !== 1 || right.quads.length !== 1) continue;
    const pair = a.font.pairs?.[`${a.glyph.index},${b.glyph.index}`];
    if (!pair) continue;
    left.advance += pair[0] * a.scale;
    right.advance += pair[2] * b.scale;
    left.quads[0] = { ...a, x: a.x + pair[1] * a.scale };
    right.quads[0] = { ...b, x: b.x + pair[3] * b.scale };
  }
  const text = atoms.map((atom) => atom.text).join("");
  const breaker = new LineBreaker(text);
  const opportunities = new Set<number>();
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) opportunities.add(next.position);
  const ends: number[] = [];
  let offset = 0;
  for (const atom of atoms) {
    offset += atom.text.length;
    ends.push(offset);
  }
  const maxWidth = Math.max(0, options.maxWidth ?? Infinity);
  const lines: Atom[][] = [];
  let current: Atom[] = [];
  let currentWidth = 0;
  let lastBreak = -1;
  const widthOf = (line: Atom[]) => line.reduce((sum, a) => sum + a.advance, 0);
  const pushLine = () => {
    lines.push(current);
    current = [];
    currentWidth = 0;
    lastBreak = -1;
  };
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i]!;
    if (atom.newline) {
      pushLine();
      continue;
    }
    // <pos>: consume the jump into the atom's advance so width accumulation,
    // wrapping and placement all see the origin move the same way. The marker
    // atom stays in the line (it draws nothing) so the following glyphs are
    // placed after the jump.
    if (atom.posX != null) atom.advance = Math.max(0, atom.posX - currentWidth);
    if (atom.noBreak && !atoms[i - 1]?.noBreak && current.length) lastBreak = current.length;
    if (
      current.length &&
      currentWidth + atom.advance - (atom.spacing ?? 0) > maxWidth &&
      (lastBreak > 0 || !atom.noBreak)
    ) {
      if (lastBreak > 0) {
        const tail = current.splice(lastBreak);
        pushLine();
        current = tail;
        currentWidth = widthOf(tail);
      } else pushLine();
    }
    current.push(atom);
    currentWidth += atom.advance;
    if (opportunities.has(ends[i]!) && !atom.noBreak) lastBreak = current.length;
  }
  if (current.length || !lines.length || atoms.at(-1)?.newline) pushLine();
  const quads: SdfGlyphQuad[] = [];
  const marks: SdfMarkQuad[] = [];
  let top = 0,
    measuredWidth = 0,
    baseline = baseAscent,
    lastLineAdvance = 0;
  type Align = "left" | "center" | "right";
  const defaultAlign: Align = options.align ?? "left";
  for (const line of lines) {
    const ascent = Math.max(baseAscent, ...line.map((a) => a.ascent));
    if (top === 0) baseline = ascent;
    const descent = Math.min(baseDescent, ...line.map((a) => a.descent));
    const width = widthOf(line) - (line.at(-1)?.spacing ?? 0);
    measuredWidth = Math.max(measuredWidth, width);
    // Placement: contiguous atoms sharing one alignment form a run. A single
    // run uses the plain TMP offset; mixed runs (e.g. a <align="left"> title
    // beside <align="right"> mirror text on one line) anchor left runs at the
    // left edge, right runs at the right edge, and centre the remaining runs
    // in the space between.
    const runs: { align: Align; start: number; end: number; width: number }[] = [];
    for (let i = 0; i < line.length; ) {
      const align = line[i]!.align ?? defaultAlign;
      let j = i;
      let runWidth = 0;
      while (j < line.length && (line[j]!.align ?? defaultAlign) === align) {
        runWidth += line[j]!.advance;
        j += 1;
      }
      runs.push({ align, start: i, end: j, width: runWidth });
      i = j;
    }
    const single = runs.length === 1 ? runs[0]! : undefined;
    // Mixed-run anchoring needs a finite right edge; unbounded containers
    // (nowrap, ruby sub-layouts) always fall back to left-flow placement.
    const bound = Number.isFinite(maxWidth) ? maxWidth : width;
    const leftWidth = runs.reduce((sum, r) => (r.align === "left" ? sum + r.width : sum), 0);
    const rightWidth = runs.reduce((sum, r) => (r.align === "right" ? sum + r.width : sum), 0);
    const centerWidth = runs.reduce((sum, r) => (r.align === "center" ? sum + r.width : sum), 0);
    const centerGap = Math.max(0, bound - leftWidth - rightWidth);
    let leftCursor = 0;
    let centerCursor = leftWidth + centerGap / 2 - centerWidth / 2;
    let rightCursor = Math.max(0, bound - rightWidth);
    let x = 0;
    for (const run of runs) {
      x =
        single && !Number.isFinite(maxWidth)
          ? 0
          : single
            ? Math.max(0, bound - width) * (run.align === "center" ? 0.5 : run.align === "right" ? 1 : 0)
            : run.align === "left"
              ? leftCursor
              : run.align === "right"
                ? rightCursor
                : centerCursor;
      if (run.align === "left") leftCursor += run.width;
      else if (run.align === "right") rightCursor += run.width;
      else centerCursor += run.width;
      for (let i = run.start; i < run.end; i++) {
        const atom = line[i]!;
        if (atom.mark) {
          marks.push({
            ...(atom.characterIndex !== undefined ? { characterIndex: atom.characterIndex } : {}),
            x,
            y: top + ascent - atom.ascent,
            width: atom.advance - (atom.spacing ?? 0),
            height: atom.ascent - atom.descent,
            color: atom.mark,
          });
        }
        for (const q of atom.quads) quads.push({ ...q, x: x + q.x, y: top + ascent + q.y });
        x += atom.advance;
      }
    }
    lastLineAdvance = options.lineHeight ?? Math.max(0, ascent - descent + baseLineGap + explicitSpacing);
    top += lastLineAdvance;
  }
  const lastLine = lines.at(-1) ?? [];
  const descent = Math.min(baseDescent, ...lastLine.map((a) => a.descent));
  const ascent = Math.max(baseAscent, ...lastLine.map((a) => a.ascent));
  return {
    quads,
    ...(marks.length ? { marks } : {}),
    width: measuredWidth,
    height: Math.max(ascent - descent, top - lastLineAdvance + ascent - descent),
    text,
    missing: [...missing],
    lines: lines.length,
    baseline,
  };
}
