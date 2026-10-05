export interface WebTextSelectionOptions {
  textSelector: string;
  enabled(): boolean;
  /** A delayed click belongs to the same command and seek lifetime. */
  revision(): unknown;
  signal: AbortSignal;
}

export interface WebTextSelectionGuard {
  /** Call from the advance surface's bubbling handler, after child controls. */
  requestAdvance(event: Event, advance: () => void): void;
  dispose(): void;
}

const CONTROL = "a, button, input, select, textarea, [contenteditable]:not([contenteditable=false]), [role=link]";

/** DOM selection owns its pointer gesture. Native canvas text has no delay or
 * selection interception; automatic advancement never passes through here. */
export function bindWebTextSelection(
  root: HTMLElement, options: WebTextSelectionOptions,
): WebTextSelectionGuard {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const events = new AbortController();
  const now = () => view?.performance.now() ?? Date.now();
  const web = options.enabled;
  const textElement = (node: Node | null) => {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    const text = element?.closest(options.textSelector);
    return text && root.contains(text) ? text : null;
  };
  const selectionInside = () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return false;
    if (textElement(selection.anchorNode) || textElement(selection.focusNode)) return true;
    // Select-all and ranges spanning the panel may have both endpoints outside
    // its text nodes. They still own the first click that clears that range.
    const texts = root.querySelectorAll(options.textSelector);
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if ([...texts].some((text) => range.intersectsNode(text))) return true;
    }
    return false;
  };
  let pointer: {
    id: number;
    x: number;
    y: number;
    at: number;
    revision: unknown;
    text: boolean;
    selected: boolean;
    moved: boolean;
    cancelled: boolean;
    released: boolean;
    held: boolean;
  } | undefined;
  let timer = 0;
  let disposed = false;
  const cancelPending = () => {
    if (timer) view?.clearTimeout(timer);
    timer = 0;
  };
  root.addEventListener("pointerdown", (event) => {
    if (!web() || event.button !== 0) {
      pointer = undefined;
      return;
    }
    pointer = {
      id: event.pointerId, x: event.clientX, y: event.clientY, at: now(), revision: options.revision(),
      text: !!textElement(event.target as Node), selected: selectionInside(),
      moved: false, cancelled: !!pointer && !pointer.released, released: false, held: false,
    };
  }, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("pointermove", (event) => {
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4)
      pointer.moved = true;
  }, { capture: true, passive: true, signal: events.signal });
  const release = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer.released = true;
    pointer.held = now() - pointer.at >= 400;
    pointer.cancelled ||= event.type === "pointercancel";
    pointer.selected ||= selectionInside();
  };
  document.addEventListener("pointerup", release, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("pointercancel", release, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("selectionchange", () => {
    if (!web() || !selectionInside()) return;
    if (pointer) pointer.selected = true;
    cancelPending();
  }, { signal: events.signal });
  root.addEventListener("contextmenu", (event) => {
    if (web() && textElement(event.target as Node)) {
      if (pointer) pointer.cancelled = true;
      cancelPending();
    }
  }, { capture: true, signal: events.signal });
  const dispose = () => {
    disposed = true;
    events.abort();
    cancelPending();
    pointer = undefined;
    options.signal.removeEventListener("abort", dispose);
  };
  if (options.signal.aborted) dispose();
  else options.signal.addEventListener("abort", dispose, { once: true });
  return {
    requestAdvance(event, advance) {
      if (disposed || !root.isConnected || event.type === "click" && event.defaultPrevented) return;
      if (!web()) {
        cancelPending();
        pointer = undefined;
        advance();
        return;
      }
      const target = event.target as Node | null;
      const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
      if (element?.closest(CONTROL)) return;
      const click = event.type === "click" ? event as MouseEvent : undefined;
      const gesture = click && click.detail !== 0 ? pointer : undefined;
      const selected = selectionInside();
      const blocked = selected || !!gesture && (gesture.selected || gesture.cancelled || options.revision() !== gesture.revision ||
        gesture.text && (gesture.moved || gesture.held));
      pointer = undefined;
      if (blocked || click && click.detail >= 2) {
        cancelPending();
        return;
      }
      cancelPending();
      if (click && click.detail !== 0 && textElement(target)) {
        // The second click selects a word after the first click event. Delay
        // only a DOM-text tap so its first click cannot consume the dialogue.
        const revision = options.revision();
        timer = view?.setTimeout(() => {
          timer = 0;
          if (!disposed && root.isConnected && web() && options.revision() === revision && !selectionInside()) advance();
        }, 300) ?? 0;
      } else advance();
    },
    dispose,
  };
}
