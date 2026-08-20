import { describe, expect, it } from "vitest";

import {
  AnthropicWritingModelAdapter,
  GeminiWritingModelAdapter,
  OpenAICompatibleWritingModelAdapter,
  OpenAIWritingModelAdapter,
  createProviderProfile,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ProviderProfile,
  type WritingModelRequest,
} from "../src/index.js";

const request: WritingModelRequest = {
  sourceText: "I want 写清楚",
  beforeContext: "We are discussing writing goals.",
  afterContext: "Clarity matters for the next step.",
  nativeLanguageId: "zh-CN",
  targetLanguageId: "en",
};
const result = {
  nativeIntent: { text: "我想写清楚。" },
  normalized: [{ text: "I want to write clearly.", label: null }],
};
const fakeSecret = "fake-test-credential-not-real";

class RecordingTransport implements HttpTransport {
  readonly requests: HttpTransportRequest[] = [];
  readonly #response: HttpTransportResponse;

  constructor(body: unknown, status = 200) {
    this.#response = {
      status,
      headers: {},
      body: JSON.stringify(body),
    };
  }

  async send(httpRequest: HttpTransportRequest): Promise<HttpTransportResponse> {
    this.requests.push(httpRequest);
    return this.#response;
  }
}

function profile(
  providerId: string,
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return createProviderProfile({
    id: `${providerId}-profile`,
    name: `${providerId} profile`,
    providerId,
    modelId: `${providerId}-custom-model`,
    secretRef: `${providerId}-secret-ref`,
    enabled: true,
    ...overrides,
  });
}

function invocation(providerProfile: ProviderProfile) {
  return {
    profile: providerProfile,
    secret: fakeSecret,
    signal: new AbortController().signal,
  };
}

function parsedBody(transport: RecordingTransport): Record<string, unknown> {
  const sent = transport.requests[0];
  if (sent === undefined) {
    throw new Error("No HTTP request was recorded.");
  }
  return JSON.parse(sent.body) as Record<string, unknown>;
}

function expectSharedContextPrompt(transport: RecordingTransport): void {
  const serialized = JSON.stringify(parsedBody(transport));
  expect(serialized).toContain("TEXT TO EDIT");
  expect(serialized).toContain(request.sourceText);
  expect(serialized).toContain(request.beforeContext);
  expect(serialized).toContain(request.afterContext);
}

describe("direct writing-model adapters", () => {
  it("builds an OpenAI Responses request and maps structured output", async () => {
    const transport = new RecordingTransport({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(result) }],
        },
      ],
    });
    const adapter = new OpenAIWritingModelAdapter(transport);
    const providerProfile = profile("openai");

    await expect(
      adapter.analyze(request, invocation(providerProfile)),
    ).resolves.toEqual(result);

    expect(transport.requests[0]).toMatchObject({
      url: "https://api.openai.com/v1/responses",
      headers: { Authorization: `Bearer ${fakeSecret}` },
    });
    expect(parsedBody(transport)).toMatchObject({
      model: providerProfile.modelId,
      text: {
        format: {
          type: "json_schema",
          name: "writing_analysis",
          strict: true,
        },
      },
    });
    expectSharedContextPrompt(transport);
  });

  it("builds an Anthropic Messages request and maps structured output", async () => {
    const transport = new RecordingTransport({
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
    const adapter = new AnthropicWritingModelAdapter(transport);
    const providerProfile = profile("anthropic");

    await expect(
      adapter.analyze(request, invocation(providerProfile)),
    ).resolves.toEqual(result);

    expect(transport.requests[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": fakeSecret,
        "anthropic-version": "2023-06-01",
      },
    });
    expect(parsedBody(transport)).toMatchObject({
      model: providerProfile.modelId,
      output_config: { format: { type: "json_schema" } },
    });
    expectSharedContextPrompt(transport);
  });

  it("builds a Gemini generateContent request and maps structured output", async () => {
    const transport = new RecordingTransport({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(result) }] } },
      ],
    });
    const adapter = new GeminiWritingModelAdapter(transport);
    const providerProfile = profile("gemini");

    await expect(
      adapter.analyze(request, invocation(providerProfile)),
    ).resolves.toEqual(result);

    expect(transport.requests[0]).toMatchObject({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${providerProfile.modelId}:generateContent`,
      headers: { "x-goog-api-key": fakeSecret },
    });
    expect(parsedBody(transport)).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
      },
    });
    expectSharedContextPrompt(transport);
  });

  it("uses a custom base URL, model ID, and compatibility mode", async () => {
    const transport = new RecordingTransport({
      choices: [{ message: { content: JSON.stringify(result) } }],
    });
    const adapter = new OpenAICompatibleWritingModelAdapter(transport);
    const providerProfile = profile("openai-compatible", {
      baseUrl: "https://models.example.test/custom/v1",
      modelId: "arbitrary-new-model",
      compatibilityMode: "json-object",
    });

    await adapter.analyze(request, invocation(providerProfile));

    expect(transport.requests[0]?.url).toBe(
      "https://models.example.test/custom/v1/chat/completions",
    );
    expect(parsedBody(transport)).toMatchObject({
      model: "arbitrary-new-model",
      response_format: { type: "json_object" },
    });
    expectSharedContextPrompt(transport);
  });
});
