import {
  createTextContext,
  type TextContext,
  type TextEditPort,
} from "@non-native-writing/application";
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type SyntheticEvent,
} from "react";

import {
  TextareaCompositionTracker,
  captureTextareaTextContext,
} from "./host/textarea-text-context-adapter.js";
import {
  createCapturedTextareaEditPort,
  type TextareaSessionState,
} from "./host/textarea-text-edit-port.js";

const EMPTY_CONTEXT = createTextContext({
  text: "",
  cursorOffset: 0,
  selection: null,
  composition: null,
});

export function App() {
  const [editorText, setEditorText] = useState("");
  const [textContext, setTextContext] =
    useState<TextContext>(EMPTY_CONTEXT);
  const sessionToken = useRef(Symbol("desktop-textarea-session"));
  const generation = useRef(0);
  const composition = useRef(new TextareaCompositionTracker());
  const capturedEditPort = useRef<TextEditPort | null>(null);

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

      const context = captureTextareaTextContext(
        textarea,
        composition.current.capture(textarea),
      );
      const capturedSession = currentSession();

      capturedEditPort.current = createCapturedTextareaEditPort({
        target: textarea,
        context,
        session: capturedSession,
        getCurrentSession: currentSession,
        onDidReplace: (freshContext) => {
          generation.current += 1;
          setEditorText(freshContext.text);
          setTextContext(freshContext);
        },
      });
      setTextContext(context);
    },
    [currentSession],
  );

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setEditorText(event.currentTarget.value);
    capture(event.currentTarget, true);
  };

  const handleSelection = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
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
      </header>

      <div className="workspace">
        <section className="writing-pane" aria-labelledby="writing-heading">
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
            id="writing-editor"
            className="writing-editor"
            value={editorText}
            wrap="soft"
            placeholder="Start writing in your target language…"
            spellCheck="true"
            onChange={handleChange}
            onSelect={handleSelection}
            onCompositionStart={handleCompositionStart}
            onCompositionUpdate={handleCompositionUpdate}
            onCompositionEnd={handleCompositionEnd}
          />
          <aside className="host-status" aria-label="Editor host status">
            <span>Caret {textContext.cursorOffset}</span>
            <span>Selection {selectionStatus}</span>
            <span>Composition {compositionStatus}</span>
          </aside>
        </section>

        <section
          className="assistance-pane"
          aria-labelledby="assistance-heading"
        >
          <div className="pane-heading">
            <div>
              <p className="pane-kicker">Derived tracks</p>
              <h2 id="assistance-heading">Assistance</h2>
            </div>
          </div>

          <article
            className="assistance-card"
            aria-labelledby="native-intent-heading"
          >
            <h3 id="native-intent-heading">Native Intent</h3>
            <p>No analysis yet</p>
          </article>

          <article
            className="assistance-card"
            aria-labelledby="normalized-heading"
          >
            <h3 id="normalized-heading">Normalized</h3>
            <p>No analysis yet</p>
          </article>
        </section>
      </div>
    </main>
  );
}
