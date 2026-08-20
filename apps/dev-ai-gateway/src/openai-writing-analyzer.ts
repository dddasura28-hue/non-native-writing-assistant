import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  writingAnalysisOutputSchema,
  type GatewayAnalysisRequest,
  type WritingAnalysisOutput,
} from "./analysis-contract.js";
import { createWritingAnalysisPrompt } from "./writing-analysis-prompt.js";

export class OpenAIWritingAnalyzer {
  readonly #responses: OpenAI["responses"];
  readonly #model: string;

  constructor(responses: OpenAI["responses"], model: string) {
    this.#responses = responses;
    this.#model = model;
  }

  async analyze(
    request: GatewayAnalysisRequest,
    signal: AbortSignal,
  ): Promise<WritingAnalysisOutput> {
    const prompt = createWritingAnalysisPrompt(request);
    const response = await this.#responses.parse(
      {
        model: this.#model,
        instructions: prompt.instructions,
        input: prompt.input,
        text: {
          format: zodTextFormat(
            writingAnalysisOutputSchema,
            "writing_analysis",
          ),
        },
      },
      { signal },
    );

    return writingAnalysisOutputSchema.parse(response.output_parsed);
  }
}
