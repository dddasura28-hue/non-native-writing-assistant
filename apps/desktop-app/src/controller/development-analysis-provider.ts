import type {
  AnalysisProposal,
  AnalysisProvider,
  AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asGenerationGroupId,
  asTrackId,
} from "@non-native-writing/core";

export type DevelopmentAnalysisCompletion = (
  snapshot: AnalysisSnapshot,
  signal: AbortSignal,
) => Promise<void>;

export interface DevelopmentAnalysisProviderOptions {
  readonly complete?: DevelopmentAnalysisCompletion;
  readonly delayMs?: number;
}

/** Host-local deterministic provider used only by the desktop development UI. */
export class DevelopmentAnalysisProvider implements AnalysisProvider {
  readonly #complete: DevelopmentAnalysisCompletion;
  #generationNumber = 0;

  constructor(options: DevelopmentAnalysisProviderOptions = {}) {
    this.#complete =
      options.complete ?? createDelayedCompletion(options.delayMs ?? 80);
  }

  async analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    await this.#complete(snapshot, signal);
    if (signal.aborted) {
      throw new Error("Development analysis was aborted.");
    }

    const generationNumber = ++this.#generationNumber;
    const idSuffix = `${snapshot.segmentId}-${snapshot.sourceRevision}-${generationNumber}`;
    const generationGroupId = asGenerationGroupId(
      `desktop-development-generation-${idSuffix}`,
    );

    return Object.freeze({
      outputs: Object.freeze([
        Object.freeze({
          id: asTrackId(`desktop-development-native-${idSuffix}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: `The writer means: ${snapshot.sourceText}`,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Development native intent",
          order: 1,
        }),
        Object.freeze({
          id: asTrackId(`desktop-development-normalized-${idSuffix}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: `Suggested expression: ${snapshot.sourceText}`,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Development normalized",
          order: 1,
        }),
      ]),
    });
  }
}

function createDelayedCompletion(delayMs: number): DevelopmentAnalysisCompletion {
  return (_snapshot, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Development analysis was aborted."));
        return;
      }

      const timer = globalThis.setTimeout(() => {
        signal.removeEventListener("abort", handleAbort);
        resolve();
      }, delayMs);
      const handleAbort = (): void => {
        globalThis.clearTimeout(timer);
        reject(new Error("Development analysis was aborted."));
      };
      signal.addEventListener("abort", handleAbort, { once: true });
    });
}
