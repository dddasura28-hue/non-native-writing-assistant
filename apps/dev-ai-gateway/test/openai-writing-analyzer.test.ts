import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { OpenAIWritingAnalyzer } from "../src/openai-writing-analyzer.js";

describe("OpenAIWritingAnalyzer", () => {
  it("uses Responses API parsing with a strict structured-output format", async () => {
    const output = {
      nativeIntent: { text: "用户想写得更清楚。" },
      normalized: [{ text: "The user wants to write more clearly.", label: null }],
    };
    const parse = vi.fn().mockResolvedValue({ output_parsed: output });
    const responses = { parse } as unknown as OpenAI["responses"];
    const analyzer = new OpenAIWritingAnalyzer(responses, "test-model");
    const signal = new AbortController().signal;

    await expect(
      analyzer.analyze(
        {
          sourceText: "I want 写清楚",
          nativeLanguageId: "zh-CN",
          targetLanguageId: "en",
        },
        signal,
      ),
    ).resolves.toEqual(output);

    expect(parse).toHaveBeenCalledOnce();
    const [request, options] = parse.mock.calls[0] as [
      {
        model: string;
        input: string;
        text: { format: { type: string; name: string; strict: boolean } };
      },
      { signal: AbortSignal },
    ];
    expect(request.model).toBe("test-model");
    expect(request.input).toContain("I want 写清楚");
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "writing_analysis",
      strict: true,
    });
    expect(options.signal).toBe(signal);
  });
});
