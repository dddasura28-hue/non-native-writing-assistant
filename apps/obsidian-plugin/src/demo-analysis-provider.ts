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

export class DemoAnalysisProvider implements AnalysisProvider {
  #generationNumber = 0;

  async analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    if (signal.aborted) {
      throw new Error("Demo analysis was aborted.");
    }

    const generationNumber = ++this.#generationNumber;
    const idSuffix = `${snapshot.segmentId}-${snapshot.sourceRevision}-${generationNumber}`;
    const generationGroupId = asGenerationGroupId(
      `demo-generation-${idSuffix}`,
    );

    return Object.freeze({
      outputs: Object.freeze([
        Object.freeze({
          id: asTrackId(`demo-native-intent-${idSuffix}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: `[Demo native intent] ${snapshot.sourceText}`,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Demo native intent",
          order: 1,
        }),
        Object.freeze({
          id: asTrackId(`demo-normalized-${idSuffix}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: `[Demo normalized] ${snapshot.sourceText}`,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Demo normalized",
          order: 1,
        }),
      ]),
    });
  }
}
