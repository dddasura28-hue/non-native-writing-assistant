import type { HttpTransport } from "../http-transport.js";
import { ANTHROPIC_PROVIDER_DEFINITION } from "../provider-definitions.js";
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

export class AnthropicWritingModelAdapter implements WritingModelAdapter {
  readonly providerId = ANTHROPIC_PROVIDER_DEFINITION.id;
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
    const response = await sendJsonRequest(
      this.#transport,
      joinUrl(
        resolveBaseUrl(
          invocation.profile,
          ANTHROPIC_PROVIDER_DEFINITION.defaultBaseUrl,
        ),
        "messages",
      ),
      {
        "x-api-key": invocation.secret,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      {
        model: invocation.profile.modelId,
        max_tokens: 1024,
        system: prompt.instructions,
        messages: [{ role: "user", content: prompt.input }],
        output_config: {
          format: {
            type: "json_schema",
            schema: WRITING_MODEL_RESULT_JSON_SCHEMA,
          },
        },
      },
      invocation.signal,
    );

    return parseWritingModelJson(extractAnthropicText(response));
  }
}

function extractAnthropicText(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.content)) {
    throw invalidOutput();
  }

  const textBlock = response.content.find(
    (block) =>
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (!isObject(textBlock) || typeof textBlock.text !== "string") {
    throw invalidOutput();
  }
  return textBlock.text;
}

function invalidOutput(): WritingModelError {
  return new WritingModelError(
    "invalid-structured-output",
    "Anthropic returned no structured writing output.",
  );
}
