import type { SegmentRange } from "./segment-range.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  readonly category: string;
  readonly message: string;
  readonly range?: SegmentRange;
  readonly suggestedReplacement?: string;
  readonly severity?: DiagnosticSeverity;
}
