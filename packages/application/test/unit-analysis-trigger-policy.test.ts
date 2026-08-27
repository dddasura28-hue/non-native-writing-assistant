import { describe, expect, it } from "vitest";

import {
  SentenceUnitAnalysisTriggerPolicy,
  SimpleWritingUnitSegmenter,
  createUnitSourceFingerprint,
  type UnitAnalysisTriggerInput,
  type UnitSourceFingerprint,
  type WritingUnit,
} from "../src/index.js";

const policy = new SentenceUnitAnalysisTriggerPolicy();
const segmenter = new SimpleWritingUnitSegmenter();
const noTriggeredCompletions = new Set<UnitSourceFingerprint>();

function unit(text: string): WritingUnit {
  const selected = segmenter.segment(text).at(-1);
  if (selected === undefined) {
    throw new Error("Test text did not produce a WritingUnit.");
  }
  return selected;
}

function input(
  text: string,
  overrides: Partial<UnitAnalysisTriggerInput> = {},
): UnitAnalysisTriggerInput {
  return {
    unit: unit(text),
    automaticAnalysisNeeded: true,
    sourceChanged: true,
    explicitSelection: false,
    compositionBlocked: false,
    triggeredCompletionFingerprints: noTriggeredCompletions,
    ...overrides,
  };
}

describe("SentenceUnitAnalysisTriggerPolicy", () => {
  it("uses the debounce fallback for unfinished writing", () => {
    expect(policy.decide(input("I think this policy is"))).toBe("debounced");
  });

  it.each([".", "!", "?", "。", "！", "？"])(
    "triggers immediately for a unit ending in %s",
    (terminal) => {
      expect(policy.decide(input(`Complete${terminal}`))).toBe("immediate");
    },
  );

  it("deduplicates a previously triggered completed source fingerprint", () => {
    const completed = unit("I agree.");
    const triggered = new Set([createUnitSourceFingerprint(completed)]);

    expect(
      policy.decide({
        ...input("I agree."),
        unit: completed,
        triggeredCompletionFingerprints: triggered,
      }),
    ).toBe("none");
  });

  it("does not retrigger the previous completed unit for following whitespace", () => {
    const completed = unit("I agree. ");
    const triggered = new Set([createUnitSourceFingerprint(completed)]);

    expect(
      policy.decide({
        ...input("I agree. "),
        unit: completed,
        triggeredCompletionFingerprints: triggered,
      }),
    ).toBe("none");
  });

  it("blocks automatic analysis for relevant composition", () => {
    expect(
      policy.decide(input("Composing.", { compositionBlocked: true })),
    ).toBe("none");
  });

  it("bypasses cursor-local automatic triggers for explicit selections", () => {
    expect(
      policy.decide(input("Selected.", { explicitSelection: true })),
    ).toBe("none");
  });

  it("uses debounce rather than punctuation timing for cursor navigation", () => {
    expect(
      policy.decide(input("Existing.", { sourceChanged: false })),
    ).toBe("debounced");
  });
});
