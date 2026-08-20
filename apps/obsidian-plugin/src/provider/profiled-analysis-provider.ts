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
import {
  ProviderRegistry,
  WritingModelError,
  resolveActiveProviderProfile,
  parseWritingModelResult,
  throwIfAnalysisAborted,
  type ProviderSettingsSource,
  type SecretResolver,
  type WritingModelRequest,
  type WritingModelResult,
} from "@non-native-writing/model-integration";

export class ProfiledAnalysisProvider implements AnalysisProvider {
  readonly #profiles: ProviderSettingsSource;
  readonly #registry: ProviderRegistry;
  readonly #secrets: SecretResolver;
  #generationNumber = 0;

  constructor(
    profiles: ProviderSettingsSource,
    registry: ProviderRegistry,
    secrets: SecretResolver,
  ) {
    this.#profiles = profiles;
    this.#registry = registry;
    this.#secrets = secrets;
  }

  async analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    throwIfAnalysisAborted(signal);
    const profile = resolveActiveProviderProfile(this.#profiles.getSettings());
    const adapter = this.#registry.resolve(profile.providerId);
    const secret = await this.#secrets.resolveSecret(profile.secretRef);
    throwIfAnalysisAborted(signal);
    if (secret === null || secret.length === 0) {
      throw new WritingModelError(
        "missing-secret",
        "The active provider profile has no stored credential.",
      );
    }

    const result = parseWritingModelResult(await adapter.analyze(requestFrom(snapshot), {
      profile,
      secret,
      signal,
    }));
    throwIfAnalysisAborted(signal);
    return this.#toProposal(snapshot, result);
  }

  #toProposal(
    snapshot: AnalysisSnapshot,
    result: WritingModelResult,
  ): AnalysisProposal {
    const generationNumber = ++this.#generationNumber;
    const idSuffix = `${snapshot.segmentId}-${snapshot.sourceRevision}-${generationNumber}`;
    const generationGroupId = asGenerationGroupId(
      `profile-generation-${idSuffix}`,
    );
    const outputs = [];

    if (result.nativeIntent !== null) {
      outputs.push(
        Object.freeze({
          id: asTrackId(`profile-native-intent-${idSuffix}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: result.nativeIntent.text,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Native intent",
          order: 1,
        }),
      );
    }

    for (const [index, normalized] of result.normalized.entries()) {
      outputs.push(
        Object.freeze({
          id: asTrackId(`profile-normalized-${idSuffix}-${index + 1}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: normalized.text,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          ...(normalized.label === null ? {} : { label: normalized.label }),
          order: index + 1,
        }),
      );
    }

    return Object.freeze({ outputs: Object.freeze(outputs) });
  }
}

function requestFrom(snapshot: AnalysisSnapshot): WritingModelRequest {
  return Object.freeze({
    sourceText: snapshot.sourceText,
    nativeLanguageId: snapshot.nativeLanguageId,
    targetLanguageId: snapshot.targetLanguageId,
    ...(snapshot.confirmedNativeIntent === undefined
      ? {}
      : {
          confirmedNativeIntent: Object.freeze({
            text: snapshot.confirmedNativeIntent.text,
          }),
        }),
  });
}
