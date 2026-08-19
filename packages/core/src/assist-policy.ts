export type RewriteScope = "selection" | "sentence" | "paragraph" | "segment";
export type ExplanationDepth = "none" | "brief" | "detailed";

export interface AssistPolicy {
  readonly inferImplicitMeaning: boolean;
  readonly preserveUserWording: boolean;
  readonly rewriteScope: RewriteScope;
  readonly generateNativeIntent: boolean;
  readonly explanationDepth: ExplanationDepth;
  /** A normalized policy threshold from 0 through 1. */
  readonly interventionThreshold: number;
  readonly allowAlternatives: boolean;
}

export function createAssistPolicy(policy: AssistPolicy): AssistPolicy {
  if (
    !Number.isFinite(policy.interventionThreshold) ||
    policy.interventionThreshold < 0 ||
    policy.interventionThreshold > 1
  ) {
    throw new RangeError("interventionThreshold must be between 0 and 1.");
  }

  return Object.freeze({ ...policy });
}
