import type { HttpTransport } from "../http-transport.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
} from "../provider-definitions.js";
import type { StructuredOutputMode } from "../provider-profile.js";
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
  joinUrl,
  resolveBaseUrl,
  sendJsonRequest,
} from "./http-adapter-utils.js";

export class OpenAICompatibleWritingModelAdapter
  implements WritingModelAdapter
{
  readonly providerId = OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  async analyze(
    request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult> {
    assertProfileProvider(invocation.profile, this.providerId);
    const mode = invocation.profile.compatibilityMode ?? "json-schema";
    const prompt = createWritingModelPrompt(request);
    const messages = [
      {
        role: "system",
        content:
          mode === "json-schema"
            ? prompt.instructions
            : `${prompt.instructions}\n\nReturn only JSON matching this schema:\n${JSON.stringify(WRITING_MODEL_RESULT_JSON_SCHEMA)}`,
      },
      { role: "user", content: prompt.input },
    ];
    const response = await sendJsonRequest(
      this.#transport,
      joinUrl(
        resolveBaseUrl(invocation.profile, undefined),
        "chat/completions",
      ),
      {
        Authorization: `Bearer ${invocation.secret}`,
        "Content-Type": "application/json",
      },
      {
        model: invocation.profile.modelId,
        messages,
        ...responseFormatFor(mode),
      },
      invocation.signal,
    );

    return parseWritingModelJson(extractCompatibleText(response));
  }
}

function responseFormatFor(
  mode: StructuredOutputMode,
): Readonly<Record<string, unknown>> {
  switch (mode) {
    case "json-schema":
      return {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "writing_analysis",
            strict: true,
            schema: WRITING_MODEL_RESULT_JSON_SCHEMA,
          },
        },
      };
    case "json-object":
      return { response_format: { type: "json_object" } };
    case "prompt-json":
      return {};
  }
}

function extractCompatibleText(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.choices)) {
    throw invalidOutput();
  }
  const firstChoice = response.choices[0];
  if (
    !isObject(firstChoice) ||
    !isObject(firstChoice.message) ||
    typeof firstChoice.message.content !== "string"
  ) {
    throw invalidOutput();
  }
  return firstChoice.message.content;
}

function invalidOutput(): WritingModelError {
  return new WritingModelError(
    "invalid-structured-output",
    "The compatible provider returned no structured writing output.",
  );
}
