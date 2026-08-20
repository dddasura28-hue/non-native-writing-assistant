import type {
  AnalysisProposal,
  AnalysisProvider,
  AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asGenerationGroupId,
  asTrackId,
} from "@non-native-writing/core";

interface GatewayAnalysisResponse {
  readonly nativeIntent: { readonly text: string } | null;
  readonly normalized: readonly {
    readonly text: string;
    readonly label: string | null;
  }[];
}

type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class HttpAnalysisProvider implements AnalysisProvider {
  readonly #endpoint: string;
  readonly #fetch: FetchImplementation;
  #generationNumber = 0;

  constructor(
    endpoint: string,
    fetchImplementation: FetchImplementation = globalThis.fetch.bind(
      globalThis,
    ),
  ) {
    this.#endpoint = endpoint;
    this.#fetch = fetchImplementation;
  }

  async analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceText: snapshot.sourceText,
        beforeContext: snapshot.beforeContext,
        afterContext: snapshot.afterContext,
        nativeLanguageId: snapshot.nativeLanguageId,
        targetLanguageId: snapshot.targetLanguageId,
        ...(snapshot.confirmedNativeIntent === undefined
          ? {}
          : {
              confirmedNativeIntent: {
                text: snapshot.confirmedNativeIntent.text,
              },
            }),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Development AI gateway request failed with HTTP ${response.status}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TypeError("Development AI gateway returned invalid JSON.");
    }

    const result = parseGatewayAnalysisResponse(body);
    const generationNumber = ++this.#generationNumber;
    const idSuffix = `${snapshot.segmentId}-${snapshot.sourceRevision}-${generationNumber}`;
    const generationGroupId = asGenerationGroupId(
      `http-generation-${idSuffix}`,
    );
    const outputs = [];

    if (result.nativeIntent !== null) {
      outputs.push(
        Object.freeze({
          id: asTrackId(`http-native-intent-${idSuffix}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: result.nativeIntent.text,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          label: "Native intent",
          order: 1,
        }),
      );
    }

    for (const [index, normalized] of result.normalized.entries()) {
      outputs.push(
        Object.freeze({
          id: asTrackId(`http-normalized-${idSuffix}-${index + 1}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: normalized.text,
          provenance: "model" as const,
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId,
          ...(normalized.label === null ? {} : { label: normalized.label }),
          order: index + 1,
        }),
      );
    }

    return Object.freeze({ outputs: Object.freeze(outputs) });
  }
}

function parseGatewayAnalysisResponse(
  value: unknown,
): GatewayAnalysisResponse {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["nativeIntent", "normalized"])) {
    throw invalidResponse();
  }

  const nativeIntent = value.nativeIntent;
  if (
    nativeIntent !== null &&
    (!isPlainObject(nativeIntent) ||
      !hasOnlyKeys(nativeIntent, ["text"]) ||
      !isNonEmptyString(nativeIntent.text))
  ) {
    throw invalidResponse();
  }

  if (!Array.isArray(value.normalized) || value.normalized.length === 0) {
    throw invalidResponse();
  }

  const normalized = value.normalized.map((item) => {
    if (
      !isPlainObject(item) ||
      !hasOnlyKeys(item, ["text", "label"]) ||
      !isNonEmptyString(item.text) ||
      (item.label !== null && !isNonEmptyString(item.label))
    ) {
      throw invalidResponse();
    }

    return Object.freeze({ text: item.text, label: item.label });
  });

  return Object.freeze({
    nativeIntent:
      nativeIntent === null
        ? null
        : Object.freeze({ text: nativeIntent.text as string }),
    normalized: Object.freeze(normalized),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalidResponse(): TypeError {
  return new TypeError("Development AI gateway returned an invalid response.");
}
