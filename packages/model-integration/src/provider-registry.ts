import type { WritingModelAdapter } from "./writing-model-adapter.js";
import { WritingModelError } from "./writing-model-error.js";

export class ProviderRegistry {
  readonly #adapters: ReadonlyMap<string, WritingModelAdapter>;

  constructor(adapters: readonly WritingModelAdapter[]) {
    const registered = new Map<string, WritingModelAdapter>();
    for (const adapter of adapters) {
      if (registered.has(adapter.providerId)) {
        throw new TypeError("Writing-model provider IDs must be unique.");
      }
      registered.set(adapter.providerId, adapter);
    }
    this.#adapters = registered;
  }

  resolve(providerId: string): WritingModelAdapter {
    const adapter = this.#adapters.get(providerId);
    if (adapter === undefined) {
      throw new WritingModelError(
        "unknown-provider",
        "The selected writing-model provider is not registered.",
      );
    }
    return adapter;
  }
}
