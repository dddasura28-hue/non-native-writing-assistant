import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OpenAIWritingModelAdapter,
  ProviderRegistry,
  WritingModelError,
  createActiveProfileFingerprint,
  createProviderProfile,
  parseWritingModelResult,
  type HttpTransport,
  type ProviderProfile,
  type WritingModelAdapter,
} from "../src/index.js";

const fakeSecret = "fake-test-secret-never-real";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return createProviderProfile({
    id: "profile-one",
    name: "Profile one",
    providerId: "openai-compatible",
    modelId: "custom-model",
    secretRef: "fake-secret-reference",
    baseUrl: "https://models.example.test/v1",
    compatibilityMode: "json-schema",
    enabled: true,
    ...overrides,
  });
}

describe("provider infrastructure", () => {
  it("keeps raw credentials out of ProviderProfile state", () => {
    const value = profile();

    expect(value.secretRef).toBe("fake-secret-reference");
    expect(value).not.toHaveProperty("apiKey");
    expect(value).not.toHaveProperty("secret");
    expect(JSON.stringify(value)).not.toContain(fakeSecret);
  });

  it("changes the active-profile fingerprint for relevant properties only", () => {
    const variants = [
      profile(),
      profile({ providerId: "another-provider" }),
      profile({ modelId: "another-model" }),
      profile({ baseUrl: "https://other.example.test/v1" }),
      profile({ compatibilityMode: "prompt-json" }),
      profile({ secretRef: "another-secret-reference" }),
    ];
    const fingerprints = variants.map((candidate) =>
      createActiveProfileFingerprint({
        profiles: [candidate],
        activeProfileId: candidate.id,
      }),
    );

    expect(new Set(fingerprints)).toHaveLength(variants.length);
    expect(fingerprints.join("\n")).not.toContain(fakeSecret);
  });

  it("rejects an unknown provider ID safely", () => {
    const registry = new ProviderRegistry([]);

    expect(() => registry.resolve("unknown-provider")).toThrowError(
      expect.objectContaining({ code: "unknown-provider" }),
    );
  });

  it("rejects invalid common structured output", () => {
    expect(() =>
      parseWritingModelResult({ nativeIntent: null, normalized: [] }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid-structured-output" }),
    );
  });

  it("does not include a resolved credential in provider errors", async () => {
    const transport: HttpTransport = {
      async send() {
        return {
          status: 401,
          headers: {},
          body: JSON.stringify({ error: fakeSecret }),
        };
      },
    };
    const adapter = new OpenAIWritingModelAdapter(transport);
    const openAIProfile = profile({
      providerId: "openai",
      baseUrl: undefined,
    });

    let failure: unknown;
    try {
      await adapter.analyze(
        {
          sourceText: "Draft",
          beforeContext: "",
          afterContext: "",
          nativeLanguageId: "zh-CN",
          targetLanguageId: "en",
        },
        {
          profile: openAIProfile,
          secret: fakeSecret,
          signal: new AbortController().signal,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WritingModelError);
    expect(failure).toMatchObject({ code: "authentication", status: 401 });
    expect(String(failure)).not.toContain(fakeSecret);
  });

  it("keeps provider and model types out of the text-context boundary", () => {
    const applicationSource = resolve(process.cwd(), "../application/src");
    const sources = ["text-context.ts", "context-selector.ts", "host-capabilities.ts", "text-edit-port.ts"].map((file) =>
      readFileSync(resolve(applicationSource, file), "utf8"),
    );

    for (const source of sources) {
      expect(source).not.toMatch(
        /@non-native-writing\/model-integration|AnalysisProvider|ProviderProfile|WritingModel/,
      );
    }
  });
});
