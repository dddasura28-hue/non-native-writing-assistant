export interface TextareaTextAnchor {
  readonly left: number;
  readonly top: number;
  readonly lineHeight: number;
  readonly visible: boolean;
}

export interface TextareaInlinePosition {
  readonly left: number;
  readonly top: number;
  readonly placement: "above" | "below";
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface TextareaAnchorGeometryInput {
  readonly textareaRect: RectLike;
  readonly containerRect: RectLike;
  readonly markerRect: RectLike;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly lineHeight: number;
}

export interface TextareaMeasurementMirror {
  readonly element: HTMLDivElement;
  readonly marker: HTMLSpanElement;
  readonly lineHeight: number;
}

const MIRRORED_PROPERTIES = Object.freeze([
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "tab-size",
  "direction",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
] as const);

export function calculateTextareaTextAnchor(
  input: TextareaAnchorGeometryInput,
): TextareaTextAnchor {
  const viewportLeft = input.markerRect.left - input.scrollLeft;
  const viewportTop = input.markerRect.top - input.scrollTop;
  const lineBottom = viewportTop + input.lineHeight;
  const visible =
    viewportLeft >= input.textareaRect.left &&
    viewportLeft <= input.textareaRect.right &&
    lineBottom > input.textareaRect.top &&
    viewportTop < input.textareaRect.bottom;

  return Object.freeze({
    left: viewportLeft - input.containerRect.left,
    top: viewportTop - input.containerRect.top,
    lineHeight: input.lineHeight,
    visible,
  });
}

export function calculateTextareaInlinePosition(
  anchor: TextareaTextAnchor,
  containerSize: { readonly width: number; readonly height: number },
  overlaySize: { readonly width: number; readonly height: number },
  padding = 8,
  gap = 6,
): TextareaInlinePosition {
  const maximumLeft = Math.max(
    padding,
    containerSize.width - overlaySize.width - padding,
  );
  const left = clamp(anchor.left, padding, maximumLeft);
  const below = anchor.top + anchor.lineHeight + gap;
  const fitsBelow = below + overlaySize.height <= containerSize.height - padding;
  const top = fitsBelow
    ? below
    : clamp(
        anchor.top - overlaySize.height - gap,
        padding,
        containerSize.height - overlaySize.height - padding,
      );

  return Object.freeze({
    left,
    top,
    placement: fitsBelow ? "below" : "above",
  });
}

export function createTextareaMeasurementMirror(
  textarea: HTMLTextAreaElement,
  value: string,
  caretOffset: number,
): TextareaMeasurementMirror {
  if (
    !Number.isSafeInteger(caretOffset) ||
    caretOffset < 0 ||
    caretOffset > value.length
  ) {
    throw new RangeError("Textarea caret offset is outside the captured value.");
  }

  const document = textarea.ownerDocument;
  const computed = document.defaultView?.getComputedStyle(textarea);
  if (computed === undefined) {
    throw new Error("Textarea computed style is unavailable.");
  }

  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.dataset.textareaMeasurementMirror = "true";
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.userSelect = "none";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = computed.overflowWrap || "anywhere";
  mirror.style.wordBreak = computed.wordBreak;
  mirror.style.boxSizing = "border-box";
  mirror.style.margin = "0";

  for (const property of MIRRORED_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  const textareaRect = textarea.getBoundingClientRect();
  const horizontalBorder =
    parsePixels(computed.borderLeftWidth) +
    parsePixels(computed.borderRightWidth);
  const measuredWidth = textarea.clientWidth > 0
    ? textarea.clientWidth + horizontalBorder
    : textareaRect.width;
  mirror.style.left = `${textareaRect.left}px`;
  mirror.style.top = `${textareaRect.top}px`;
  mirror.style.width = `${measuredWidth}px`;

  mirror.append(document.createTextNode(value.slice(0, caretOffset)));
  const marker = document.createElement("span");
  marker.dataset.textareaCaretMarker = "true";
  marker.textContent = "\u200b";
  mirror.append(marker);
  mirror.append(document.createTextNode(value.slice(caretOffset)));

  return Object.freeze({
    element: mirror,
    marker,
    lineHeight: resolveLineHeight(computed),
  });
}

export function measureTextareaTextAnchor(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  caretOffset: number,
): TextareaTextAnchor | null {
  if (
    !textarea.isConnected ||
    !container.isConnected ||
    !Number.isSafeInteger(caretOffset) ||
    caretOffset < 0 ||
    caretOffset > textarea.value.length
  ) {
    return null;
  }

  const mirror = createTextareaMeasurementMirror(
    textarea,
    textarea.value,
    caretOffset,
  );
  textarea.ownerDocument.body.append(mirror.element);
  try {
    const markerRect = mirror.marker.getBoundingClientRect();
    const measuredLineHeight = markerRect.height > 0
      ? Math.max(markerRect.height, mirror.lineHeight)
      : mirror.lineHeight;
    return calculateTextareaTextAnchor({
      textareaRect: textarea.getBoundingClientRect(),
      containerRect: container.getBoundingClientRect(),
      markerRect,
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft,
      lineHeight: measuredLineHeight,
    });
  } finally {
    mirror.element.remove();
  }
}

function resolveLineHeight(computed: CSSStyleDeclaration): number {
  const lineHeight = parsePixels(computed.lineHeight);
  if (lineHeight > 0) {
    return lineHeight;
  }
  const fontSize = parsePixels(computed.fontSize);
  return fontSize > 0 ? fontSize * 1.2 : 19.2;
}

function parsePixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) {
    return minimum;
  }
  return Math.min(Math.max(value, minimum), maximum);
}
