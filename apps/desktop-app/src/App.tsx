import {
  createTextContext,
  type TextContext,
} from "@non-native-writing/application";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type FormEvent,
  type SyntheticEvent,
} from "react";

import {
  EMPTY_DESKTOP_ASSISTANCE,
  type DesktopAssistanceItem,
  type DesktopAssistancePresentation,
  type DesktopNativeIntentPresentation,
  type DesktopNativeIntentTarget,
  type DesktopNormalizedAcceptTarget,
  type DesktopNormalizedPresentation,
} from "./controller/desktop-engine-controller.js";
import {
  EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
  type GlobalDesktopAssistantPresentation,
} from "./controller/global-desktop-assistant-controller.js";
import {
  createDesktopController,
  type DesktopControllerFactory,
  type DesktopControllerPort,
} from "./controller/desktop-composition.js";
export type {
  DesktopControllerFactory,
  DesktopControllerPort,
} from "./controller/desktop-composition.js";
import {
  TextareaCompositionTracker,
  captureTextareaTextContext,
} from "./host/textarea-text-context-adapter.js";
import {
  type TextareaSessionState,
} from "./host/textarea-text-edit-port.js";
import { createCapturedTextareaTextSurface } from "./host/textarea-active-text-surface.js";
import {
  calculateTextareaInlinePosition,
  measureTextareaTextAnchor,
  type TextareaTextAnchor,
  type TextareaInlinePosition,
} from "./host/textarea-text-anchor.js";
import {
  EMPTY_DESKTOP_PROVIDER_SETTINGS_VIEW,
  isCustomProvider,
  type DesktopProviderProfileView,
  type DesktopProviderSettingsView,
} from "./settings/desktop-settings-controller.js";

const EMPTY_CONTEXT = createTextContext({
  text: "",
  cursorOffset: 0,
  selection: null,
  composition: null,
});

const WINDOWS_CAPTURE_DELAY_MS = 3_000;

export interface AppProps {
  readonly createController?: DesktopControllerFactory;
  readonly measureTextAnchor?: typeof measureTextareaTextAnchor;
}

export function App({
  createController = createDesktopController,
  measureTextAnchor = measureTextareaTextAnchor,
}: AppProps) {
  const [editorText, setEditorText] = useState("");
  const [textContext, setTextContext] = useState<TextContext>(EMPTY_CONTEXT);
  const [assistance, setAssistance] =
    useState<DesktopAssistancePresentation>(EMPTY_DESKTOP_ASSISTANCE);
  const [providerSettings, setProviderSettings] =
    useState<DesktopProviderSettingsView>(EMPTY_DESKTOP_PROVIDER_SETTINGS_VIEW);
  const [windowsAssistance, setWindowsAssistance] =
    useState<GlobalDesktopAssistantPresentation>(
      EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
    );
  const [windowsCaptureScheduled, setWindowsCaptureScheduled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inlineAnchor, setInlineAnchor] =
    useState<TextareaTextAnchor | null>(null);
  const [inlinePosition, setInlinePosition] =
    useState<TextareaInlinePosition | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const writingPane = useRef<HTMLElement | null>(null);
  const inlineCard = useRef<HTMLElement | null>(null);
  const controller = useRef<DesktopControllerPort | null>(null);
  const sessionToken = useRef(Symbol("desktop-textarea-session"));
  const generation = useRef(0);
  const composition = useRef(new TextareaCompositionTracker());
  const windowsCaptureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentSession = useCallback(
    (): TextareaSessionState => ({
      token: sessionToken.current,
      generation: generation.current,
      compositionActive: composition.current.active,
    }),
    [],
  );

  const capture = useCallback(
    (textarea: HTMLTextAreaElement, stateChanged = false): void => {
      if (stateChanged) {
        generation.current += 1;
      }

      const publish = (
        context: TextContext,
        suppressAutomaticAnalysis = false,
      ): void => {
        const surface = createCapturedTextareaTextSurface({
          target: textarea,
          context,
          session: currentSession(),
          getCurrentSession: currentSession,
          onDidReplace: (freshContext) => {
            generation.current += 1;
            setEditorText(freshContext.text);
            publish(freshContext, true);
          },
        });
        setTextContext(surface.context);
        controller.current?.observe(surface.context, surface.editPort, {
          suppressAutomaticAnalysis,
        });
      };

      publish(
        captureTextareaTextContext(
          textarea,
          composition.current.capture(textarea),
        ),
      );
    },
    [currentSession],
  );

  useEffect(() => {
    const activeController = createController(
      setAssistance,
      setProviderSettings,
      setWindowsAssistance,
    );
    controller.current = activeController;
    if (editor.current !== null) {
      capture(editor.current);
    }

    return () => {
      if (windowsCaptureTimer.current !== null) {
        clearTimeout(windowsCaptureTimer.current);
        windowsCaptureTimer.current = null;
      }
      controller.current = null;
      activeController.dispose();
    };
  }, [capture, createController]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setEditorText(event.currentTarget.value);
    capture(event.currentTarget, true);
  };

  const handleSelection = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    capture(event.currentTarget);
  };

  const handleClick = (event: MouseEvent<HTMLTextAreaElement>): void => {
    capture(event.currentTarget);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    capture(event.currentTarget);
  };

  const handleCompositionStart = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ): void => {
    composition.current.start(event.currentTarget, event.data);
    capture(event.currentTarget, true);
  };

  const handleCompositionUpdate = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ): void => {
    composition.current.update(event.data);
    capture(event.currentTarget, true);
  };

  const handleCompositionEnd = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ): void => {
    composition.current.end();
    capture(event.currentTarget, true);
  };

  const handleAcceptNormalized = useCallback(
    async (target: DesktopNormalizedAcceptTarget): Promise<void> => {
      try {
        await (
          controller.current?.acceptNormalized(target) ??
          Promise.resolve("obsolete")
        );
      } finally {
        editor.current?.focus({ preventScroll: true });
      }
    },
    [],
  );

  const handleAnalyzeWindowsSurface = useCallback((): void => {
    if (windowsCaptureTimer.current !== null) {
      return;
    }
    setWindowsCaptureScheduled(true);
    windowsCaptureTimer.current = setTimeout(() => {
      windowsCaptureTimer.current = null;
      setWindowsCaptureScheduled(false);
      void controller.current?.analyzeWindowsActiveTextSurface();
    }, WINDOWS_CAPTURE_DELAY_MS);
  }, []);

  const handleAcceptWindowsNormalized = useCallback(
    async (target: DesktopNormalizedAcceptTarget): Promise<void> => {
      await (
        controller.current?.acceptWindowsNormalized(target) ??
        Promise.resolve("obsolete")
      );
    },
    [],
  );

  const inlineModeEligible =
    assistance.active?.targetKind === "cursor-unit" &&
    textContext.selection === null &&
    textContext.composition === null;
  const inlineItem = inlineModeEligible ? assistance.active : null;
  const inlineStatusMessage = inlineItem?.inlineStatusMessage;
  const primaryInlineVariant =
    inlineStatusMessage === undefined && inlineItem?.status === "completed"
    ? inlineItem.normalizedTracks[0] ?? null
    : null;
  const inlineContentAvailable =
    primaryInlineVariant !== null || inlineStatusMessage !== undefined;
  const inlineContentKey = inlineStatusMessage ?? [
    primaryInlineVariant?.id ?? "none",
    primaryInlineVariant?.text ?? "",
    primaryInlineVariant?.label ?? "",
    primaryInlineVariant?.canAccept === true ? "accept" : "read-only",
  ].join(":");

  const measureInlineAnchor = useCallback((): void => {
    const textarea = editor.current;
    const pane = writingPane.current;
    if (
      textarea === null ||
      pane === null ||
      !inlineModeEligible ||
      textarea.value !== editorText
    ) {
      setInlineAnchor(null);
      return;
    }

    const anchor = measureTextAnchor(
      textarea,
      pane,
      textContext.cursorOffset,
    );
    if (anchor === null || !anchor.visible) {
      setInlineAnchor(null);
      return;
    }
    setInlineAnchor(anchor);
  }, [
    editorText,
    inlineModeEligible,
    measureTextAnchor,
    textContext.cursorOffset,
  ]);

  useLayoutEffect(() => {
    measureInlineAnchor();
  }, [measureInlineAnchor]);

  useEffect(() => {
    if (!inlineModeEligible) {
      return;
    }
    const resize = (): void => measureInlineAnchor();
    globalThis.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(resize);
    if (editor.current !== null) {
      observer?.observe(editor.current);
    }
    if (writingPane.current !== null) {
      observer?.observe(writingPane.current);
    }
    const fonts = editor.current?.ownerDocument.fonts;
    fonts?.addEventListener("loadingdone", resize);
    return () => {
      globalThis.removeEventListener("resize", resize);
      fonts?.removeEventListener("loadingdone", resize);
      observer?.disconnect();
    };
  }, [inlineModeEligible, measureInlineAnchor]);

  const placeInlineCard = useCallback((): void => {
    const anchor = inlineAnchor;
    const pane = writingPane.current;
    const card = inlineCard.current;
    if (
      anchor === null ||
      pane === null ||
      card === null ||
      !inlineContentAvailable
    ) {
      setInlinePosition(null);
      return;
    }
    const cardRect = card.getBoundingClientRect();
    setInlinePosition(calculateTextareaInlinePosition(
      anchor,
      { width: pane.clientWidth, height: pane.clientHeight },
      {
        width: cardRect.width || card.offsetWidth,
        height: cardRect.height || card.offsetHeight,
      },
    ));
  }, [inlineAnchor, inlineContentAvailable]);

  useLayoutEffect(() => {
    if (!inlineContentAvailable || inlineAnchor === null) {
      setInlinePosition(null);
      return;
    }
    placeInlineCard();
    const card = inlineCard.current;
    if (card === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(placeInlineCard);
    observer.observe(card);
    return () => observer.disconnect();
  }, [
    inlineAnchor,
    inlineContentAvailable,
    inlineContentKey,
    placeInlineCard,
  ]);

  const selectionStatus =
    textContext.selection === null
      ? "None"
      : `${textContext.selection.start}–${textContext.selection.end}`;
  const compositionStatus =
    textContext.composition === null
      ? "Inactive"
      : `Active ${textContext.composition.start}–${textContext.composition.end}`;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-eyebrow">Desktop writing workspace</p>
          <h1>Non-native Writing Assistant</h1>
        </div>
        <div className="header-actions">
          {providerSettings.configurationRequired ? (
            <span className="configuration-badge">Configuration required</span>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            Provider settings
          </button>
        </div>
      </header>

      {settingsOpen ? (
        <ProviderSettingsPanel
          settings={providerSettings}
          controller={controller.current}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      <div className="workspace">
        <section
          ref={writingPane}
          className="writing-pane"
          aria-labelledby="writing-heading"
        >
          <div className="pane-heading">
            <div>
              <p className="pane-kicker">Source</p>
              <h2 id="writing-heading">Writing</h2>
            </div>
          </div>
          <label className="sr-only" htmlFor="writing-editor">
            Writing editor
          </label>
          <textarea
            ref={editor}
            id="writing-editor"
            className="writing-editor"
            value={editorText}
            wrap="soft"
            placeholder="Start writing in your target language…"
            spellCheck="true"
            onChange={handleChange}
            onSelect={handleSelection}
            onClick={handleClick}
            onKeyUp={handleKeyUp}
            onCompositionStart={handleCompositionStart}
            onCompositionUpdate={handleCompositionUpdate}
            onCompositionEnd={handleCompositionEnd}
            onScroll={measureInlineAnchor}
          />
          {inlineItem !== null && inlineContentAvailable && inlineAnchor !== null ? (
            <InlineAssistance
              elementRef={inlineCard}
              primaryVariant={primaryInlineVariant}
              statusMessage={inlineStatusMessage}
              position={inlinePosition}
              onAccept={handleAcceptNormalized}
            />
          ) : null}
          <aside className="host-status" aria-label="Editor host status">
            <span>Caret {textContext.cursorOffset}</span>
            <span>Selection {selectionStatus}</span>
            <span>Composition {compositionStatus}</span>
          </aside>
        </section>

        <section className="assistance-pane" aria-labelledby="assistance-heading">
          <div className="pane-heading">
            <div>
              <p className="pane-kicker">Derived tracks</p>
              <h2 id="assistance-heading">Assistance</h2>
            </div>
          </div>

          {assistance.active === null ? (
            <p className="neutral-state">No active writing unit</p>
          ) : (
            <AssistanceItem
              item={assistance.active}
              active
              controller={controller.current}
              onAcceptNormalized={handleAcceptNormalized}
            />
          )}

          <section className="recent-assistance" aria-labelledby="recent-heading">
            <h3 id="recent-heading">Recent Assistance</h3>
            {assistance.recent.length === 0 ? (
              <p className="neutral-state">No recent assistance</p>
            ) : (
              assistance.recent.map((item, index) => (
                <AssistanceItem
                  key={`${item.sourceText}-${index}`}
                  item={item}
                  active={false}
                  controller={null}
                  onAcceptNormalized={null}
                />
              ))
            )}
          </section>
        </section>
      </div>

      <WindowsExternalDevelopmentPanel
        presentation={windowsAssistance}
        captureScheduled={windowsCaptureScheduled}
        onAnalyze={handleAnalyzeWindowsSurface}
        onAccept={handleAcceptWindowsNormalized}
      />
    </main>
  );
}

function WindowsExternalDevelopmentPanel({
  presentation,
  captureScheduled,
  onAnalyze,
  onAccept,
}: {
  readonly presentation: GlobalDesktopAssistantPresentation;
  readonly captureScheduled: boolean;
  readonly onAnalyze: () => void;
  readonly onAccept: (target: DesktopNormalizedAcceptTarget) => Promise<void>;
}) {
  const active = presentation.assistance.active;
  const statusMessage = captureScheduled
    ? "Focus the external Windows text field now; capture starts in 3 seconds."
    : presentation.status === "no-host"
      ? "No supported Windows text field focused"
      : presentation.statusMessage;

  return (
    <section
      className="windows-external-development"
      aria-labelledby="windows-external-heading"
    >
      <div className="windows-external-heading">
        <div>
          <p className="pane-kicker">Experimental manual capture</p>
          <h2 id="windows-external-heading">
            Windows external-host development
          </h2>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={captureScheduled}
          onClick={onAnalyze}
        >
          Analyze focused Windows field
        </button>
      </div>
      <p className="windows-external-instructions">
        Click Analyze, then focus the external text field within three seconds.
        This manual UI Automation path excludes this app and never uses the clipboard
        or simulated typing.
      </p>
      <p className="analysis-status" role="status">{statusMessage}</p>
      <div className="windows-capability-status" aria-label="Windows host capabilities">
        <span>{presentation.hostAvailable ? "Supported host" : "Unavailable host"}</span>
        <span>{presentation.readOnly ? "Read-only" : "Writable"}</span>
        <span>Realtime disabled</span>
      </div>
      {presentation.sourceText === null ? null : (
        <TrackSection heading="External Source" values={[presentation.sourceText]} />
      )}
      {active === null ? null : (
        <>
          <TrackSection
            heading="External Native Intent"
            values={active.nativeIntentTracks.map((track) => track.text)}
          />
          <NormalizedSection
            variants={active.normalizedTracks}
            onAccept={onAccept}
          />
        </>
      )}
    </section>
  );
}

function ProviderSettingsPanel({
  settings,
  controller,
  onClose,
}: {
  readonly settings: DesktopProviderSettingsView;
  readonly controller: DesktopControllerPort | null;
  readonly onClose: () => void;
}) {
  return (
    <aside className="settings-panel" aria-label="Provider settings">
      <div className="settings-heading">
        <div>
          <p className="pane-kicker">Bring your own key</p>
          <h2>Provider settings</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {settings.loading ? <p>Loading provider settings…</p> : null}
      {settings.error === undefined ? null : (
        <p className="settings-error" role="alert">{settings.error}</p>
      )}
      <label className="settings-field">
        <span>Active profile</span>
        <select
          aria-label="Active profile"
          value={settings.activeProfileId ?? ""}
          onChange={(event) =>
            runSettingsAction(
              controller?.setActiveProfile(event.currentTarget.value || null),
            )
          }
        >
          <option value="">None</option>
          {settings.profiles
            .filter((profile) => profile.valid)
            .map((profile) => (
              <option value={profile.id} key={profile.id}>{profile.name}</option>
            ))}
        </select>
      </label>

      <button
        className="primary-button"
        type="button"
        disabled={settings.loading}
        onClick={() => runSettingsAction(controller?.addProfile("openai"))}
      >
        Add Profile
      </button>

      <div className="profile-list">
        {settings.profiles.map((profile) => (
          <ProviderProfileEditor
            key={profile.id}
            profile={profile}
            settings={settings}
            controller={controller}
          />
        ))}
      </div>
    </aside>
  );
}

function ProviderProfileEditor({
  profile,
  settings,
  controller,
}: {
  readonly profile: DesktopProviderProfileView;
  readonly settings: DesktopProviderSettingsView;
  readonly controller: DesktopControllerPort | null;
}) {
  const [secret, setSecret] = useState("");
  const saveCredential = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (secret.length === 0) {
      return;
    }
    try {
      await controller?.saveCredential(profile.id, secret);
      setSecret("");
    } catch {
      // The settings controller presents the safe inline error.
    }
  };

  return (
    <section className="profile-card" aria-label={`Profile ${profile.name}`}>
      <label className="settings-field">
        <span>Profile name</span>
        <input
          aria-label="Profile name"
          value={profile.name}
          onChange={(event) =>
            runSettingsAction(
              controller?.updateProfile(profile.id, {
                name: event.currentTarget.value,
              }),
            )
          }
        />
      </label>
      <label className="settings-field">
        <span>Provider</span>
        <select
          aria-label="Provider"
          value={profile.providerId}
          onChange={(event) =>
            runSettingsAction(
              controller?.updateProfile(profile.id, {
                providerId: event.currentTarget.value,
              }),
            )
          }
        >
          {settings.providers.map((provider) => (
            <option value={provider.id} key={provider.id}>{provider.name}</option>
          ))}
        </select>
      </label>
      <label className="settings-field">
        <span>Model ID</span>
        <input
          aria-label="Model ID"
          value={profile.modelId}
          onChange={(event) =>
            runSettingsAction(
              controller?.updateProfile(profile.id, {
                modelId: event.currentTarget.value,
              }),
            )
          }
          placeholder="Enter any supported model ID"
        />
      </label>
      {isCustomProvider(profile.providerId) ? (
        <>
          <label className="settings-field">
            <span>Base URL</span>
            <input
              aria-label="Base URL"
              value={profile.baseUrl ?? ""}
              onChange={(event) =>
                runSettingsAction(
                  controller?.updateProfile(profile.id, {
                    baseUrl: event.currentTarget.value,
                  }),
                )
              }
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="settings-field">
            <span>Compatibility mode</span>
            <select
              aria-label="Compatibility mode"
              value={profile.compatibilityMode ?? "json-schema"}
              onChange={(event) =>
                runSettingsAction(
                  controller?.updateProfile(profile.id, {
                    compatibilityMode: event.currentTarget.value as NonNullable<
                      DesktopProviderProfileView["compatibilityMode"]
                    >,
                  }),
                )
              }
            >
              {settings.compatibilityModes.map((mode) => (
                <option value={mode} key={mode}>{mode}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <label className="enabled-field">
        <input
          aria-label="Enabled"
          type="checkbox"
          checked={profile.enabled}
          onChange={(event) =>
            runSettingsAction(
              controller?.updateProfile(profile.id, {
                enabled: event.currentTarget.checked,
              }),
            )
          }
        />
        Enabled
      </label>
      {!profile.valid ? (
        <p className="profile-issues">{profile.issues.join(" ")}</p>
      ) : null}

      <form className="credential-form" onSubmit={(event) => void saveCredential(event)}>
        <p className="credential-status">
          API key: {profile.configured ? "Configured" : "Not configured"}
        </p>
        <label className="settings-field">
          <span>{profile.configured ? "Replace credential" : "API key"}</span>
          <input
            aria-label="API key"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        </label>
        <div className="button-row">
          <button className="primary-button" type="submit" disabled={!secret}>
            Save credential
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!profile.configured}
            onClick={() =>
              runSettingsAction(controller?.removeCredential(profile.id))
            }
          >
            Remove credential
          </button>
        </div>
      </form>

      <button
        className="danger-button"
        type="button"
        onClick={() => runSettingsAction(controller?.deleteProfile(profile.id))}
      >
        Delete profile
      </button>
      <p className="delete-note">Deleting this profile keeps its stored credential.</p>
    </section>
  );
}

function runSettingsAction(action: Promise<void> | undefined): void {
  void action?.catch(() => undefined);
}

function AssistanceItem({
  item,
  active,
  controller,
  onAcceptNormalized,
}: {
  readonly item: DesktopAssistanceItem;
  readonly active: boolean;
  readonly controller: DesktopControllerPort | null;
  readonly onAcceptNormalized:
    | ((target: DesktopNormalizedAcceptTarget) => Promise<void>)
    | null;
}) {
  return (
    <article className={`assistance-result${active ? " is-active" : ""}`}>
      <p className="analysis-status" role="status">
        {item.statusMessage}
      </p>
      <TrackSection heading="Source" values={[item.sourceText]} />
      {active && item.nativeIntent !== null ? (
        <NativeIntentEditor
          key={nativeIntentDraftKey(item.nativeIntent)}
          intent={item.nativeIntent}
          controller={controller}
        />
      ) : (
        <TrackSection
          heading="Native Intent"
          values={item.nativeIntentTracks.map((track) => track.text)}
        />
      )}
      {active ? (
        <NormalizedSection
          variants={item.normalizedTracks}
          onAccept={onAcceptNormalized}
        />
      ) : (
        <TrackSection
          heading="Normalized"
          values={item.normalizedTracks.map((track) => track.text)}
        />
      )}
    </article>
  );
}

function NativeIntentEditor({
  intent,
  controller,
}: {
  readonly intent: DesktopNativeIntentPresentation;
  readonly controller: DesktopControllerPort | null;
}) {
  const [draft, setDraft] = useState(intent.text);
  const [boundTarget, setBoundTarget] =
    useState<DesktopNativeIntentTarget>(intent.target);
  const [obsolete, setObsolete] = useState(false);

  const resetDraft = (): void => {
    setDraft(intent.text);
    setBoundTarget(intent.target);
    setObsolete(false);
  };
  const confirm = (): void => {
    const result = controller?.confirmNativeIntent(boundTarget, draft) ?? "obsolete";
    setObsolete(result === "obsolete");
  };

  return (
    <section className="assistance-card native-intent-editor">
      <div className="native-intent-heading">
        <h3>Native Intent</h3>
        {intent.state === "confirmed" ? (
          <span className="confirmed-indicator">Confirmed</span>
        ) : null}
      </div>
      <label className="sr-only" htmlFor="native-intent-draft">
        Native Intent draft
      </label>
      <textarea
        id="native-intent-draft"
        aria-label="Native Intent draft"
        className="native-intent-draft"
        value={draft}
        wrap="soft"
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setObsolete(false);
        }}
      />
      <div className="button-row">
        <button className="primary-button" type="button" onClick={confirm}>
          Confirm
        </button>
        <button className="secondary-button" type="button" onClick={resetDraft}>
          Reset Draft
        </button>
      </div>
      {obsolete ? (
        <p className="intent-draft-message" role="alert">
          This draft belongs to an earlier source. Review the current Native Intent.
        </p>
      ) : null}
    </section>
  );
}

function nativeIntentDraftKey(intent: DesktopNativeIntentPresentation): string {
  const target = intent.target;
  return [
    target.kind,
    target.segmentId,
    target.unitId ?? "selection",
    target.sourceRevision,
    intent.state,
    intent.state === "confirmed" ? target.trackRevision : "inferred",
  ].join(":");
}

function InlineAssistance({
  elementRef,
  primaryVariant,
  statusMessage,
  position,
  onAccept,
}: {
  readonly elementRef: Ref<HTMLElement>;
  readonly primaryVariant: DesktopNormalizedPresentation | null;
  readonly statusMessage: string | undefined;
  readonly position: TextareaInlinePosition | null;
  readonly onAccept: (target: DesktopNormalizedAcceptTarget) => Promise<void>;
}) {
  return (
    <aside
      ref={elementRef}
      className="inline-assistance"
      aria-label="Inline assistance"
      data-placement={position?.placement}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position === null ? "hidden" : undefined,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {primaryVariant !== null ? (
        <>
          <p className="inline-assistance-label">Normalized</p>
          <p className="inline-assistance-text">{primaryVariant.text}</p>
          {primaryVariant.canAccept && primaryVariant.acceptTarget !== null ? (
            <button
              className="primary-button inline-accept"
              type="button"
              aria-label={`Accept inline Normalized variant ${primaryVariant.label ?? 1}`}
              onClick={() =>
                runAcceptAction(onAccept, primaryVariant.acceptTarget)
              }
            >
              Accept
            </button>
          ) : null}
        </>
      ) : (
        <p className="inline-assistance-state" role="status">
          {statusMessage}
        </p>
      )}
    </aside>
  );
}

function NormalizedSection({
  variants,
  onAccept,
}: {
  readonly variants: readonly DesktopNormalizedPresentation[];
  readonly onAccept:
    | ((target: DesktopNormalizedAcceptTarget) => Promise<void>)
    | null;
}) {
  return (
    <section className="assistance-card">
      <h3>Normalized</h3>
      {variants.length === 0 ? (
        <p className="track-placeholder">No analysis yet</p>
      ) : (
        <div className="normalized-variants">
          {variants.map((variant, index) => (
            <div className="normalized-variant" key={variant.id}>
              <p className="track-text">{variant.text}</p>
              <button
                className="primary-button normalized-accept"
                type="button"
                disabled={!variant.canAccept || variant.acceptTarget === null}
                aria-label={`Accept Normalized variant ${variant.label ?? index + 1}`}
                onClick={() =>
                  runAcceptAction(onAccept, variant.acceptTarget)
                }
              >
                Accept
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function runAcceptAction(
  onAccept: ((target: DesktopNormalizedAcceptTarget) => Promise<void>) | null,
  target: DesktopNormalizedAcceptTarget | null,
): void {
  if (target === null) {
    return;
  }
  void onAccept?.(target).catch(() => undefined);
}

function TrackSection({
  heading,
  values,
}: {
  readonly heading: string;
  readonly values: readonly string[];
}) {
  return (
    <section className="assistance-card">
      <h3>{heading}</h3>
      {values.length === 0 ? (
        <p className="track-placeholder">No analysis yet</p>
      ) : (
        values.map((value, index) => (
          <p className="track-text" key={`${heading}-${index}`}>
            {value}
          </p>
        ))
      )}
    </section>
  );
}
