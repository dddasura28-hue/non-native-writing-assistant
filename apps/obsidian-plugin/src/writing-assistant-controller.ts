import {
  AnalysisCoordinator,
  type AnalysisConfiguration,
  type AnalysisOutcome,
} from "@non-native-writing/application";
import {
  WritingSegment,
  asSegmentId,
  asTrackId,
} from "@non-native-writing/core";

import {
  createViewModel,
  statusForOutcome,
  type WritingAssistantViewModel,
} from "./presentation.js";

const DEMO_CONFIGURATION: AnalysisConfiguration = Object.freeze({
  assistPolicyFingerprint: "demo-assist-policy:v1",
  styleProfileFingerprint: "demo-style-profile:v1",
  languageConfigurationFingerprint: "demo-languages:v1",
  processorConfigurationFingerprint: "demo-analysis:v1",
  targetLanguageId: "target-demo",
  nativeLanguageId: "native-demo",
});

export interface WritingAssistantPresenter {
  present(viewModel: WritingAssistantViewModel): void;
}

export interface ObservedDocumentSource {
  readonly documentKey: string;
  readonly text: string;
}

export type RevealWritingAssistant = () => Promise<WritingAssistantPresenter>;

interface CurrentDocument {
  readonly documentKey: string;
  readonly segment: WritingSegment;
}

export class WritingAssistantController {
  readonly #coordinator: AnalysisCoordinator;
  readonly #revealWritingAssistant: RevealWritingAssistant;

  // Temporary manual-MVP identity: retain only the currently analyzed document
  // in memory until stable segmentation and persistence are designed.
  #currentDocument?: CurrentDocument;
  #nextSegmentNumber = 0;
  #presentationRunNumber = 0;

  constructor(
    coordinator: AnalysisCoordinator,
    revealWritingAssistant: RevealWritingAssistant,
  ) {
    this.#coordinator = coordinator;
    this.#revealWritingAssistant = revealWritingAssistant;
  }

  async analyze(source: ObservedDocumentSource): Promise<AnalysisOutcome> {
    const presenter = await this.#revealWritingAssistant();
    const segment = this.#observeSource(source);
    const runNumber = ++this.#presentationRunNumber;

    presenter.present(createViewModel(segment, "Analyzing"));

    const outcome = await this.#coordinator.analyze(
      segment,
      DEMO_CONFIGURATION,
    );

    if (runNumber === this.#presentationRunNumber) {
      const appliedTrackIds =
        outcome.status === "applied" ? outcome.appliedTrackIds : [];
      const detail =
        outcome.status === "failed" ? describeError(outcome.error) : undefined;

      presenter.present(
        createViewModel(
          segment,
          statusForOutcome(outcome),
          appliedTrackIds,
          detail,
        ),
      );
    }

    return outcome;
  }

  dispose(): void {
    this.#presentationRunNumber += 1;
    if (this.#currentDocument !== undefined) {
      this.#coordinator.cancelAnalysis(this.#currentDocument.segment.id);
    }
  }

  #observeSource(source: ObservedDocumentSource): WritingSegment {
    if (
      this.#currentDocument !== undefined &&
      this.#currentDocument.documentKey === source.documentKey
    ) {
      this.#currentDocument.segment.updateSourceText(source.text);
      return this.#currentDocument.segment;
    }

    if (this.#currentDocument !== undefined) {
      this.#coordinator.cancelAnalysis(this.#currentDocument.segment.id);
    }

    const segmentNumber = ++this.#nextSegmentNumber;
    const segment = WritingSegment.create({
      id: asSegmentId(`obsidian-segment-${segmentNumber}`),
      sourceTrackId: asTrackId(`obsidian-source-${segmentNumber}`),
      sourceText: source.text,
    });

    this.#currentDocument = Object.freeze({
      documentKey: source.documentKey,
      segment,
    });

    return segment;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis failed.";
}
