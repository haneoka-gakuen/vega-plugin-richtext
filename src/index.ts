import {
  defineVegaPlugin,
  defineVegaService,
  parseAdvRichText,
  type AdvRichTextNode,
  type VegaPlugin,
} from "@haneoka/vega/plugin";

export interface VegaRichTextSource {
  readonly format: string;
  readonly source: string;
  readonly displayMode?: boolean;
  readonly language?: string;
}

export type VegaRichTextInput = string | VegaRichTextSource;

export interface VegaRichTextRenderRequest extends VegaRichTextSource {
  readonly document: Document;
  readonly signal: AbortSignal;
}

export type VegaRichTextRenderResult = Node | readonly Node[];

export interface VegaRichTextRenderer {
  readonly id: string;
  readonly formats: readonly string[];
  render(
    request: VegaRichTextRenderRequest,
  ):
    | VegaRichTextRenderResult
    | Promise<VegaRichTextRenderResult>;
}

export interface VegaRichTextRenderOptions {
  readonly defaultFormat?: string;
  readonly displayMode?: boolean;
  readonly language?: string;
  readonly onError?: (error: unknown) => void;
}

export interface VegaRichTextHandle {
  dispose(): void;
}

export interface VegaRichTextService {
  register(renderer: VegaRichTextRenderer): VegaRichTextHandle;
  supports(format: string): boolean;
  render(
    target: Element,
    input: VegaRichTextInput | unknown,
    options?: VegaRichTextRenderOptions,
  ): VegaRichTextHandle;
  dispose(): void;
}

export const VEGA_RICH_TEXT_SERVICE = defineVegaService<VegaRichTextService>(
  "vega.rich-text",
);

const FORMAT = /^[a-z][a-z0-9.+-]*$/u;

const normalizedFormat = (value: unknown): string => {
  const format = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!FORMAT.test(format)) {
    throw new TypeError(`Invalid Vega rich-text format: ${String(value)}`);
  }
  return format;
};

export const normalizeVegaRichTextSource = (
  input: VegaRichTextInput | unknown,
  options: VegaRichTextRenderOptions = {},
): VegaRichTextSource => {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const candidate = input as Partial<VegaRichTextSource>;
    if (typeof candidate.source === "string" && candidate.format) {
      return Object.freeze({
        format: normalizedFormat(candidate.format),
        source: candidate.source,
        ...(candidate.displayMode === undefined
          ? {}
          : { displayMode: Boolean(candidate.displayMode) }),
        ...(candidate.language === undefined
          ? {}
          : { language: String(candidate.language) }),
      });
    }
  }
  return Object.freeze({
    format: normalizedFormat(options.defaultFormat ?? "adv"),
    source: String(input ?? ""),
    ...(options.displayMode === undefined
      ? {}
      : { displayMode: options.displayMode }),
    ...(options.language === undefined
      ? {}
      : { language: options.language }),
  });
};

const renderAdvNodes = (
  document: Document,
  nodes: readonly AdvRichTextNode[],
): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === "text") {
      fragment.append(document.createTextNode(node.value));
      continue;
    }
    if (node.type === "break") {
      fragment.append(document.createElement("br"));
      continue;
    }
    if (node.type === "ruby") {
      const ruby = document.createElement("ruby");
      const base = document.createElement("rb");
      const annotation = document.createElement("rt");
      base.textContent = node.base;
      annotation.textContent = node.annotation;
      ruby.append(base, annotation);
      fragment.append(ruby);
      continue;
    }
    const size = document.createElement("span");
    size.className = "vega-rich-text__size";
    size.style.fontSize = `${node.percent}%`;
    size.append(renderAdvNodes(document, node.children));
    fragment.append(size);
  }
  return fragment;
};

export const vegaAdvRichTextRenderer: VegaRichTextRenderer = Object.freeze({
  id: "vega-adv",
  formats: ["adv"],
  render({ document, source }: VegaRichTextRenderRequest) {
    return renderAdvNodes(document, parseAdvRichText(source));
  },
});

export const vegaPlainTextRenderer: VegaRichTextRenderer = Object.freeze({
  id: "vega-plain",
  formats: ["plain", "text"],
  render({ document, source }: VegaRichTextRenderRequest) {
    return document.createTextNode(source);
  },
});

const isPromiseLike = (
  value: VegaRichTextRenderResult | Promise<VegaRichTextRenderResult>,
): value is Promise<VegaRichTextRenderResult> =>
  typeof (value as Promise<VegaRichTextRenderResult>)?.then === "function";

const resultNodes = (result: VegaRichTextRenderResult): readonly Node[] =>
  Array.isArray(result) ? result : [result as Node];

export class DefaultVegaRichTextService implements VegaRichTextService {
  private readonly renderers = new Map<string, VegaRichTextRenderer>();
  private readonly targets = new WeakMap<Element, AbortController>();
  private readonly activeControllers = new Set<AbortController>();
  private disposed = false;

  constructor() {
    this.register(vegaAdvRichTextRenderer);
    this.register(vegaPlainTextRenderer);
  }

  register(renderer: VegaRichTextRenderer): VegaRichTextHandle {
    if (this.disposed) throw new Error("Vega rich-text service is disposed");
    if (!renderer.formats.length) {
      throw new TypeError("A rich-text renderer must declare at least one format");
    }
    const formats = renderer.formats.map(normalizedFormat);
    for (const format of formats) {
      const existing = this.renderers.get(format);
      if (existing) {
        throw new Error(
          `Rich-text format "${format}" is already owned by ${existing.id}`,
        );
      }
    }
    for (const format of formats) this.renderers.set(format, renderer);
    let registered = true;
    return {
      dispose: () => {
        if (!registered) return;
        registered = false;
        for (const format of formats) {
          if (this.renderers.get(format) === renderer) {
            this.renderers.delete(format);
          }
        }
      },
    };
  }

  supports(format: string): boolean {
    return this.renderers.has(normalizedFormat(format));
  }

  render(
    target: Element,
    input: VegaRichTextInput | unknown,
    options: VegaRichTextRenderOptions = {},
  ): VegaRichTextHandle {
    if (this.disposed) throw new Error("Vega rich-text service is disposed");
    this.targets.get(target)?.abort();
    const controller = new AbortController();
    this.targets.set(target, controller);
    this.activeControllers.add(controller);
    const source = normalizeVegaRichTextSource(input, options);
    const renderer = this.renderers.get(source.format);
    target.setAttribute("data-vega-rich-text-format", source.format);
    target.removeAttribute("data-vega-rich-text-error");
    target.removeAttribute("data-vega-rich-text-error-message");
    if (source.language) target.setAttribute("lang", source.language);
    else target.removeAttribute("lang");
    target.replaceChildren(target.ownerDocument.createTextNode(source.source));

    const finish = (result: VegaRichTextRenderResult): void => {
      if (controller.signal.aborted || this.targets.get(target) !== controller) {
        return;
      }
      target.replaceChildren(...resultNodes(result));
    };
    const fail = (error: unknown): void => {
      if (controller.signal.aborted) return;
      target.setAttribute("data-vega-rich-text-error", "true");
      target.setAttribute(
        "data-vega-rich-text-error-message",
        error instanceof Error ? error.message : String(error),
      );
      options.onError?.(error);
    };

    if (renderer) {
      try {
        const result = renderer.render({
          ...source,
          document: target.ownerDocument,
          signal: controller.signal,
        });
        if (isPromiseLike(result)) void result.then(finish, fail);
        else finish(result);
      } catch (error) {
        fail(error);
      }
    }

    const dispose = (): void => {
      if (this.targets.get(target) === controller) this.targets.delete(target);
      controller.abort();
      this.activeControllers.delete(controller);
    };
    controller.signal.addEventListener(
      "abort",
      () => this.activeControllers.delete(controller),
      { once: true },
    );
    return { dispose };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    this.renderers.clear();
  }
}

export const createVegaRichTextPlugin = (): VegaPlugin =>
  defineVegaPlugin({
    manifest: {
      id: "haneoka.vega-richtext",
      name: "Vega Rich Text",
      version: "0.1.0",
      apiVersion: 1,
      description:
        "Format-neutral rich-text service with safe ADV and plain-text fallbacks",
      capabilities: ["rich-text"],
    },
    setup(context) {
      const service = new DefaultVegaRichTextService();
      context.provide(VEGA_RICH_TEXT_SERVICE, service);
      return { dispose: () => service.dispose() };
    },
  });

export const vegaRichTextPlugin = createVegaRichTextPlugin();

export default vegaRichTextPlugin;
