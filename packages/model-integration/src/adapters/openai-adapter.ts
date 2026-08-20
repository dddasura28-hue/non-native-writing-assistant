import type { HttpTransport } from "../http-transport.js";
import { OPENAI_PROVIDER_DEFINITION } from "../provider-definitions.js";
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

export class OpenAIWritingModelAdapter implements WritingModelAdapter {
  readonly providerId = OPENAI_PROVIDER_DEFINITION.id;
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
          OPENAI_PROVIDER_DEFINITION.defaultBaseUrl,
        ),
        "responses",
      ),
      {
        Authorization: `Bearer ${invocation.secret}`,
        "Content-Type": "application/json",
      },
      {
        model: invocation.profile.modelId,
        instructions: prompt.instructions,
        input: prompt.input,
        text: {
          format: {
            type: "json_schema",
            name: "writing_analysis",
            strict: true,
            schema: WRITING_MODEL_RESULT_JSON_SCHEMA,
          },
        },
      },
      invocation.signal,
    );

    return parseWritingModelJson(extractOpenAIOutputText(response));
  }
}

function extractOpenAIOutputText(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.output)) {
    throw invalidOutput();
  }

  for (const item of response.output) {
    if (!isObject(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (
        isObject(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }

  throw invalidOutput();
}

function invalidOutput(): WritingModelError {
  return new WritingModelError(
    "invalid-structured-output",
    "OpenAI returned no structured writing output.",
  );
}
