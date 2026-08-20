import { AnalysisCoordinator } from "@non-native-writing/application";
import type {
  AnalysisConfiguration,
  AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  WritingSegment,
  asSegmentId,
  asTrackId,
  createDependencyStamp,
} from "@non-native-writing/core";
import {
  ProviderRegistry,
  type ProviderProfile,
  type SecretResolver,
  type WritingModelAdapter,
  type WritingModelInvocation,
  type WritingModelRequest,
  type WritingModelResult,
} from "@non-native-writing/model-integration";
import { describe, expect, it, vi } from "vitest";

import { ProfileAnalysisConfigurationSource } from "../provider/analysis-configuration-source.js";
import { ProfiledAnalysisProvider } from "../provider/profiled-analysis-provider.js";
import {
  createPluginSettings,
  type ObsidianPluginSettings,
  type StoredProviderProfile,
} from "./plugin-settings.js";
import { ProviderProfileStore } from "./provider-profile-store.js";

const baseConfiguration: AnalysisConfiguration = {
  assistPolicyFingerprint: "assist:test",
  styleProfileFingerprint: "style:test",
  languageConfigurationFingerprint: "languages:test",
  processorConfigurationFingerprint: "analysis:test",
  targetLanguageId: "en",
  nativeLanguageId: "zh-CN",
};
const result: WritingModelResult = {
  nativeIntent: null,
  normalized: [{ text: "Normalized.", label: null }],
};

class RecordingAdapter implements WritingModelAdapter {
  readonly providerId: string;
  readonly calls: WritingModelInvocation[] = [];

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async analyze(
    _request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult> {
    this.calls.push(invocation);
    return result;
  }
}

interface DeferredCall {
  readonly resolve: (value: WritingModelResult) => void;
}

class DeferredAdapter implements WritingModelAdapter {
  readonly providerId = "openai";
  readonly calls: DeferredCall[] = [];

  analyze(): Promise<WritingModelResult> {
    return new Promise((resolve) => {
      this.calls.push({ resolve });
    });
  }
}

class FakeSecretResolver implements SecretResolver {
  readonly refs: string[] = [];

  async resolveSecret(secretRef: string): Promise<string | null> {
    this.refs.push(secretRef);
    return "fake-resolved-secret-never-real";
  }
}

function profile(
  id: string,
  providerId = "openai",
  overrides: Partial<StoredProviderProfile> = {},
): StoredProviderProfile {
  return {
    id,
    name: id,
    providerId,
    modelId: `${id}-model`,
    secretRef: `${id}-secret-ref`,
    enabled: true,
    ...overrides,
  };
}

function settings(
  profiles: readonly StoredProviderProfile[],
  activeProfileId: string | null = null,
): ObsidianPluginSettings {
  return createPluginSettings(activeProfileId, profiles);
}

function store(
  initial: ObsidianPluginSettings,
  saved: ObsidianPluginSettings[] = [],
  idFactory?: () => string,
): ProviderProfileStore {
  return new ProviderProfileStore(
    initial,
    async (next) => {
      saved.push(next);
    },
    idFactory,
  );
}

function segment(): WritingSegment {
  return WritingSegment.create({
    id: asSegmentId("settings-segment"),
    sourceTrackId: asTrackId("settings-source"),
    sourceText: "Mixed source 文本",
  });
}

function snapshot(): AnalysisSnapshot {
  return Object.freeze({
    segmentId: asSegmentId("settings-segment"),
    sourceTrackId: asTrackId("settings-source"),
    sourceText: "Mixed source 文本",
    beforeContext: "Earlier paragraph.",
    afterContext: "Later paragraph.",
    sourceRevision: 1,
    dependencyStamp: createDependencyStamp({
      sourceRevision: 1,
      assistPolicyFingerprint: "assist:test",
      styleProfileFingerprint: "style:test",
      languageConfigurationFingerprint: "languages:test",
      processorConfigurationFingerprint: "analysis:test",
      contextFingerprint: "context:settings-test",
    }),
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });
}

describe("ProviderProfileStore", () => {
  it("creates a profile with stable host identity and definition metadata", async () => {
    const saved: ObsidianPluginSettings[] = [];
    const profiles = store(settings([]), saved, () => "stable-profile-id");

    await expect(profiles.addProfile("anthropic")).resolves.toBe(
      "stable-profile-id",
    );
    expect(profiles.getStoredSettings().providerSettings.profiles[0]).toEqual({
      id: "stable-profile-id",
      name: "Anthropic",
      providerId: "anthropic",
      modelId: "",
      secretRef: "",
      enabled: true,
    });
    expect(saved).toHaveLength(1);
  });

  it("switches the next request without recreating its coordinator or segment", async () => {
    const first = profile("first", "openai");
    const second = profile("second", "anthropic");
    const profiles = store(settings([first, second], first.id));
    const openAI = new RecordingAdapter("openai");
    const anthropic = new RecordingAdapter("anthropic");
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      profiles,
    );
    const coordinator = new AnalysisCoordinator(
      new ProfiledAnalysisProvider(
        profiles,
        new ProviderRegistry([openAI, anthropic]),
        new FakeSecretResolver(),
      ),
    );
    const writingSegment = segment();
    const originalSegment = writingSegment;

    await coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );
    await profiles.setActiveProfileId(second.id);
    await coordinator.analyze(
      writingSegment,
      configuration.getConfiguration(),
    );

    expect(writingSegment).toBe(originalSegment);
    expect(openAI.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(1);
  });

  it("invalidates configuration when modelId changes", async () => {
    const active = profile("active");
    const profiles = store(settings([active], active.id));
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      profiles,
    );
    const before = configuration.getConfiguration().processorConfigurationFingerprint;
    const changed = vi.fn();
    configuration.onDidChange(changed);

    await profiles.updateProfile(active.id, { modelId: "new-model" });

    expect(changed).toHaveBeenCalledOnce();
    expect(
      configuration.getConfiguration().processorConfigurationFingerprint,
    ).not.toBe(before);
  });

  it("invalidates configuration when providerId changes", async () => {
    const active = profile("active");
    const profiles = store(settings([active], active.id));
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      profiles,
    );
    const before = configuration.getConfiguration().processorConfigurationFingerprint;

    await profiles.updateProfile(active.id, { providerId: "anthropic" });

    expect(
      configuration.getConfiguration().processorConfigurationFingerprint,
    ).not.toBe(before);
  });

  it("invalidates for secretRef without persisting or fingerprinting a resolved secret", async () => {
    const fakeResolvedSecret = "fake-resolved-secret-never-persist";
    const active = profile("active");
    const saved: ObsidianPluginSettings[] = [];
    const profiles = store(settings([active], active.id), saved);
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      profiles,
    );
    const before = configuration.getConfiguration().processorConfigurationFingerprint;

    await profiles.updateProfile(active.id, { secretRef: "replacement-ref" });
    const after = configuration.getConfiguration().processorConfigurationFingerprint;

    expect(after).not.toBe(before);
    expect(after).toContain("replacement-ref");
    expect(JSON.stringify(saved)).not.toContain(fakeResolvedSecret);
  });

  it("chooses the first valid enabled fallback when deleting the active profile", async () => {
    const disabled = profile("disabled", "openai", { enabled: false });
    const active = profile("active");
    const fallback = profile("fallback", "gemini");
    const profiles = store(settings([disabled, active, fallback], active.id));

    await profiles.deleteProfile(active.id);

    expect(profiles.getStoredSettings().providerSettings.activeProfileId).toBe(
      fallback.id,
    );
    expect(profiles.getSelectionState().activeProfileId).toBe(fallback.id);
  });

  it("does not attempt provider or secret work for an incomplete active profile", async () => {
    const incomplete = profile("incomplete", "openai", { modelId: "" });
    const profiles = store(settings([incomplete], incomplete.id));
    const adapter = new RecordingAdapter("openai");
    const secrets = new FakeSecretResolver();
    const provider = new ProfiledAnalysisProvider(
      profiles,
      new ProviderRegistry([adapter]),
      secrets,
    );

    await expect(
      provider.analyze(snapshot(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid-profile",
      message: "Configure an AI provider in settings.",
    });
    expect(adapter.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0);
  });

  it("retains an unknown provider for editing but excludes it from analysis", () => {
    const unknown = profile("unknown", "future-provider");
    const profiles = store(settings([unknown], unknown.id));

    expect(profiles.getStoredSettings().providerSettings.profiles).toEqual([
      unknown,
    ]);
    expect(profiles.getSettings().profiles).toEqual([]);
    expect(profiles.validateProfile(unknown.id)).toMatchObject({ valid: false });
  });

  it("rejects an invalid custom base URL before transport", async () => {
    const custom = profile("custom", "openai-compatible", {
      baseUrl: "https://user:password@example.test/v1",
      compatibilityMode: "json-schema",
    });
    const profiles = store(settings([custom], custom.id));
    const adapter = new RecordingAdapter("openai-compatible");

    await expect(
      new ProfiledAnalysisProvider(
        profiles,
        new ProviderRegistry([adapter]),
        new FakeSecretResolver(),
      ).analyze(snapshot(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-profile" });
    expect(adapter.calls).toHaveLength(0);
  });

  it("allows multiple profiles to reference the same secret", () => {
    const shared = "shared-secret-reference";
    const profiles = store(
      settings([
        profile("one", "openai", { secretRef: shared }),
        profile("two", "anthropic", { secretRef: shared }),
      ]),
    );

    expect(
      profiles
        .getStoredSettings()
        .providerSettings.profiles.map((candidate) => candidate.secretRef),
    ).toEqual([shared, shared]);
  });

  it("deletes only profile configuration and never a SecretStorage entry", async () => {
    const active = profile("active");
    const secretStorage = { deleteSecret: vi.fn() };
    const profiles = store(settings([active], active.id));

    await profiles.deleteProfile(active.id);

    expect(secretStorage.deleteSecret).not.toHaveBeenCalled();
    expect(profiles.getStoredSettings().providerSettings.profiles).toEqual([]);
  });

  it("lets settings and side-view consumers observe the same active source", async () => {
    const first = profile("first");
    const second = profile("second", "anthropic");
    const profiles = store(settings([first, second], first.id));
    const settingsConsumer: Array<string | null> = [];
    const sideViewConsumer: Array<string | null> = [];
    profiles.onDidUpdate(() => {
      settingsConsumer.push(profiles.getSelectionState().activeProfileId);
    });
    profiles.onDidUpdate(() => {
      sideViewConsumer.push(profiles.getSelectionState().activeProfileId);
    });

    await profiles.setActiveProfileId(second.id, "settings-page");
    await profiles.setActiveProfileId(first.id, "side-view");

    expect(settingsConsumer).toEqual([second.id, first.id]);
    expect(sideViewConsumer).toEqual(settingsConsumer);
  });

  it("makes a pending result stale when an active profile is edited", async () => {
    const active = profile("active");
    const profiles = store(settings([active], active.id));
    const adapter = new DeferredAdapter();
    const configuration = new ProfileAnalysisConfigurationSource(
      baseConfiguration,
      profiles,
    );
    const coordinator = new AnalysisCoordinator(
      new ProfiledAnalysisProvider(
        profiles,
        new ProviderRegistry([adapter]),
        new FakeSecretResolver(),
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
    await profiles.updateProfile(active.id, { modelId: "edited-model" });
    adapter.calls[0]?.resolve(result);

    await expect(outcome).resolves.toEqual({ status: "stale" });
    expect(writingSegment.listDerivedTracks()).toEqual([]);
  });

  it("serializes only the allowed profile fields", async () => {
    const saved: ObsidianPluginSettings[] = [];
    const profiles = store(settings([profile("active")], "active"), saved);

    await profiles.updateProfile("active", { name: "Renamed" });

    const serialized = JSON.stringify(saved.at(-1));
    expect(serialized).not.toMatch(/apiKey|api_key|rawSecret|resolvedSecret/);
    expect(Object.keys(saved.at(-1)?.providerSettings.profiles[0] ?? {})).toEqual([
      "id",
      "name",
      "providerId",
      "modelId",
      "secretRef",
      "enabled",
    ]);
  });
});
