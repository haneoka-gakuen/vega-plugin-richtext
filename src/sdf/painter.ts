import type { SdfFont, SdfGlyphQuad, SdfMaterial, SdfTextLayout } from "./types.js";

export interface SdfAtlasPixels {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}
export class SdfTextPainter {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly textures = new Map<string, WebGLTexture>();
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
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
  upload(font: SdfFont, index: number, pixels: SdfAtlasPixels): void {
    if (this.disposed) return;
    const key = `${font.id}:${index}`;
    if (this.textures.has(key)) return;
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
    this.textures.set(key, texture);
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
    const gl = this.gl,
      W = Math.max(1, Math.ceil((width + padding * 2) * ratio)),
      H = Math.max(1, Math.ceil((height + padding * 2) * ratio));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const projection = new Float32Array([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1]);
    for (const name of ["hlslcc_mtx4x4glstate_matrix_projection[0]", "hlslcc_mtx4x4unity_MatrixVP[0]"])
      gl.uniform4fv(this.uniform(name), projection);
    gl.uniform4f(this.uniform("_ScreenParams"), W, H, 1 + 1 / W, 1 + 1 / H);
    for (const [name, value] of Object.entries(material.floats)) gl.uniform1f(this.uniform(name), value);
    for (const [name, value] of Object.entries(material.colors)) gl.uniform4fv(this.uniform(name), value);
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
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 15);
    }
    return this.canvas;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture);
    this.textures.clear();
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
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Unable to decode SDF atlas");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8Array(canvas.width * canvas.height);
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        alpha[(canvas.height - 1 - y) * canvas.width + x] = data[(y * canvas.width + x) * 4 + 3]!;
    const result = { width: canvas.width, height: canvas.height, alpha };
    canvas.width = 1;
    canvas.height = 1;
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
