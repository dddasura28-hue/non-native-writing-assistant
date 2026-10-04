/** Fixed tokens and numeric metadata only; never serialize an event or error. */
const STAGES = [
  "capture-listener", "presentation-listener", "frontend-capture-event",
  "frontend-presentation-event", "controller-wait", "controller-invocation",
  "analysis", "presentation-emitted", "presentation-event-emit",
  "floating-presentation", "invocation-discarded",
] as const;
const RESULTS = [
  "ready", "accepted", "rejected", "started", "attempted", "succeeded",
  "failed", "waiting", "stale", "disposed", "unavailable", "empty", "skipped",
  "composition-active", "configuration-required", "manual-disallowed",
  "capturing", "no-host", "idle", "analyzing", "completed", "updated",
] as const;

type DiagnosticStage = typeof STAGES[number];
type DiagnosticResult = typeof RESULTS[number];
interface DiagnosticDetails {
  readonly utf16Length?: number;
  readonly reason?: DiagnosticResult;
}

export function formatGlobalDiagnostic(
  invocationId: unknown,
  stage: DiagnosticStage,
  result: DiagnosticResult,
  details: DiagnosticDetails = {},
): string {
  const id = safeInteger(invocationId, 1) ?? "-";
  const safeStage = STAGES.includes(stage) ? stage : "invalid-stage";
  const safeResult = RESULTS.includes(result) ? result : "invalid-result";
  let line = `[global-debug] invocation=${id} stage=${safeStage} result=${safeResult}`;
  const utf16Length = safeInteger(details.utf16Length, 0);
  if (utf16Length !== null) line += ` utf16_length=${utf16Length}`;
  if (details.reason !== undefined && RESULTS.includes(details.reason)) {
    line += ` reason=${details.reason}`;
  }
  return line;
}

export function traceGlobalInvocation(
  invocationId: unknown,
  stage: DiagnosticStage,
  result: DiagnosticResult,
  details?: DiagnosticDetails,
): void {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    console.debug(formatGlobalDiagnostic(invocationId, stage, result, details));
  }
}

export function diagnosticInvocationId(value: unknown): number | null {
  return typeof value === "object" && value !== null && "invocationId" in value
    ? safeInteger(value.invocationId, 1)
    : null;
}

function safeInteger(value: unknown, minimum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}
