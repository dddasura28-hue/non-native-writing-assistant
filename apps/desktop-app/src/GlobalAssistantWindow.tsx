import { useEffect, useState } from "react";

import {
  TauriWindowsGlobalShortcutBridge,
  presentationForCapturedShortcut,
  type FloatingAssistantPresentation,
  type WindowsGlobalShortcutBridge,
} from "./native/windows-global-shortcut-bridge.js";

export interface GlobalAssistantWindowProps {
  readonly createBridge?: () => WindowsGlobalShortcutBridge;
}

export function GlobalAssistantWindow({
  createBridge = () => new TauriWindowsGlobalShortcutBridge(),
}: GlobalAssistantWindowProps) {
  const [bridge] = useState(createBridge);
  const [presentation, setPresentation] =
    useState<FloatingAssistantPresentation | null>(null);

  useEffect(() => {
    document.body.classList.add("global-assistant-body");
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const update = (next: FloatingAssistantPresentation): void => {
      if (disposed) {
        return;
      }
      setPresentation((current) => {
        if (current === null || next.invocationId > current.invocationId) {
          return next;
        }
        if (
          next.invocationId === current.invocationId &&
          statusRank(next) >= statusRank(current)
        ) {
          return next;
        }
        return current;
      });
    };

    void bridge.listenForCaptures((event) => {
      update(presentationForCapturedShortcut(event));
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten.push(stop);
      }
    }).catch(() => undefined);
    void bridge.listenForPresentations(update).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten.push(stop);
      }
    }).catch(() => undefined);

    return () => {
      disposed = true;
      for (const stop of unlisten) {
        stop();
      }
      document.body.classList.remove("global-assistant-body");
    };
  }, [bridge]);

  return (
    <main className="global-assistant-shell" aria-label="Global writing assistance">
      <header className="global-assistant-header">
        <div>
          <p className="app-eyebrow">Manual Windows assistance</p>
          <h1>Writing Assistance</h1>
        </div>
        <span className="read-only-badge">Read-only</span>
      </header>
      <p className="global-assistant-status" role="status">
        {presentation?.statusMessage ?? "Press Ctrl+Alt+Space in a text field."}
      </p>
      {presentation?.sourceText ? (
        <section className="global-assistant-section is-source">
          <h2>Source</h2>
          <p>{presentation.sourceText}</p>
        </section>
      ) : null}
      {presentation?.nativeIntentText ? (
        <section className="global-assistant-section">
          <h2>Native Intent</h2>
          <p>{presentation.nativeIntentText}</p>
        </section>
      ) : null}
      {presentation?.normalizedText ? (
        <section className="global-assistant-section">
          <h2>Normalized</h2>
          <p>{presentation.normalizedText}</p>
        </section>
      ) : null}
    </main>
  );
}

function statusRank(presentation: FloatingAssistantPresentation): number {
  return presentation.status === "analyzing" ? 0 : 1;
}
