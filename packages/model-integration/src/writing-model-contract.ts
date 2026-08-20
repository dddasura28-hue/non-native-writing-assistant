import { z } from "zod";

import { WritingModelError } from "./writing-model-error.js";

const nonEmptyText = z.string().min(1);

export const writingModelRequestSchema = z
  .object({
    sourceText: nonEmptyText,
    beforeContext: z.string().default(""),
    afterContext: z.string().default(""),
    nativeLanguageId: nonEmptyText,
    targetLanguageId: nonEmptyText,
    confirmedNativeIntent: z
      .object({ text: nonEmptyText })
      .strict()
      .optional(),
  })
  .strict();

export const writingModelResultSchema = z
  .object({
    nativeIntent: z
      .object({ text: nonEmptyText })
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

export interface WritingModelRequest {
  readonly sourceText: string;
  readonly beforeContext: string;
  readonly afterContext: string;
  readonly nativeLanguageId: string;
  readonly targetLanguageId: string;
  readonly confirmedNativeIntent?: { readonly text: string };
}

export interface WritingModelResult {
  readonly nativeIntent: { readonly text: string } | null;
  readonly normalized: readonly {
    readonly text: string;
    readonly label: string | null;
  }[];
}

export const WRITING_MODEL_RESULT_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    nativeIntent: {
      anyOf: [
        {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
          },
          required: ["text"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    normalized: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1 },
          label: {
            anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          },
        },
        required: ["text", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["nativeIntent", "normalized"],
  additionalProperties: false,
});

export function parseWritingModelResult(value: unknown): WritingModelResult {
  const parsed = writingModelResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new WritingModelError(
      "invalid-structured-output",
      "The provider returned invalid structured writing output.",
    );
  }

  return Object.freeze({
    nativeIntent:
      parsed.data.nativeIntent === null
        ? null
        : Object.freeze({ ...parsed.data.nativeIntent }),
    normalized: Object.freeze(
      parsed.data.normalized.map((item) => Object.freeze({ ...item })),
    ),
  });
}

export function parseWritingModelJson(text: string): WritingModelResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new WritingModelError(
      "invalid-structured-output",
      "The provider returned malformed structured writing output.",
    );
  }

  return parseWritingModelResult(value);
}
