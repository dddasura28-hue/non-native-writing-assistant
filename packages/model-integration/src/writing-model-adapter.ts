import type { ProviderProfile } from "./provider-profile.js";
import type {
  WritingModelRequest,
  WritingModelResult,
} from "./writing-model-contract.js";

export interface WritingModelInvocation {
  readonly profile: ProviderProfile;
  readonly secret: string;
  readonly signal: AbortSignal;
}

export interface WritingModelAdapter {
  readonly providerId: string;
  analyze(
    request: WritingModelRequest,
    invocation: WritingModelInvocation,
  ): Promise<WritingModelResult>;
}
