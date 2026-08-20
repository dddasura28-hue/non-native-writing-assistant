import type { WritingModelRequest } from "./writing-model-contract.js";

export interface WritingModelPrompt {
  readonly instructions: string;
  readonly input: string;
}

const WRITING_MODEL_INSTRUCTIONS = `You assist a user who is writing directly in a non-native target language. This is not a literal translation task.

TEXT TO EDIT may contain natural target-language text, incomplete or ungrammatical target-language text, native-language words mixed into the target language, and unfinished thoughts. Infer the most likely intended meaning without unnecessary invention. Preserve the user's meaning and useful wording. Do not make the writing more sophisticated than needed.

Normalize only TEXT TO EDIT. CONTEXT BEFORE and CONTEXT AFTER are read-only semantic context: use them only to understand meaning, references, terminology, tense, and continuity. Do not rewrite, summarize, or return either context section. The normalized output must correspond only to TEXT TO EDIT.

Return a concise nativeIntent for TEXT TO EDIT in the requested native language and exactly one grammatically correct, natural normalized expression in the requested target language. If TEXT TO EDIT is already natural, keep the normalized expression close to it. Do not explain changes.`;

export function createWritingModelPrompt(
  request: WritingModelRequest,
): WritingModelPrompt {
  const confirmedIntentSection = request.confirmedNativeIntent
    ? `\n\nThe user has explicitly confirmed that they intend to mean the following. Treat this as a stronger semantic instruction than your own inference. Normalization should primarily follow it while preserving useful wording from TEXT TO EDIT:\n${request.confirmedNativeIntent.text}`
    : "";

  return Object.freeze({
    instructions: WRITING_MODEL_INSTRUCTIONS,
    input: `Native language identifier: ${request.nativeLanguageId}\nTarget language identifier: ${request.targetLanguageId}\n\nCONTEXT BEFORE (read-only):\n${request.beforeContext}\n\nTEXT TO EDIT:\n${request.sourceText}\n\nCONTEXT AFTER (read-only):\n${request.afterContext}${confirmedIntentSection}`,
  });
}
