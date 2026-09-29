# AI-Assisted Non-Native Writing Tool

An author-first writing assistant for composing directly in a non-native language. It keeps the user's unfinished source text authoritative while offering optional, inspectable representations of intent and natural target-language expression.

## Development status

The host-independent TypeScript core, asynchronous application orchestration, and the first standalone desktop provider integration are implemented. `apps/desktop-app` is the primary product host and uses Tauri 2, React, TypeScript, Vite, and a native HTML textarea. It captures `TextContext`, applies the shared realtime analysis policies, and renders current Source, Native Intent, Normalized, status, and recent-assistance data.

Desktop BYOK is the production provider path. The settings panel configures OpenAI, Anthropic, Gemini, or an OpenAI-compatible custom endpoint with an open model ID. Non-secret profile metadata is validated and stored in the operating system app-data directory. API credentials are stored separately by the Rust host in the operating system credential store and are represented in metadata only by an opaque `secretRef`; stored credentials are never read back into the settings UI. Existing TypeScript provider adapters still own vendor protocols, while a narrow native HTTPS transport performs their requests. With no valid active profile, the editor remains usable and assistance reports `Configuration required` without making a network request.

`apps/obsidian-plugin` remains a frozen, buildable reference/development host. Its provider-profile mode and host-specific secret storage remain separate; there is no credential migration between hosts. The deterministic desktop provider remains test-only. The desktop active-assistance pane supports revision-checked Native Intent editing and confirmation; drafts remain transient, Source is unchanged, and Normalized regenerates through the current provider profile. Each current Normalized variant can be explicitly accepted into the exact cursor-local writing unit or whole explicit selection that produced it. The controller revalidates source and dependency identity, and the captured textarea edit port performs the final session and exact-text guard before mutation. A compact inline desktop card also shows the primary current cursor-local Normalized result near the textarea caret and reuses the same guarded Accept action; explicit selections, composition, failures, and Recent Assistance remain in the side-panel flow.

Experimental Windows manual global assistance is available through `Ctrl+Alt+Space`. Rust captures the focused external UI Automation text control before showing a small non-focusable, always-on-top assistant window. When the same capture provides reliable UIA text geometry, the window can appear near that external text position; unsupported, offscreen, or ambiguous geometry uses a deterministic screen-corner fallback. The fixed snapshot runs through the existing global controller and active BYOK profile, and the window shows read-only Source, Native Intent, and the first Normalized variant. Protected fields and this app's process are excluded. This is an explicit one-shot action with no promise of universal caret placement: there is no cross-application realtime monitoring, external Accept, clipboard fallback, or simulated input. See [ARCHITECTURE.md](ARCHITECTURE.md#windows-external-host-adapter-v1).

Windows TSF Native Component Prototype v1 now builds that separate development-only x64 in-process COM DLL under [`native/windows-tsf-service`](native/windows-tsf-service/README.md). It exposes the real class-factory and `ITfTextInputProcessorEx` activation surface, observes TSF contexts through bounded read-only edit sessions, and includes a separate explicit elevated registration/rollback tool. Nothing registers or activates during builds, tests, Tauri startup, or pnpm commands. The prototype has no provider, network, IPC, UI, or text-write path, and the working UI Automation assistant remains unchanged. A manual registered-host test is still required to determine whether the keyboard-profile prototype can remain active beside Microsoft Pinyin and observe another IME's composition; the build does not establish that result. See [ARCHITECTURE.md](ARCHITECTURE.md#windows-tsf-native-component-prototype-v1).

## Product roadmap

Correct host behavior, native integration, data safety, and lifecycle guarantees come first. Interaction refinement and customization follow only after those foundations are proven.

- **Advanced input-method experience:** focus assistance on the text being written. Future scope controls may distinguish the current sentence, recent sentences, paragraph, and whole editable surface, while surrounding text serves as reference for intent, terminology, tone, and style. Browser UI Automation can currently mix unrelated page text into a capture; future targeting must distinguish the capture window, actual assistance target, and reference context.
- **AI plus local analysis:** keep the provider architecture working while preserving room for local language rules, terminology, personalized style learning, local models, offline analysis, and local preference adaptation.
- **Custom themes and skins:** leave room for user-controlled typography, spacing, radius, colors, surface styling, layout tokens, and importable themes.
- **Configurable actions:** eventually let users choose and arrange actions such as Analyze, Confirm, Accept, and assistance scope controls.

These are future directions. Assistance Scope, local learning or models, a theme engine, configurable buttons, and shortcut customization are not implemented.

## Desktop development

Install workspace dependencies and start the native desktop shell:

```powershell
pnpm install
pnpm dev:desktop
```

For frontend-only work in a browser:

```powershell
pnpm dev:desktop:frontend
```

The native desktop app requires the Tauri 2 Windows prerequisites: Rust with the MSVC toolchain, Microsoft C++ Build Tools, and WebView2. Frontend validation remains available without that toolchain:

```powershell
pnpm --dir apps/desktop-app test
pnpm --dir apps/desktop-app typecheck
pnpm --dir apps/desktop-app build
```

Desktop provider metadata is written to Tauri's application-data directory as `provider-settings.json`. Credentials use the fixed native service namespace `com.nonnativewriting.assistant.provider-credentials`; they are not stored in this repository, environment files, browser storage, or the metadata JSON.

## Local AI development

The API key belongs only to the gateway process. It must never be placed in Obsidian settings, plugin source, manifests, or build variables. `.env.example` documents the two supported environment names, but the gateway reads them directly from its process environment and does not load `.env` files.

In PowerShell, use two terminals.

Terminal A starts the gateway on `127.0.0.1:8787`:

```powershell
$env:OPENAI_API_KEY="<your key>"
$env:OPENAI_MODEL="gpt-5.6-luna"
pnpm dev:gateway
```

`OPENAI_MODEL` is optional and defaults to `gpt-5.6-luna`.

Terminal B builds the Obsidian plugin with the HTTP development provider:

```powershell
$env:NNWA_ANALYSIS_PROVIDER="http"
pnpm --dir apps/obsidian-plugin build
```

Install or copy the resulting `apps/obsidian-plugin/dist` files into a test Vault using your normal local workflow, then reload the plugin in Obsidian. No Vault path is encoded in this repository. Omit `NNWA_ANALYSIS_PROVIDER` to build the direct provider-profile mode, or set it to `demo` for deterministic development output.

The development endpoint is `POST /v1/analyze`. It accepts source text, native and target language identifiers, and an optional current confirmed native intent. It returns an optional native-intent result plus one or more normalized expressions. For this phase the host uses `zh-CN` as the native language and `en` as the target language.

A production release using the gateway path must replace the localhost URL with an appropriately secured deployment. The development gateway intentionally has no authentication, accounts, persistence, streaming, caching, or deployment configuration and must not be exposed beyond localhost. Direct BYOK profiles persist only a `SecretStorage` reference; resolved API keys remain in Obsidian's secret storage.
