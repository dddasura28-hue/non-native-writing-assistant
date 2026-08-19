import type {
  DependencyStamp,
  GenerationGroupId,
  TrackId,
  TrackTypeId,
} from "@non-native-writing/core";

import type { AnalysisSnapshot } from "./analysis-snapshot.js";

export interface ProposedDerivedTextTrack {
  readonly id: TrackId;
  readonly typeId: TrackTypeId;
  readonly text: string;
  readonly provenance: "model";
  readonly dependencyStamp: DependencyStamp;
  readonly generationGroupId?: GenerationGroupId;
  readonly label?: string;
  readonly order?: number;
}

export interface AnalysisProposal {
  readonly outputs: readonly ProposedDerivedTextTrack[];
}

export interface AnalysisProvider {
  analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal>;
}
