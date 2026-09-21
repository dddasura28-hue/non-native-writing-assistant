import type { AnalysisSnapshot } from "@non-native-writing/application";
import {
  asSegmentId,
  asTrackId,
  createDependencyStamp,
} from "@non-native-writing/core";
import {
  MutableProviderSettings,
  createBuiltInProviderRegistry,
  createProviderProfile,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ProviderProfile,
  type SecretResolver,
} from "@non-native-writing/model-integration";
import { describe, expect, it } from "vitest";

import { DESKTOP_ANALYSIS_CONFIGURATION } from "../controller/desktop-engine-controller.js";
import { DesktopProfileAnalysisConfigurationSource } from "./desktop-analysis-configuration-source.js";
import { DesktopProfiledAnalysisProvider } from "./desktop-profiled-analysis-provider.js";

const MODEL_RESULT = {
  nativeIntent: { text: "用户想写清楚。" },
  normalized: [{ text: "The user wants to write clearly.", label: null }],
};

class RecordingTransport implements HttpTransport {
  readonly requests: HttpTransportRequest[] = [];

  async send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    this.requests.push(request);
    const content = JSON.stringify(MODEL_RESULT);
    const body = request.url.includes("anthropic.com")
      ? { content: [{ type: "text", text: content }] }
      : request.url.includes("googleapis.com")
        ? { candidates: [{ content: { parts: [{ text: content }] } }] }
        : request.url.endsWith("/responses")
          ? { output: [{ content: [{ type: "output_text", text: content }] }] }
          : { choices: [{ message: { content } }] };
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  }
}

class RecordingSecrets implements SecretResolver {
  readonly refs: string[] = [];
  value: string | null = "resolved-runtime-secret";

  async resolveSecret(secretRef: string): Promise<string | null> {
    this.refs.push(secretRef);
    return this.value;
  }
}

function profile(
  providerId: string,
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return createProviderProfile({
    id: `${providerId}-profile`,
    name: providerId,
    providerId,
    modelId: "open-model-id",
    secretRef: `${providerId}-credential`,
    enabled: true,
    ...(providerId === "openai-compatible"
      ? { baseUrl: "https://api.deepseek.com/v1", compatibilityMode: "json-object" }
      : {}),
    ...overrides,
  });
}

function snapshot(): AnalysisSnapshot {
  return Object.freeze({
    segmentId: asSegmentId("desktop-profile-segment"),
    sourceTrackId: asTrackId("desktop-profile-source"),
    sourceText: "I want 写清楚",
    beforeContext: "Earlier.",
    afterContext: "Later.",
    sourceRevision: 1,
    dependencyStamp: createDependencyStamp({
      sourceRevision: 1,
      assistPolicyFingerprint: "assist",
      styleProfileFingerprint: "style",
      languageConfigurationFingerprint: "language",
      processorConfigurationFingerprint: "processor",
      contextFingerprint: "context",
    }),
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });
}

describe("DesktopProfiledAnalysisProvider", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/responses", "Authorization"],
    ["anthropic", "https://api.anthropic.com/v1/messages", "x-api-key"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models/open-model-id:generateContent", "x-goog-api-key"],
    ["openai-compatible", "https://api.deepseek.com/v1/chat/completions", "Authorization"],
  ])("selects the %s adapter", async (providerId, expectedUrl, secretHeader) => {
    const active = profile(providerId);
    const settings = new MutableProviderSettings({
      profiles: [active],
      activeProfileId: active.id,
    });
    const transport = new RecordingTransport();
    const secrets = new RecordingSecrets();
    const provider = new DesktopProfiledAnalysisProvider(
      settings,
      createBuiltInProviderRegistry(transport),
      secrets,
    );

    const proposal = await provider.analyze(snapshot(), new AbortController().signal);

    expect(transport.requests[0]?.url).toBe(expectedUrl);
    expect(transport.requests[0]?.headers[secretHeader]).toContain("resolved-runtime-secret");
    expect(secrets.refs).toEqual([active.secretRef]);
    expect(proposal.outputs.map((output) => output.text)).toEqual([
      "用户想写清楚。",
      "The user wants to write clearly.",
    ]);
  });

  it("resolves the secretRef for every request and never embeds the secret in a fingerprint", async () => {
    const active = profile("openai");
    const settings = new MutableProviderSettings({ profiles: [active], activeProfileId: active.id });
    const secrets = new RecordingSecrets();
    const provider = new DesktopProfiledAnalysisProvider(
      settings,
      createBuiltInProviderRegistry(new RecordingTransport()),
      secrets,
    );
    await provider.analyze(snapshot(), new AbortController().signal);
    await provider.analyze(snapshot(), new AbortController().signal);
    const fingerprint = new DesktopProfileAnalysisConfigurationSource(
      DESKTOP_ANALYSIS_CONFIGURATION,
      settings,
    ).getConfiguration().processorConfigurationFingerprint;
    expect(secrets.refs).toEqual([active.secretRef, active.secretRef]);
    expect(fingerprint).not.toContain("resolved-runtime-secret");
  });

  it("changes the analysis fingerprint when profile or model changes", () => {
    const first = profile("openai");
    const second = profile("anthropic");
    const settings = new MutableProviderSettings({ profiles: [first, second], activeProfileId: first.id });
    const source = new DesktopProfileAnalysisConfigurationSource(
      DESKTOP_ANALYSIS_CONFIGURATION,
      settings,
    );
    const firstFingerprint = source.getConfiguration().processorConfigurationFingerprint;
    settings.setActiveProfileId(second.id);
    const secondFingerprint = source.getConfiguration().processorConfigurationFingerprint;
    settings.replaceProfiles([first, profile("anthropic", { modelId: "another-model" })]);
    const modelFingerprint = source.getConfiguration().processorConfigurationFingerprint;
    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(modelFingerprint).not.toBe(secondFingerprint);
  });

  it("requires configuration and makes no transport call when no profile is active", async () => {
    const transport = new RecordingTransport();
    const provider = new DesktopProfiledAnalysisProvider(
      new MutableProviderSettings(),
      createBuiltInProviderRegistry(transport),
      new RecordingSecrets(),
    );
    await expect(provider.analyze(snapshot(), new AbortController().signal)).rejects.toMatchObject({
      code: "invalid-profile",
      message: "Configure an AI provider in settings.",
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("returns a safe missing-secret failure before transport", async () => {
    const active = profile("openai");
    const transport = new RecordingTransport();
    const secrets = new RecordingSecrets();
    secrets.value = null;
    const provider = new DesktopProfiledAnalysisProvider(
      new MutableProviderSettings({ profiles: [active], activeProfileId: active.id }),
      createBuiltInProviderRegistry(transport),
      secrets,
    );
    await expect(provider.analyze(snapshot(), new AbortController().signal)).rejects.toMatchObject({
      code: "missing-secret",
    });
    expect(transport.requests).toHaveLength(0);
  });
});
