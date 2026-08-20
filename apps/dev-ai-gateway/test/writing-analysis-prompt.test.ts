import { describe, expect, it } from "vitest";

import { createWritingAnalysisPrompt } from "../src/writing-analysis-prompt.js";

describe("createWritingAnalysisPrompt", () => {
  it("includes source text and both language identifiers", () => {
    const prompt = createWritingAnalysisPrompt({
      sourceText: "I want 写一个 clear message.",
      nativeLanguageId: "zh-CN",
      targetLanguageId: "en",
    });

    expect(prompt.input).toContain("I want 写一个 clear message.");
    expect(prompt.input).toContain("zh-CN");
    expect(prompt.input).toContain("en");
    expect(prompt.instructions).toContain("not a literal translation task");
  });

  it("includes current confirmed intent as a stronger semantic instruction", () => {
    const prompt = createWritingAnalysisPrompt({
      sourceText: "I maybe join later",
      nativeLanguageId: "zh-CN",
      targetLanguageId: "en",
      confirmedNativeIntent: { text: "我晚些时候可能会参加。" },
    });

    expect(prompt.input).toContain("explicitly confirmed");
    expect(prompt.input).toContain("stronger semantic instruction");
    expect(prompt.input).toContain("我晚些时候可能会参加。");
  });

  it("omits confirmed-intent instructions when none is present", () => {
    const prompt = createWritingAnalysisPrompt({
      sourceText: "I maybe join later",
      nativeLanguageId: "zh-CN",
      targetLanguageId: "en",
    });

    expect(prompt.input).not.toContain("explicitly confirmed");
    expect(prompt.input).not.toContain("stronger semantic instruction");
  });
});
