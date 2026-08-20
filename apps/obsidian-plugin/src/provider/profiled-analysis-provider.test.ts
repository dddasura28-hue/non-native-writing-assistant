import {
  AnalysisCoordinator,
  type AnalysisConfiguration,
  type AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  NORMALIZED_TRACK_TYPE_ID,
  WritingSegment,
  asSegmentId,
  asTrackId,
  createDependencyStamp,
} from "@non-native-writing/core";
import {
  MutableProviderSettings,
  ProviderRegistry,
  createProviderProfile,
  type ProviderProfile,
  type SecretResolver,
  type WritingModelAdapter,
  type WritingModelInvocation,
  type WritingModelRequest,
  type WritingModelResult,
} from "@non-native-writing/model-integration";
import { describe, expect, it } from "vitest";

import { ProfileAnalysisConfigurationSource } from "./analysis-configuration-source.js";
import { ProfiledAnalysisProvider } from "./profiled-analysis-provider.js";

const baseConfiguration: AnalysisConfiguration = {
  assistPolicyFingerprint: "assist:test",
  styleProfileFingerprint: "style:test",
  languageConfigurationFingerprint: "languages:zh-CN-en",
  processorConfigurationFingerprint: "writing-analysis:test",
  targetLanguageId: "en",
  nativeLanguageId: "zh-CN",
};
const commonResult: WritingModelResult = {
  nativeIntent: { text: "用户想写清楚。" },
  normalized: [{ text: "The user wants to write clearly.", label: null }],
};

class FakeSecretResolver implements SecretResolver {
  readonly requestedRefs: string[] = [];
  readonly #secrets: Readonly<Record<string, string>>;

  constructor(secrets: Readonly<Record<string, string>>) {
    this.#secrets = secrets;
  }

  async resolveSecret(secretRef: string): Promise<string | null> {
    this.requestedRefs.push(secretRef);
    return this.#secrets[secretRef] ?? null;
  }
}

class RecordingAdapter implements WritingModelAdapter {
  readonly providerId: string;
  readonly calls: WritingModelInvocation[] = [];
  readonly requests: WritingModelRequest[] = [];
  readonly #result: WritingModelResult;

  constructor(providerId: string, result: WritingModelResult = commonResult) {
    this.providerId = providerId;
    this.#result = result;
  }

  async analyze(
    request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult> {
    this.requests.push(request);
    this.calls.push(invocation);
    return this.#result;
  }
}

interface DeferredCall {
  readonly invocation: WritingModelInvocation;
  readonly resolve: (result: WritingModelResult) => void;
}

class DeferredAdapter implements WritingModelAdapter {
  readonly providerId: string;
  readonly calls: DeferredCall[] = [];

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  analyze(
    _request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult> {
    return new Promise((resolve) => {
      this.calls.push({ invocation, resolve });
    });
  }
}

function profile(
  id: string,
  providerId: string,
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return createProviderProfile({
    id,
    name: id,
    providerId,
    modelId: `${id}-model`,
    secretRef: `${id}-secret-ref`,
    enabled: true,
    ...overrides,
  });
}

function snapshot(): AnalysisSnapshot {
  return Object.freeze({
    segmentId: asSegmentId("profile-segment"),
    sourceTrackId: asTrackId("profile-source"),
    sourceText: "I want 写清楚",
    beforeContext: "Earlier paragraph.",
    afterContext: "Later paragraph.",
    sourceRevision: 1,
    dependencyStamp: createDependencyStamp({
      sourceRevision: 1,
      assistPolicyFingerprint: "assist:test",
      styleProfileFingerprint: "style:test",
      languageConfigurationFingerprint: "languages:zh-CN-en",
      processorConfigurationFingerprint: "writing-analysis:test",
      contextFingerprint: "context:profile-test",
    }),
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });
}

function segment(): WritingSegment {
  return WritingSegment.create({
    id: asSegmentId("profile-segment"),
    sourceTrackId: asTrackId("profile-source"),
    sourceText: "I want 写清楚",
  });
}

describe("ProfiledAnalysisProvider", () => {
  it("selects the adapter for the active profile", async () => {
    const active = profile("profile-b", "provider-b");
    const inactiveAdapter = new RecordingAdapter("provider-a");
    const activeAdapter = new RecordingAdapter("provider-b");
    const settings = new MutableProviderSettings({
      profiles: [profile("profile-a", "provider-a"), active],
      activeProfileId: active.id,
    });
    const secrets = new FakeSecretResolver({
      [active.secretRef]: "fake-provider-b-secret",
    });
    const provider = new ProfiledAnalysisProvider(
      settings,
      new ProviderRegistry([inactiveAdapter, activeAdapter]),
      secrets,
    );

    await provider.analyze(snapshot(), new AbortController().signal);

    expect(inactiveAdapter.calls).toHaveLength(0);
    expect(activeAdapter.calls).toHaveLength(1);
    expect(activeAdapter.requests[0]).toMatchObject({
      sourceText: "I want 写清楚",
      beforeContext: "Earlier paragraph.",
      afterContext: "Later paragraph.",
    });
    expect(secrets.requestedRefs).toEqual([active.secretRef]);
  });

  it("uses a newly active profile on the next request without rebuilding coordinator or segment", async () => {
    const first = profile("profile-a", "provider-a");
    const second = profile("profile-b", "provider-b");
    const firstAdapter = new RecordingAdapter("provider-a");
    const secondAdapter = new RecordingAdapter("provider-b");
    const settings = new MutableProviderSettings({
      profiles: [first, second],
      activeProfileId: first.id,
    });
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      settings,
    );
    const provider = new ProfiledAnalysisProvider(
      settings,
      new ProviderRegistry([firstAdapter, secondAdapter]),
      new FakeSecretResolver({
        [first.secretRef]: "fake-first-secret",
        [second.secretRef]: "fake-second-secret",
      }),
    );
    const coordinator = new AnalysisCoordinator(provider);
    const writingSegment = segment();

    await coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );
    settings.setActiveProfileId(second.id);
    await coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );

    expect(firstAdapter.calls).toHaveLength(1);
    expect(secondAdapter.calls).toHaveLength(1);
    expect(writingSegment.listDerivedTracks()).toHaveLength(4);
  });

  it("resolves fake secrets transiently and never stores them on profiles", async () => {
    const active = profile("profile-a", "provider-a");
    const adapter = new RecordingAdapter("provider-a");
    const fakeResolvedSecret = "fake-transient-secret-never-real";
    const provider = new ProfiledAnalysisProvider(
      new MutableProviderSettings({
        profiles: [active],
        activeProfileId: active.id,
      }),
      new ProviderRegistry([adapter]),
      new FakeSecretResolver({ [active.secretRef]: fakeResolvedSecret }),
    );

    await provider.analyze(snapshot(), new AbortController().signal);

    expect(adapter.calls[0]?.secret).toBe(fakeResolvedSecret);
    expect(active).not.toHaveProperty("secret");
    expect(active).not.toHaveProperty("apiKey");
    expect(JSON.stringify(active)).not.toContain(fakeResolvedSecret);
  });

  it("returns a safe missing-secret failure", async () => {
    const active = profile("profile-a", "provider-a");
    const provider = new ProfiledAnalysisProvider(
      new MutableProviderSettings({
        profiles: [active],
        activeProfileId: active.id,
      }),
      new ProviderRegistry([new RecordingAdapter("provider-a")]),
      new FakeSecretResolver({}),
    );

    await expect(
      provider.analyze(snapshot(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "missing-secret",
      message: "The active provider profile has no stored credential.",
    });
  });

  it("maps several normalized results to separate proposals with the request stamp", async () => {
    const active = profile("profile-a", "provider-a");
    const provider = new ProfiledAnalysisProvider(
      new MutableProviderSettings({
        profiles: [active],
        activeProfileId: active.id,
      }),
      new ProviderRegistry([
        new RecordingAdapter("provider-a", {
          nativeIntent: null,
          normalized: [
            { text: "First.", label: "Direct" },
            { text: "Second.", label: "Natural" },
          ],
        }),
      ]),
      new FakeSecretResolver({ [active.secretRef]: "fake-secret" }),
    );
    const analysisSnapshot = snapshot();

    const proposal = await provider.analyze(
      analysisSnapshot,
      new AbortController().signal,
    );
    const normalized = proposal.outputs.filter(
      (output) => output.typeId === NORMALIZED_TRACK_TYPE_ID,
    );

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.id).not.toBe(normalized[1]?.id);
    expect(normalized[0]?.generationGroupId).toBe(
      normalized[1]?.generationGroupId,
    );
    for (const output of normalized) {
      expect(output.dependencyStamp).toBe(analysisSnapshot.dependencyStamp);
    }
  });

  it("makes a pending result stale when the active model changes", async () => {
    const original = profile("profile-a", "provider-a");
    const adapter = new DeferredAdapter("provider-a");
    const settings = new MutableProviderSettings({
      profiles: [original],
      activeProfileId: original.id,
    });
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      settings,
    );
    const coordinator = new AnalysisCoordinator(
      new ProfiledAnalysisProvider(
        settings,
        new ProviderRegistry([adapter]),
        new FakeSecretResolver({ [original.secretRef]: "fake-secret" }),
      ),
    );
    const writingSegment = segment();
    configuration.onDidChange(() => {
      coordinator.updateConfiguration(
        writingSegment.id,
        configuration.getConfiguration(),
      );
    });

    const outcome = coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );
    await Promise.resolve();
    settings.replaceProfiles([
      profile("profile-a", "provider-a", { modelId: "new-model" }),
    ]);
    adapter.calls[0]?.resolve(commonResult);

    await expect(outcome).resolves.toEqual({ status: "stale" });
    expect(writingSegment.listDerivedTracks()).toHaveLength(0);
  });

  it("cannot apply provider A output after activeProfileId switches to provider B", async () => {
    const first = profile("profile-a", "provider-a");
    const second = profile("profile-b", "provider-b");
    const firstAdapter = new DeferredAdapter("provider-a");
    const settings = new MutableProviderSettings({
      profiles: [first, second],
      activeProfileId: first.id,
    });
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      settings,
    );
    const coordinator = new AnalysisCoordinator(
      new ProfiledAnalysisProvider(
        settings,
        new ProviderRegistry([
          firstAdapter,
          new RecordingAdapter("provider-b"),
        ]),
        new FakeSecretResolver({
          [first.secretRef]: "fake-first-secret",
          [second.secretRef]: "fake-second-secret",
        }),
      ),
    );
    const writingSegment = segment();
    configuration.onDidChange(() => {
      coordinator.updateConfiguration(
        writingSegment.id,
        configuration.getConfiguration(),
      );
    });

    const outcome = coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );
    await Promise.resolve();
    settings.setActiveProfileId(second.id);
    firstAdapter.calls[0]?.resolve(commonResult);

    await expect(outcome).resolves.toEqual({ status: "stale" });
    expect(writingSegment.listDerivedTracks()).toHaveLength(0);
  });
});
