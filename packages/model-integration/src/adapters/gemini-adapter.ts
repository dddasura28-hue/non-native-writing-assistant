import type { HttpTransport } from "../http-transport.js";
import { GEMINI_PROVIDER_DEFINITION } from "../provider-definitions.js";
import {
  WRITING_MODEL_RESULT_JSON_SCHEMA,
  parseWritingModelJson,
  type WritingModelRequest,
  type WritingModelResult,
} from "../writing-model-contract.js";
import type {
  WritingModelAdapter,
  WritingModelInvocation,
} from "../writing-model-adapter.js";
import { WritingModelError } from "../writing-model-error.js";
import { createWritingModelPrompt } from "../writing-model-prompt.js";
import {
  assertProfileProvider,
  isObject,
  resolveBaseUrl,
  sendJsonRequest,
} from "./http-adapter-utils.js";

export class GeminiWritingModelAdapter implements WritingModelAdapter {
  readonly providerId = GEMINI_PROVIDER_DEFINITION.id;
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  async analyze(
    request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult> {
    assertProfileProvider(invocation.profile, this.providerId);
    const prompt = createWritingModelPrompt(request);
    const baseUrl = resolveBaseUrl(
      invocation.profile,
      GEMINI_PROVIDER_DEFINITION.defaultBaseUrl,
    );
    const response = await sendJsonRequest(
      this.#transport,
      `${baseUrl}/models/${encodeURIComponent(invocation.profile.modelId)}:generateContent`,
      {
        "x-goog-api-key": invocation.secret,
        "Content-Type": "application/json",
      },
      {
        systemInstruction: {
          parts: [{ text: prompt.instructions }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt.input }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: WRITING_MODEL_RESULT_JSON_SCHEMA,
        },
      },
      invocation.signal,
    );

    return parseWritingModelJson(extractGeminiText(response));
  }
}

function extractGeminiText(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.candidates)) {
    throw invalidOutput();
  }

  for (const candidate of response.candidates) {
    if (!isObject(candidate) || !isObject(candidate.content)) {
      continue;
    }
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    const textPart = parts.find(
      (part) => isObject(part) && typeof part.text === "string",
    );
    if (isObject(textPart) && typeof textPart.text === "string") {
      return textPart.text;
    }
  }

  throw invalidOutput();
}

function invalidOutput(): WritingModelError {
  return new WritingModelError(
    "invalid-structured-output",
    "Gemini returned no structured writing output.",
  );
}
