import { describe, expect, it } from "vitest";

import { writingAnalysisOutputSchema } from "../src/analysis-contract.js";

describe("writingAnalysisOutputSchema", () => {
  it("accepts the intended structured output", () => {
    const value = {
      nativeIntent: { text: "用户想表达一个尚未完成的想法。" },
      normalized: [
        { text: "The user wants to express an unfinished thought.", label: null },
        { text: "This thought is still taking shape.", label: "Concise" },
      ],
    };

    expect(writingAnalysisOutputSchema.parse(value)).toEqual(value);
  });

  it("rejects clearly invalid structured output", () => {
    expect(
      writingAnalysisOutputSchema.safeParse({
        nativeIntent: { text: "Intent" },
        normalized: [],
      }).success,
    ).toBe(false);

    expect(
      writingAnalysisOutputSchema.safeParse({
        nativeIntent: null,
        normalized: [{ text: "Expression" }],
      }).success,
    ).toBe(false);
  });
});
