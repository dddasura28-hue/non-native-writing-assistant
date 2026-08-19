import type {
  AnalysisProposal,
  AnalysisProvider,
  AnalysisSnapshot,
} from "../src/index.js";

export interface MockAnalysisProviderOptions {
  readonly rejectWhenAborted?: boolean;
}

export interface PendingAnalysisRequest {
  readonly snapshot: AnalysisSnapshot;
  readonly signal: AbortSignal;
  readonly resolve: (proposal: AnalysisProposal) => void;
  readonly reject: (error: unknown) => void;
}

export class MockAnalysisProvider implements AnalysisProvider {
  readonly requests: PendingAnalysisRequest[] = [];
  readonly #rejectWhenAborted: boolean;

  constructor(options: MockAnalysisProviderOptions = {}) {
    this.#rejectWhenAborted = options.rejectWhenAborted ?? false;
  }

  analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    return new Promise((resolve, reject) => {
      const request: PendingAnalysisRequest = {
        snapshot,
        signal,
        resolve,
        reject,
      };
      this.requests.push(request);

      if (this.#rejectWhenAborted) {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Mock analysis aborted.")),
          { once: true },
        );
      }
    });
  }

  request(index: number): PendingAnalysisRequest {
    const request = this.requests[index];
    if (request === undefined) {
      throw new RangeError(`No mock request exists at index ${index}.`);
    }

    return request;
  }
}
