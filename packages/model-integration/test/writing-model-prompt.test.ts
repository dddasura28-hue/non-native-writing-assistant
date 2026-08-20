import { describe, expect, it } from "vitest";

import {
  createWritingModelPrompt,
  type WritingModelRequest,
} from "../src/index.js";

function request(
  sourceText: string,
  confirmedNativeIntent?: { readonly text: string },
): WritingModelRequest {
  return {
    sourceText,
    beforeContext: "",
    afterContext: "",
    nativeLanguageId: "zh-CN",
    targetLanguageId: "en",
    ...(confirmedNativeIntent === undefined
      ? {}
      : { confirmedNativeIntent }),
  };
}

describe("createWritingModelPrompt native intent semantics", () => {
  it("requires a direct first-person semantic mirror for mixed input", () => {
    const expectedNativeIntent =
      "我觉得这个方法不太合理，因为它忽略了成本。";
    const prompt = createWritingModelPrompt(
      request("I think this method 不太合理 because it ignores cost."),
    );

    expect(prompt.instructions).toContain(
      `nativeIntent: ${expectedNativeIntent}`,
    );
    expect(prompt.instructions).toContain(
      "written from the same point of view as TEXT TO EDIT",
    );
    for (const observerWord of ["用户", "作者", "这是"]) {
      expect(expectedNativeIntent).not.toContain(observerWord);
    }
    expect(prompt.input).toContain(
      "TEXT TO EDIT:\nI think this method 不太合理 because it ignores cost.",
    );
  });

  it("preserves structured input instead of collapsing it", () => {
    const sourceText = "first reason:\nxxx\n\nsecond reason:\nyyy";
    const prompt = createWritingModelPrompt(request(sourceText));

    expect(prompt.input).toContain(`TEXT TO EDIT:\n${sourceText}`);
    expect(prompt.instructions).toContain(
      "Preserve paragraph breaks, line breaks, blank lines, bullet points, numbered lists",
    );
    expect(prompt.instructions).toContain(
      "第一个原因：\nxxx\n\n第二个原因：\nyyy",
    );
    expect(prompt.instructions).toContain(
      "do not collapse structured input into a single explanatory paragraph",
    );
  });

  it("requires uncertainty and unfinished thoughts to remain uncertain", () => {
    const prompt = createWritingModelPrompt(request("I may be wrong but..."));

    expect(prompt.instructions).toContain(
      "TEXT TO EDIT: I may be wrong but...\nnativeIntent: 我可能是错的，但是……",
    );
    expect(prompt.instructions).toContain(
      "Preserve claim strength and the user's degree of certainty",
    );
  });

  it("forbids expanding a short thought", () => {
    const prompt = createWritingModelPrompt(request("good idea"));

    expect(prompt.instructions).toContain(
      "TEXT TO EDIT: good idea\nnativeIntent: 好主意",
    );
    expect(prompt.instructions).toContain(
      "Do not expand a short thought into a paragraph",
    );
  });

  it("turns mixed Chinese and English into direct intended meaning", () => {
    const expectedNativeIntent =
      "我觉得这个解释不太有说服力，因为它忽略了主要问题。";
    const prompt = createWritingModelPrompt(
      request(
        "I don't think this explanation 很能说服人 because it ignores the main problem.",
      ),
    );

    expect(prompt.instructions).toContain(
      `nativeIntent: ${expectedNativeIntent}`,
    );
    expect(prompt.instructions).toContain(
      "semantic mirror of the user's thought",
    );
    expect(prompt.instructions).toContain(
      "meaning layer, not a translation explanation",
    );
    expect(prompt.instructions).toContain(
      "target-language expression layer, not the native-language meaning layer",
    );
    expect(prompt.instructions).toContain(
      "Never frame it as an explanation, summary, commentary, analysis",
    );
  });

  it("keeps confirmed native intent as the stronger normalization instruction", () => {
    const confirmedNativeIntent = { text: "我晚些时候可能会参加。" };
    const prompt = createWritingModelPrompt(
      request("I maybe join later", confirmedNativeIntent),
    );

    expect(prompt.input).toContain("explicitly confirmed");
    expect(prompt.input).toContain("stronger semantic instruction");
    expect(prompt.input).toContain(confirmedNativeIntent.text);
    expect(prompt.input).toContain(
      "Normalization should primarily follow it while preserving useful wording from TEXT TO EDIT",
    );
  });
});
