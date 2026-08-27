import {
  createUnitSourceFingerprint,
  type UnitSourceFingerprint,
} from "./unit-source-fingerprint.js";
import type { WritingUnit } from "./writing-unit.js";

export type UnitAnalysisTriggerDecision = "none" | "debounced" | "immediate";

export interface UnitAnalysisTriggerInput {
  readonly unit: WritingUnit | null;
  readonly automaticAnalysisNeeded: boolean;
  readonly sourceChanged: boolean;
  readonly explicitSelection: boolean;
  readonly compositionBlocked: boolean;
  readonly triggeredCompletionFingerprints: ReadonlySet<UnitSourceFingerprint>;
}

export interface UnitAnalysisTriggerPolicy {
  decide(input: UnitAnalysisTriggerInput): UnitAnalysisTriggerDecision;
}

const SENTENCE_TERMINALS = new Set([".", "!", "?", "。", "！", "？"]);

/** Pure v1 policy for automatic cursor-local assistance timing. */
export class SentenceUnitAnalysisTriggerPolicy
  implements UnitAnalysisTriggerPolicy
{
  decide(input: UnitAnalysisTriggerInput): UnitAnalysisTriggerDecision {
    if (
      !input.automaticAnalysisNeeded ||
      input.explicitSelection ||
      input.compositionBlocked ||
      input.unit === null
    ) {
      return "none";
    }

    if (!isSentenceComplete(input.unit)) {
      return "debounced";
    }

    if (input.sourceChanged) {
      return input.triggeredCompletionFingerprints.has(
        createUnitSourceFingerprint(input.unit),
      )
        ? "none"
        : "immediate";
    }

    // Navigating to a stale completed unit preserves the existing lazy,
    // debounce-driven refresh rather than treating cursor movement as typing.
    return "debounced";
  }
}

export function isSentenceComplete(unit: WritingUnit): boolean {
  const terminal = unit.text.at(-1);
  return terminal !== undefined && SENTENCE_TERMINALS.has(terminal);
}
