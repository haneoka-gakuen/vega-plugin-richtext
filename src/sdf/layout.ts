import LineBreaker from "linebreak";
import { parseAdvRichText, type AdvRichTextNode } from "@haneoka/vega/plugin";
import type { SdfColor, SdfFont, SdfGlyph, SdfGlyphQuad, SdfTextLayout, SdfTextLayoutOptions } from "./types.js";

interface Style {
  size: number;
  color: SdfColor;
  bold: boolean;
  italic: boolean;
  offset: number;
  noBreak: boolean;
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
}
const length = (value: string, size: number, pixelScale: number): number => {
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return value.endsWith("em") ? number * size : value.endsWith("%") ? (number * size) / 100 : number * pixelScale;
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
  const lineGap = (primary.lineHeight - primary.ascent + primary.descent) * baseScale;
  // TMP lineSpacing values are authored per-font. -54 was tuned for ShinGoPr6N
  // (2.0 line-height ratio); Chinese/Korean fonts have tighter natural metrics
  // where the same offset collapses lines below the glyph height. Clamp so
  // lines never overlap regardless of which family is primary.
  const spacingFloor = baseSize * 0.9;
  const rawLineHeight = Math.max(1, baseAscent - baseDescent + lineGap + (options.lineSpacing ?? 0) * em);
  const effectiveLineHeight = Math.max(spacingFloor, rawLineHeight);
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
      atoms.push({
        text: char,
        advance: advance * scale + spacing + (space ? (options.wordSpacing ?? 0) * em : 0),
        spacing,
        ascent: ((font.ascent * state.size) / font.size) * font.scale,
        descent: ((font.descent * state.size) / font.size) * font.scale,
        quads,
        noBreak: state.noBreak,
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
        atoms.push({ text: "", advance, ascent: baseAscent, descent: baseDescent, quads: [], noBreak: true });
      } else if (node.type === "size") visit(node.children, { ...state, size: (baseSize * node.percent) / 100 });
      else if (node.type === "style") {
        const next = { ...state };
        if (node.style.fontWeight) next.bold = Number(node.style.fontWeight) >= 600 || node.style.fontWeight === "bold";
        if (node.style.fontStyle) next.italic = node.style.fontStyle === "italic";
        if (node.style.fontSize) {
          const value = node.style.fontSize;
          next.size = value.endsWith("%")
            ? (baseSize * parseFloat(value)) / 100
            : value.endsWith("em")
              ? baseSize * parseFloat(value)
              : length(value, baseSize, pixelScale);
        }
        if (node.style.top) next.offset += length(node.style.top, next.size, pixelScale);
        if (node.style.whiteSpace === "nowrap") next.noBreak = true;
        if (node.style.color && options.parseColor) next.color = options.parseColor(node.style.color);
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
        const advance = alignment === "center" ? Math.max(base.width, annotation.width) : base.width + leading;
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
            ...base.quads.map((q) => ({ ...q, x: q.x + leading, y: q.y - (base.baseline ?? ascent) + state.offset })),
            ...annotation.quads.map((q) => ({
              ...q,
              x: q.x + leading + (base.width - annotation.width) / 2,
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
  let top = 0,
    measuredWidth = 0,
    baseline = baseAscent;
  for (const line of lines) {
    const ascent = Math.max(baseAscent, ...line.map((a) => a.ascent));
    if (top === 0) baseline = ascent;
    const descent = Math.min(baseDescent, ...line.map((a) => a.descent));
    const width = widthOf(line) - (line.at(-1)?.spacing ?? 0);
    measuredWidth = Math.max(measuredWidth, width);
    const align = Number.isFinite(maxWidth)
      ? Math.max(0, maxWidth - width) * (options.align === "center" ? 0.5 : options.align === "right" ? 1 : 0)
      : 0;
    let x = align;
    for (const atom of line) {
      for (const q of atom.quads) quads.push({ ...q, x: x + q.x, y: top + ascent + q.y });
      x += atom.advance;
    }
    top += options.lineHeight ?? effectiveLineHeight;
  }
  const lastLine = lines.at(-1) ?? [];
  const descent = Math.min(baseDescent, ...lastLine.map((a) => a.descent));
  const ascent = Math.max(baseAscent, ...lastLine.map((a) => a.ascent));
  const lastAdvance = options.lineHeight ?? effectiveLineHeight;
  return {
    quads,
    width: measuredWidth,
    height: Math.max(ascent - descent, top - lastAdvance + ascent - descent),
    text,
    missing: [...missing],
    lines: lines.length,
    baseline,
  };
}
