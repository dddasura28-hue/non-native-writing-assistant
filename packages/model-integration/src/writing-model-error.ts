export type WritingModelErrorCode =
  | "missing-secret"
  | "unknown-provider"
  | "invalid-profile"
  | "authentication"
  | "rate-limit"
  | "provider-failure"
  | "invalid-structured-output"
  | "network"
  | "aborted";

export class WritingModelError extends Error {
  readonly code: WritingModelErrorCode;
  readonly status?: number;

  constructor(
    code: WritingModelErrorCode,
    message: string,
    options: { readonly status?: number } = {},
  ) {
    super(message);
    this.name = "WritingModelError";
    this.code = code;
    this.status = options.status;
  }
}

export function throwIfAnalysisAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WritingModelError("aborted", "Analysis was aborted.");
  }
}
