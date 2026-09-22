import {
  assertTextReplacementMatches,
  createHostCapabilities,
  createTextContext,
  type HostCapabilities,
  type TextContext,
  type TextEditPort,
  type TextReplacement,
} from "@non-native-writing/application";

import {
  createActiveTextSurfaceCapture,
  type ActiveTextSurfaceCapture,
  type ActiveTextSurfacePort,
} from "./active-text-surface.js";

/** Deterministic external-host adapter for desktop boundary tests only. */
export class FakeActiveTextSurface implements ActiveTextSurfacePort {
  #context: TextContext;
  #capabilities: HostCapabilities;
  #generation = 0;
  #available = true;
  #rejectNextReplacement = false;

  captureCount = 0;
  replacementCount = 0;
  lastReplacement: TextReplacement | null = null;

  constructor(
    context: TextContext,
    capabilities: HostCapabilities,
  ) {
    this.#context = createTextContext(context);
    this.#capabilities = createHostCapabilities(capabilities);
  }

  get context(): TextContext {
    return this.#context;
  }

  get capabilities(): HostCapabilities {
    return this.#capabilities;
  }

  setContext(context: TextContext): void {
    this.#context = createTextContext(context);
    this.#generation += 1;
  }

  setCapabilities(capabilities: HostCapabilities): void {
    this.#capabilities = createHostCapabilities(capabilities);
    this.#generation += 1;
  }

  setAvailable(available: boolean): void {
    if (this.#available !== available) {
      this.#available = available;
      this.#generation += 1;
    }
  }

  invalidateSession(): void {
    this.#generation += 1;
  }

  failNextReplacement(): void {
    this.#rejectNextReplacement = true;
  }

  async capture(): Promise<ActiveTextSurfaceCapture | null> {
    this.captureCount += 1;
    if (!this.#available) {
      return null;
    }

    const capturedContext = this.#context;
    const capturedGeneration = this.#generation;
    let consumed = false;
    const editPort: TextEditPort | null = this.#capabilities.canReplaceText
      ? {
          replace: (replacement) => {
            if (
              consumed ||
              capturedGeneration !== this.#generation ||
              !this.#available ||
              this.#context.text !== capturedContext.text
            ) {
              throw new Error("Captured external text session is no longer current.");
            }
            assertTextReplacementMatches(this.#context.text, replacement);
            consumed = true;
            if (this.#rejectNextReplacement) {
              this.#rejectNextReplacement = false;
              throw new Error("External host rejected the guarded replacement.");
            }

            const nextText =
              this.#context.text.slice(0, replacement.range.start) +
              replacement.replacementText +
              this.#context.text.slice(replacement.range.end);
            const nextCaret =
              replacement.range.start + replacement.replacementText.length;
            this.#context = createTextContext({
              text: nextText,
              cursorOffset: nextCaret,
              selection: null,
              composition: null,
            });
            this.#generation += 1;
            this.replacementCount += 1;
            this.lastReplacement = Object.freeze({
              range: replacement.range,
              expectedText: replacement.expectedText,
              replacementText: replacement.replacementText,
            });
          },
        }
      : null;

    return createActiveTextSurfaceCapture({
      context: capturedContext,
      capabilities: this.#capabilities,
      editPort,
    });
  }
}
