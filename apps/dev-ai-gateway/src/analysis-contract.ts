import { z } from "zod";

const nonEmptyText = z.string().min(1);

export const gatewayAnalysisRequestSchema = z
  .object({
    sourceText: nonEmptyText,
    nativeLanguageId: nonEmptyText,
    targetLanguageId: nonEmptyText,
    confirmedNativeIntent: z
      .object({
        text: nonEmptyText,
      })
      .strict()
      .optional(),
  })
  .strict();

export const writingAnalysisOutputSchema = z
  .object({
    nativeIntent: z
      .object({
        text: nonEmptyText,
      })
      .strict()
      .nullable(),
    normalized: z
      .array(
        z
          .object({
            text: nonEmptyText,
            label: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type GatewayAnalysisRequest = z.infer<
  typeof gatewayAnalysisRequestSchema
>;
export type WritingAnalysisOutput = z.infer<
  typeof writingAnalysisOutputSchema
>;
