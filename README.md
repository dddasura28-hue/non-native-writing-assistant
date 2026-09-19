# AI-Assisted Non-Native Writing Tool

An author-first writing assistant for composing directly in a non-native language. It keeps the user's unfinished source text authoritative while offering optional, inspectable representations of intent and natural target-language expression.

## Development status

The host-independent TypeScript core, asynchronous application orchestration, and the first standalone desktop shell are implemented. `apps/desktop-app` is the primary planned product host and uses Tauri 2, React, TypeScript, Vite, and a native HTML textarea. It currently validates the standalone window, `TextContext` capture, UTF-16 selection/caret semantics, composition observation, host capabilities, and guarded `TextEditPort` behavior.

The assistance pane deliberately shows neutral Native Intent and Normalized placeholders. Live AI/provider requests, provider settings, Native Intent confirmation, Accept/Replace UI, system-wide capture, persistence, and native input-method bridges remain deferred. The guarded desktop edit adapter is infrastructure only and is not exposed as a product action in this phase.

`apps/obsidian-plugin` remains a frozen, buildable reference/development host. Its provider-profile mode, persistent Obsidian settings, direct OpenAI, Anthropic, Gemini, and OpenAI-compatible BYOK adapters remain unchanged. The deterministic demo provider and local-only OpenAI development gateway remain optional development paths. See [ARCHITECTURE.md](ARCHITECTURE.md#desktop-app-shell-v1).

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

The native command requires the Tauri 2 Windows prerequisites: Rust with the MSVC toolchain, Microsoft C++ Build Tools, and WebView2. Frontend validation remains available without that toolchain:

```powershell
pnpm --dir apps/desktop-app test
pnpm --dir apps/desktop-app typecheck
pnpm --dir apps/desktop-app build
```

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
