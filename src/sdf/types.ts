export type SdfColor = readonly [number, number, number, number];
export interface SdfGlyph {
  readonly index: number;
  readonly atlas: number;
  readonly rect: readonly [number, number, number, number];
  readonly metrics: readonly [number, number, number, number, number];
  readonly scale: number;
}
export interface SdfFont {
  readonly id: string;
  readonly size: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly padding: number;
  readonly scale: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly normalWeight: number;
  readonly boldWeight: number;
  readonly boldSpacing: number;
  readonly characters: Readonly<Record<string, readonly [number, number]>>;
  readonly glyphs: Readonly<Record<string, SdfGlyph>>;
  readonly atlases: readonly string[];
  readonly pairs?: Readonly<Record<string, readonly [number, number, number, number]>>;
}
export interface SdfMaterial {
  readonly floats: Readonly<Record<string, number>>;
  readonly colors: Readonly<Record<string, SdfColor>>;
}
export interface SdfGlyphQuad {
  readonly characterIndex?: number;
  readonly font: SdfFont;
  readonly glyph: SdfGlyph;
  readonly character: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly color: SdfColor;
  readonly italic: boolean;
  readonly bold: boolean;
}
export interface SdfTextLayout {
  readonly quads: readonly SdfGlyphQuad[];
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly missing: readonly string[];
  readonly lines: number;
  readonly baseline?: number;
}
export interface SdfTextLayoutOptions {
  readonly fonts: readonly SdfFont[];
  readonly fontSize: number;
  readonly maxWidth?: number;
  readonly lineSpacing?: number;
  readonly characterSpacing?: number;
  readonly wordSpacing?: number;
  readonly lineHeight?: number;
  readonly bold?: boolean;
  readonly color?: SdfColor;
  readonly align?: "left" | "center" | "right";
  readonly pixelScale?: number;
  readonly ruby?: {
    readonly scale?: number;
    readonly verticalOffset?: number;
    readonly alignment?: "center" | "base" | "annotation";
  };
  readonly parseColor?: (value: string) => SdfColor;
}
