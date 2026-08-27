export const DEFAULT_ANALYSIS_DEBOUNCE_MS = 700;

export class DebouncedAnalysisScheduler<TValue> {
  readonly #run: (value: TValue) => void;
  readonly #delayMs: number;

  #timer: number | undefined;
  #disposed = false;

  constructor(
    run: (value: TValue) => void,
    delayMs = DEFAULT_ANALYSIS_DEBOUNCE_MS,
  ) {
    this.#run = run;
    this.#delayMs = delayMs;
  }

  schedule(value: TValue): void {
    if (this.#disposed) {
      return;
    }

    this.cancel();
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = undefined;
      this.#run(value);
    }, this.#delayMs);
  }

  scheduleImmediate(value: TValue): void {
    if (this.#disposed) {
      return;
    }

    this.cancel();
    this.#run(value);
  }

  cancel(): void {
    if (this.#timer === undefined) {
      return;
    }

    globalThis.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.cancel();
  }
}
