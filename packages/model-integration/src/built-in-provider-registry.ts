import { AnthropicWritingModelAdapter } from "./adapters/anthropic-adapter.js";
import { GeminiWritingModelAdapter } from "./adapters/gemini-adapter.js";
import { OpenAIWritingModelAdapter } from "./adapters/openai-adapter.js";
import { OpenAICompatibleWritingModelAdapter } from "./adapters/openai-compatible-adapter.js";
import type { HttpTransport } from "./http-transport.js";
import { ProviderRegistry } from "./provider-registry.js";

export function createBuiltInProviderRegistry(
  transport: HttpTransport,
): ProviderRegistry {
  return new ProviderRegistry([
    new OpenAIWritingModelAdapter(transport),
    new AnthropicWritingModelAdapter(transport),
    new GeminiWritingModelAdapter(transport),
    new OpenAICompatibleWritingModelAdapter(transport),
  ]);
}
