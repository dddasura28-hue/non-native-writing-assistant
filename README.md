# AI-Assisted Non-Native Writing Tool

An author-first writing assistant for composing directly in a non-native language. It keeps the user's unfinished source text authoritative while offering optional, inspectable representations of intent and natural target-language expression.

## Development status

The host-independent TypeScript core, asynchronous application orchestration, and initial Obsidian side-panel host are implemented. The plugin defaults to provider-profile mode, with persistent Obsidian settings and direct OpenAI, Anthropic, Gemini, and OpenAI-compatible BYOK adapters. The deterministic demo provider and local-only OpenAI development gateway remain optional development paths.

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
