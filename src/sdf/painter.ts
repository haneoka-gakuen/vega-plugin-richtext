import type { SdfFont, SdfGlyphQuad, SdfMaterial, SdfTextLayout } from "./types.js";

export interface SdfAtlasPixels {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}

const MAX_GPU_ATLAS_BYTES = 64 * 1024 * 1024;
const MAX_PAINT_PIXELS = 16 * 1024 * 1024;
const MAX_PAINT_DIMENSION = 8192;

interface TextureEntry {
  readonly texture: WebGLTexture;
  readonly bytes: number;
  lastUsed: number;
  pinned: boolean;
}

const paintDimensions = (
  width: number,
  height: number,
  ratio: number,
  padding: number,
): { width: number; height: number } | undefined => {
  const scaledWidth = Math.ceil((width + padding * 2) * ratio);
  const scaledHeight = Math.ceil((height + padding * 2) * ratio);
  if (
    !Number.isFinite(scaledWidth) ||
    !Number.isFinite(scaledHeight) ||
    scaledWidth < 1 ||
    scaledHeight < 1 ||
    scaledWidth > MAX_PAINT_DIMENSION ||
    scaledHeight > MAX_PAINT_DIMENSION ||
    scaledWidth * scaledHeight > MAX_PAINT_PIXELS
  )
    return undefined;
  return { width: scaledWidth, height: scaledHeight };
};

const MATERIAL_FLOAT_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
  _FaceDilate: 0,
  _OutlineSoftness: 0,
  _OutlineWidth: 0,
  _UnderlayOffsetX: 0,
  _UnderlayOffsetY: 0,
  _UnderlayDilate: 0,
  _UnderlaySoftness: 0,
  _GradientScale: 0,
  _TextureWidth: 1,
  _TextureHeight: 1,
  _WeightNormal: 0,
  _WeightBold: 0,
  _ScaleRatioA: 0,
  _ScaleRatioB: 0,
  _ScaleRatioC: 0,
  _VertexOffsetX: 0,
  _VertexOffsetY: 0,
  _MaskSoftnessX: 0,
  _MaskSoftnessY: 0,
  _ScaleX: 1,
  _ScaleY: 1,
  _PerspectiveFilter: 0,
  _Sharpness: 0,
});

const MATERIAL_COLOR_DEFAULTS: Readonly<Record<string, readonly [number, number, number, number]>> = Object.freeze({
  _FaceColor: [1, 1, 1, 1],
  _OutlineColor: [0, 0, 0, 0],
  _UnderlayColor: [0, 0, 0, 0],
  _ClipRect: [-32767, -32767, 32767, 32767],
});

const OUTLINE_FLOATS = new Set(["_OutlineSoftness", "_OutlineWidth"]);
const UNDERLAY_FLOATS = new Set([
  "_UnderlayOffsetX",
  "_UnderlayOffsetY",
  "_UnderlayDilate",
  "_UnderlaySoftness",
  "_ScaleRatioC",
]);

export class SdfTextPainter {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly textures = new Map<string, TextureEntry>();
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly pinnedKeys = new Set<string>();
  private useClock = 0;
  private textureBytes = 0;
  private disposed = false;
  get isOperational(): boolean {
    return !this.disposed && !this.gl.isContextLost();
  }

  constructor(document: Document, shaderSource: string) {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("SDF text requires a WebGL 2 context");
    this.gl = gl;
    const program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate SDF program");
    this.program = program;
    const shaders: WebGLShader[] = [];
    try {
      for (const [type, define] of [
        [gl.VERTEX_SHADER, "VERTEX"],
        [gl.FRAGMENT_SHADER, "FRAGMENT"],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Unable to allocate SDF shader");
        shaders.push(shader);
        let source = shaderSource
          .replaceAll("#version 300 es", "")
          .replaceAll("#define UNITY_SUPPORTS_UNIFORM_LOCATION 1", "#define UNITY_SUPPORTS_UNIFORM_LOCATION 0");
        if (define === "FRAGMENT") {
          source = source.replace(/texture\(_MainTex,/gu, "sampleSdf(_MainTex,");
          source = source.replaceAll(
            "void main()",
            "vec4 sampleSdf(sampler2D atlas, vec2 uv) { return vec4(1.0, 1.0, 1.0, texture(atlas, uv).r); }\nvoid main()",
          );
          source = `uniform highp float _HaneokaOutlineEnabled;\nuniform highp float _HaneokaUnderlayEnabled;\n${source}`;
          source = source.replace(
            "u_xlat0 = u_xlat16_1.xxxx * u_xlat16_0;",
            "u_xlat0 = u_xlat16_1.xxxx * u_xlat16_0 * _HaneokaUnderlayEnabled;",
          );
          source = source.replace(
            "u_xlat16_1 = u_xlat16_3.xxxx * u_xlat16_1 + vs_COLOR1;",
            "u_xlat16_1 = mix(vs_COLOR0, u_xlat16_3.xxxx * u_xlat16_1 + vs_COLOR1, _HaneokaOutlineEnabled);",
          );
        }
        gl.shaderSource(shader, `#version 300 es\n#define ${define}\n${source}`);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? "SDF shader compilation failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) ?? "SDF shader linking failed");
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
    const buffer = gl.createBuffer(),
      vao = gl.createVertexArray();
    if (!buffer || !vao) throw new Error("Unable to allocate SDF geometry");
    this.buffer = buffer;
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (const [name, size, offset] of [
      ["in_POSITION0", 4, 0],
      ["in_NORMAL0", 3, 4],
      ["in_COLOR0", 4, 7],
      ["in_TEXCOORD0", 4, 11],
    ] as const) {
      const index = gl.getAttribLocation(program, name);
      if (index < 0) continue;
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, 60, offset * 4);
    }
    gl.useProgram(program);
    gl.uniform1i(this.uniform("_MainTex"), 0);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const name of ["hlslcc_mtx4x4unity_ObjectToWorld[0]", "hlslcc_mtx4x4unity_WorldToObject[0]"])
      gl.uniform4fv(this.uniform(name), identity);
    gl.uniform3f(this.uniform("_WorldSpaceCameraPos"), 0, 0, -1000);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name) ?? null;
  }

  private removeTexture(key: string, entry: TextureEntry): void {
    this.gl.deleteTexture(entry.texture);
    this.textures.delete(key);
    this.textureBytes -= entry.bytes;
  }

  private evictFor(bytes: number): boolean {
    if (bytes > MAX_GPU_ATLAS_BYTES) return false;
    while (this.textureBytes + bytes > MAX_GPU_ATLAS_BYTES) {
      const candidate = [...this.textures.entries()]
        .filter(([, entry]) => !entry.pinned)
        .filter(([key]) => !this.pinnedKeys.has(key))
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
      if (!candidate) return false;
      this.removeTexture(candidate[0], candidate[1]);
    }
    return true;
  }

  /**
   * Protects and fits one complete paint set before uploading any texture.
   * This prevents an early required atlas from being evicted while a later
   * required atlas is uploaded.
   */
  prepareAtlases(keys: readonly string[], pixels: ReadonlyMap<string, SdfAtlasPixels>): boolean {
    const required = new Set(keys);
    let additionalBytes = 0;
    for (const key of required) {
      if (this.textures.has(key)) continue;
      const value = pixels.get(key);
      if (!value) return false;
      additionalBytes += value.alpha.byteLength;
    }
    const newlyPinned: string[] = [];
    for (const key of required) {
      if (!this.pinnedKeys.has(key)) newlyPinned.push(key);
      this.pinnedKeys.add(key);
      const entry = this.textures.get(key);
      if (entry) entry.pinned = true;
    }
    if (!this.evictFor(additionalBytes)) {
      for (const key of newlyPinned) {
        this.pinnedKeys.delete(key);
        const entry = this.textures.get(key);
        if (entry) entry.pinned = false;
      }
      return false;
    }
    for (const key of required) {
      const entry = this.textures.get(key);
      if (entry) {
        entry.pinned = true;
        entry.lastUsed = ++this.useClock;
      }
    }
    return true;
  }

  canPaint(width: number, height: number, ratio: number, padding: number): boolean {
    return paintDimensions(width, height, ratio, padding) !== undefined;
  }

  upload(font: SdfFont, index: number, pixels: SdfAtlasPixels): void {
    if (this.disposed) return;
    const key = `${font.id}:${index}`;
    const existing = this.textures.get(key);
    if (existing) {
      existing.lastUsed = ++this.useClock;
      return;
    }
    if (!this.evictFor(pixels.alpha.byteLength)) throw new Error("SDF atlas GPU residency is full");
    const gl = this.gl,
      texture = gl.createTexture();
    if (!texture) throw new Error("Unable to allocate SDF atlas");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pixels.width, pixels.height, 0, gl.RED, gl.UNSIGNED_BYTE, pixels.alpha);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(key, {
      texture,
      bytes: pixels.alpha.byteLength,
      lastUsed: ++this.useClock,
      pinned: this.pinnedKeys.has(key),
    });
    this.textureBytes += pixels.alpha.byteLength;
  }
  pin(keys: readonly string[]): void {
    for (const key of keys) {
      this.pinnedKeys.add(key);
      const entry = this.textures.get(key);
      if (entry) {
        entry.pinned = true;
        entry.lastUsed = ++this.useClock;
      }
    }
  }
  unpin(keys: readonly string[]): void {
    for (const key of keys) {
      this.pinnedKeys.delete(key);
      const entry = this.textures.get(key);
      if (entry) entry.pinned = false;
    }
  }
  paint(
    layout: SdfTextLayout,
    material: SdfMaterial,
    width: number,
    height: number,
    ratio = 1,
    padding = 4,
  ): HTMLCanvasElement {
    if (!this.isOperational) throw new Error("SDF painter is unavailable");
    const dimensions = paintDimensions(width, height, ratio, padding);
    if (!dimensions) throw new Error("SDF paint exceeds the bounded canvas budget");
    const gl = this.gl,
      W = dimensions.width,
      H = dimensions.height;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const projection = new Float32Array([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1]);
    for (const name of ["hlslcc_mtx4x4glstate_matrix_projection[0]", "hlslcc_mtx4x4unity_MatrixVP[0]"])
      gl.uniform4fv(this.uniform(name), projection);
    gl.uniform4f(this.uniform("_ScreenParams"), W, H, 1 + 1 / W, 1 + 1 / H);
    for (const [name, value] of Object.entries(MATERIAL_FLOAT_DEFAULTS)) gl.uniform1f(this.uniform(name), value);
    const outlineEnabled = material.keywords?.includes("OUTLINE_ON") ?? false;
    const underlayEnabled = material.keywords?.includes("UNDERLAY_ON") ?? false;
    for (const [name, value] of Object.entries(material.floats)) {
      const effective =
        (!outlineEnabled && OUTLINE_FLOATS.has(name)) || (!underlayEnabled && UNDERLAY_FLOATS.has(name)) ? 0 : value;
      gl.uniform1f(this.uniform(name), effective);
    }
    for (const [name, value] of Object.entries(MATERIAL_COLOR_DEFAULTS)) gl.uniform4fv(this.uniform(name), value);
    for (const [name, value] of Object.entries(material.colors)) gl.uniform4fv(this.uniform(name), value);
    if (!outlineEnabled) gl.uniform4fv(this.uniform("_OutlineColor"), [0, 0, 0, 0]);
    if (!underlayEnabled) gl.uniform4fv(this.uniform("_UnderlayColor"), [0, 0, 0, 0]);
    gl.uniform1f(this.uniform("_HaneokaOutlineEnabled"), outlineEnabled ? 1 : 0);
    gl.uniform1f(this.uniform("_HaneokaUnderlayEnabled"), underlayEnabled ? 1 : 0);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const batches = new Map<string, SdfGlyphQuad[]>();
    for (const quad of layout.quads) {
      const key = `${quad.font.id}:${quad.glyph.atlas}`;
      const batch = batches.get(key) ?? [];
      batch.push(quad);
      batches.set(key, batch);
    }
    for (const [key, quads] of batches) {
      const texture = this.textures.get(key);
      if (!texture) throw new Error(`SDF atlas is not ready: ${key}`);
      texture.lastUsed = ++this.useClock;
      const font = quads[0]!.font;
      gl.uniform1f(this.uniform("_TextureWidth"), font.atlasWidth);
      gl.uniform1f(this.uniform("_TextureHeight"), font.atlasHeight);
      gl.uniform1f(this.uniform("_GradientScale"), font.padding + 1);
      gl.uniform1f(this.uniform("_WeightNormal"), font.normalWeight);
      gl.uniform1f(this.uniform("_WeightBold"), font.boldWeight);
      const vertices = new Float32Array(quads.length * 90);
      let cursor = 0;
      for (const q of quads) {
        const [x, y, w, h] = q.glyph.rect,
          p = font.padding;
        const u0 = (x - p) / font.atlasWidth,
          u1 = (x + w + p) / font.atlasWidth,
          v0 = (y - p) / font.atlasHeight,
          v1 = (y + h + p) / font.atlasHeight;
        const left = (q.x + padding) * ratio,
          right = left + q.width * ratio,
          top = H - (q.y + padding) * ratio,
          bottom = top - q.height * ratio;
        const italic = q.italic ? q.height * ratio * 0.15 : 0;
        for (const [px, py, u, v] of [
          [left - italic, bottom, u0, v0],
          [right - italic, bottom, u1, v0],
          [right + italic, top, u1, v1],
          [left - italic, bottom, u0, v0],
          [right + italic, top, u1, v1],
          [left + italic, top, u0, v1],
        ]) {
          vertices.set([px!, py!, 0, 1, 0, 0, -1, ...q.color, u!, v!, 0, q.scale * ratio * (q.bold ? -1 : 1)], cursor);
          cursor += 15;
        }
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 15);
    }
    return this.canvas;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture.texture);
    this.textures.clear();
    this.pinnedKeys.clear();
    this.useClock = 0;
    this.textureBytes = 0;
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

export async function decodeSdfAtlas(
  document: Document,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<SdfAtlasPixels> {
  if (signal?.aborted) throw signal.reason;
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "image/png" }));
  try {
    const image = document.createElement("img");
    image.src = url;
    await image.decode();
    if (signal?.aborted) throw signal.reason;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("SDF atlas has no pixels");
    const canvas = document.createElement("canvas");
    const rowsPerTile = Math.min(128, height);
    canvas.width = width;
    canvas.height = rowsPerTile;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Unable to decode SDF atlas");
    const alpha = new Uint8Array(width * height);
    for (let sourceY = 0; sourceY < height; sourceY += rowsPerTile) {
      if (signal?.aborted) throw signal.reason;
      const rows = Math.min(rowsPerTile, height - sourceY);
      context.clearRect(0, 0, width, rowsPerTile);
      context.drawImage(image, 0, sourceY, width, rows, 0, 0, width, rows);
      const data = context.getImageData(0, 0, width, rows).data;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < width; x++) alpha[(height - 1 - sourceY - y) * width + x] = data[(y * width + x) * 4 + 3]!;
    }
    const result = { width, height, alpha };
    canvas.width = 1;
    canvas.height = 1;
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
