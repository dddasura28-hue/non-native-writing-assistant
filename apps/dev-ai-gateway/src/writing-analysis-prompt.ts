import type { GatewayAnalysisRequest } from "./analysis-contract.js";

export interface WritingAnalysisPrompt {
  readonly instructions: string;
  readonly input: string;
}

const WRITING_ANALYSIS_INSTRUCTIONS = `You assist a user who is writing directly in a non-native target language. This is not a literal translation task.

The source may contain natural target-language text, incomplete or ungrammatical target-language text, native-language words mixed into the target language, and unfinished thoughts. Infer the most likely intended meaning without unnecessary invention. Preserve the user's meaning and useful wording. Do not make the writing more sophisticated than needed.

Return a concise nativeIntent in the requested native language and exactly one grammatically correct, natural normalized expression in the requested target language. If the source is already natural, keep the normalized expression close to it. Do not explain changes.`;

export function createWritingAnalysisPrompt(
  request: GatewayAnalysisRequest,
): WritingAnalysisPrompt {
  const confirmedIntentSection = request.confirmedNativeIntent
    ? `\n\nThe user has explicitly confirmed that they intend to mean the following. Treat this as a stronger semantic instruction than your own inference. Normalization should primarily follow it while preserving useful wording from the source:\n${request.confirmedNativeIntent.text}`
    : "";

  return Object.freeze({
    instructions: WRITING_ANALYSIS_INSTRUCTIONS,
    input: `Native language identifier: ${request.nativeLanguageId}\nTarget language identifier: ${request.targetLanguageId}\n\nSource text:\n${request.sourceText}${confirmedIntentSection}`,
  });
}
