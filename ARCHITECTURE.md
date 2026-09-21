# Architecture

## Goals and invariants

The architecture must make the product's authorship rules enforceable rather than relying on UI convention.

1. Source text is the sole source of truth for what is currently written.
2. Processors can propose derived data but cannot directly mutate source text.
3. Applying a suggestion requires an explicit user command and an expected source revision.
4. Core domain code imports neither Obsidian APIs nor a language-model SDK.
5. A derived result is current only while its dependency stamp matches the dependencies that would be used now.
6. Every writing segment has exactly one source track and may have any number of derived tracks.
7. Track types, policies, style attributes, processors, providers, and hosts are extension points.

## Layers

### 1. Core domain

Pure TypeScript containing domain types, invariants, state transitions, version semantics, track definitions, writing segments, policy and style values, and source-application rules. It has no dependency on UI frameworks, host APIs, network clients, storage implementations, or provider SDKs.

### 2. Application and orchestration

Use cases that coordinate sessions, processors, cancellation, policy resolution, style resolution, result validation, and explicit apply commands. This layer depends on the core domain and on abstract ports. It owns orchestration, not host rendering or provider-specific request formats.

### 3. Integration adapters

Implementations of ports for external systems. Provider adapters translate provider-neutral model work into a specific SDK or API. Persistence adapters store settings and session metadata. Host adapters translate host events and edits into application commands. Adapter-specific types stay inside their adapter.

### 4. Host presentation and composition

Each host owns its UI, commands, lifecycle integration, and composition root. The standalone desktop app is the primary planned product host. The Obsidian plugin remains a frozen reference host and development integration. Each host selects concrete adapters, maps track presentation to its own UI, and wires dependencies together without changing the core.

## Dependency rules

Dependencies point inward:

```text
Desktop presentation/composition ──┐
Obsidian presentation/composition ─┼─> application/orchestration ─> core domain
Provider and persistence adapters ─┘
```

- The core domain may depend only on the TypeScript standard language/runtime surface and deliberately chosen host-neutral utilities.
- The application layer may depend on core types and host-neutral port interfaces, never on concrete host or provider implementations.
- No reusable package may import from `apps/*`, including relative paths, re-exports, or dynamic imports. `core` has no external runtime dependencies; `application` depends only on `core`; `model-integration` owns provider/model concerns and its current schema dependency (`zod`). Hosts depend inward on these packages. Dependency-boundary tests enforce these allowlists and reject host/DOM objects in shared source. Standard portable `AbortSignal`/`AbortController` cancellation and `URL` validation remain legitimate; the DOM TypeScript library does not authorize editor/DOM state.
- An adapter may depend on its external SDK and on the port it implements. External SDK objects, errors, and identifiers must be translated at the boundary.
- The composition root is the only place that should know which concrete host, provider, persistence implementation, and processors are active together.
- UI components consume application-facing view data and issue commands. They do not own domain truth or call a model provider directly.
- Core tests must run without Obsidian, a network connection, or provider credentials.

## Track model

A `Track` is a typed representation belonging to a writing segment. The model should use stable string identifiers and track definitions rather than a closed union that forces every new representation into core UI logic. Track definitions may be registered explicitly by the application; this does not require runtime plugin discovery.

Each track needs, conceptually:

- its own stable track instance identifier and a track-type identifier;
- the writing segment to which it belongs;
- content in a track-appropriate host-neutral form;
- a monotonically increasing track revision;
- provenance, including whether content came from the user, a processor, or an apply operation;
- a dependency stamp and processor identity, when derived; and
- domain behavior such as user editability or applicability, supplied by its track definition rather than assumed from its name.

Track cardinality is explicit:

- a writing segment has exactly one source track;
- it may have zero, one, or many instances of any derived track type;
- track type is not a unique key; and
- every instance is addressed by its stable track identifier.

Multiple normalized target-language expressions are therefore ordinary derived track instances and require no change to the domain model.

The source track has special invariants:

- exactly one source track exists for a segment;
- its content reflects text supplied by the host;
- only a host-observed user edit or a successful explicit apply operation can create its next revision; and
- processors have no capability that writes it.

Native intent and normalized expression are initially registered track types. Future explanations, alternatives, terminology, and consistency results use the same track, dependency, and provenance model. Presentation code may provide specialized renderers by track type, but absence of a specialized renderer must not make the core model invalid.

Derived tracks may optionally carry `generationGroupId`, `label`, and `order` metadata. These fields only relate and order outputs produced by the same generation operation. They do not imply a `VariantSet` aggregate or a variant-management framework.

An editable derived track does not become source. Editing native intent changes that track's provenance to user-confirmed, advances its own revision, and records the source revision against which it was confirmed. Downstream processors may use that confirmed intent as a stronger semantic source, and their dependency stamps include its revision.

If the source text subsequently changes and advances the writing segment's source revision, the confirmation becomes stale. A stale confirmed intent must not silently continue to control normalization. A future UI may offer revalidation or reconciliation; the MVP may mark the confirmation stale and regenerate native intent. Staleness is determined from dependency comparison rather than from an independently mutable lifecycle flag.

## WritingSegment model

A `WritingSegment` is the host-neutral unit of versioning, processing, and suggestion application. It should contain or reference:

- a stable segment identifier;
- exactly one required source track;
- zero or more derived tracks, addressed by stable track identifier rather than track type;
- a monotonically increasing source revision;
- enough host-neutral context metadata to order or relate segments when needed; and
- the revisions and dependency information needed to evaluate derived content.

Host positions are mappings, not segment identity. The Obsidian adapter may map a segment to a note and text range, but Obsidian editor positions, vault objects, or file handles must not enter the domain model.

Every source edit advances the source revision and invalidates results that consumed an earlier revision. Editing another input track advances that track's revision and invalidates its downstream dependents. Segment splitting, merging, and identity preservation require explicit domain operations so results cannot accidentally migrate to different text.

## WritingUnit analysis abstraction

A `WritingUnit` is an immutable, host-neutral application-layer value representing a source-mappable fragment within a selected writing segment. It supports incremental analysis, sentence-level assistance, local regeneration, and future explicit Accept/Reject mapping without moving host positions into the domain model.

Each unit contains an ephemeral string identifier, the exact source text it represents, a UTF-16 half-open range relative to the segmented `ContextSelection.activeText`, and a zero-based order within that segmentation result. The range must slice back to the unit text exactly. Units do not contain provider data, AI output, language configuration, host types, or file paths.

Unit identity is stable only within one selection analysis. V1 uses deterministic positional identifiers such as `writing-unit:0`; equality of those ephemeral IDs alone is not evidence that previously analyzed content is still current. Persistent identity across source edits, diff-based relocation tracking, and semantic matching remain intentionally deferred.

The initial `SimpleWritingUnitSegmenter` is deterministic. It includes sentence-ending punctuation (`.`, `!`, `?`, `。`, `！`, and `？`) in the preceding unit and also splits at blank-line paragraph breaks. It retains unfinished text, emits no empty or whitespace-only units, excludes inter-unit sentence whitespace and paragraph separators, and otherwise preserves every character inside each unit range without trimming. It is deliberately language-agnostic and does not attempt abbreviation, decimal, or NLP-aware sentence detection.

Automatic cursor-local timing is classified by a pure application-layer `UnitAnalysisTriggerPolicy`:

```text
cursor-local source change
          ↓
    trigger policy
     ↙          ↘
sentence end   unfinished
  immediate     debounce
```

The v1 sentence-end rule uses the segmenter's existing six terminal characters. Completion triggers are idempotent by unit-source fingerprint within the current selection: repeated synchronization, cursor movement, or following whitespace does not repeatedly trigger the same completed source. Explicit selections and composition-blocked input bypass this automatic cursor-local policy. Manual Analyze remains immediate.

The cursor-local Obsidian path is:

```text
TextContext
  → ContextSelection
  → WritingUnitSegmenter
  → UnitAnalysisManager
  → IncrementalUnitAnalysisCoordinator
  → AnalysisCoordinator (one isolated WritingSegment per unit)
  → provider
```

`IncrementalUnitAnalysisCoordinator` is application-layer orchestration above the existing single-segment `AnalysisCoordinator`; it does not call a provider directly. It keeps a small in-memory record binding each current `WritingUnit`, its isolated `WritingSegment`, exact analysis context, and lifecycle state. Synchronization and currentness evaluation are separate from scheduling. Incremental v1 permits at most one active provider request. Pending work is bounded to one manual target, one latest speculative debounce target, and at most one completion target per unit in the current selection. Completed targets are processed in source order when practical; obsolete source or dependency snapshots are discarded before execution. This is bounded sequential work, not concurrent provider fan-out or durable history.

Non-empty explicit selections retain higher semantic priority and remain one whole-selection analysis target in v1:

```text
TextContext → ContextSelection → WritingSegment → AnalysisCoordinator → provider
```

Runtime unit state and presentation state are separate. A completed unit may remain current in the runtime cache after it stops being the cursor-associated active target. The side panel derives a transient presentation snapshot containing one active unit plus at most three current completed non-active units from the same `ContextSelection`. The active unit is always primary and continues to define Source; a background completion never replaces it.

Recent Assistance is ordered without timestamps: nearest previous units first, then nearest following units for backward cursor navigation. It is bounded presentation, not persistent document history, and ephemeral unit IDs are used only as transient render identities. Removed, failed, source-changed, or dependency-stale units are excluded even if their old results remain cached internally. Configuration changes do not trigger background refresh of stale siblings. Explicit selection keeps the existing whole-selection presentation and hides cursor-unit Recent Assistance; blank contexts and document/context switches likewise expose no prior-context entries.

Existing debounce timing is unchanged for unfinished units, while completed units bypass that delay. The active presentation target is not necessarily the valid in-flight target: a just-completed previous unit may finish and enter its cache while the user is already typing the next unit, causing a presentation refresh without repainting the next unit's generated tracks. Explicit multi-sentence selections are not split into independent analysis or replacement targets.

`WritingUnit`, `UnitAnalysisState`, and tracks have intentionally separate responsibilities:

- a `WritingUnit` is an addressable source region within one selection analysis;
- a `UnitAnalysisState` is an immutable application-layer snapshot of that unit's analysis lifecycle, source revision, explicit unit-source fingerprint when analyzed, and optional provider-neutral `UnitAnalysisResult`; and
- a derived track is generated content with domain provenance and dependency information.

`UnitAnalysisResult` contains native-intent text, ordered normalized text variants, and the producing `DependencyStamp`. It contains no provider response, SDK object, profile, secret, host object, or UI state.

The unit-source fingerprint is a deterministic, non-cryptographic change detector over the exact unit text and its UTF-16 source-range start and end. It answers only whether unit analysis is associated with the same source; it contains no provider, model, policy, native-intent, or UI dependency and is deliberately separate from `DependencyStamp`.

`UnitAnalysisManager` synchronizes lifecycle states by both ephemeral unit ID and unit-source fingerprint. The same ID with the same text and range preserves its immutable state. New units and units whose text or relevant range changed receive fresh idle state with revision `0`, no analyzed-source fingerprint, and no result. Removed units are discarded and duplicate IDs are rejected atomically. Individual immutable replacements are accepted only for a known ID and the currently synchronized source. The manager remains scoped to one active context and performs no persistent identity or semantic matching across edits.

Current unit output requires two independent checks:

1. the state's unit-source fingerprint must match the current unit text and relative UTF-16 range; and
2. the result's complete producing `DependencyStamp` must match the effective stamp that would be used now, including source revision, confirmed intent when applicable, assistance policy, style profile, language, processor/provider configuration, source location, and exact effective surrounding context.

Source invalidation and dependency invalidation are intentionally different. If a unit's own source fingerprint changes, its older result is discarded and the unit resets to idle for the new source. If the source is unchanged but the exact context or another dependency changes, the older result is retained internally in `stale` state but is neither current nor presentable. A stale unit is not automatically scheduled: only the active target is eagerly refreshed under the existing debounce, while stale siblings remain dormant until they become active. The same lazy rule applies to profile and configuration changes, balancing semantic correctness, latency, and API cost.

When a stale unit becomes active, it transitions through analyzing to completed and replaces the stored result and producing stamp. Cancellation stops obsolete active work where possible, while the final unit-source fingerprint and full `DependencyStamp` comparison remain authoritative against late completion. Cursor movement alone does not cancel a still-valid unit request. Source, effective context, configuration, document/session, or explicit cancellation changes do cancel affected work; a cancelled transport continues to occupy the single-flight slot until it settles so provider concurrency cannot fan out.

Incremental per-unit semantic context is intentionally causal. `beforeContext` contains outer `ContextSelection.beforeContext` plus earlier same-block text. `afterContext` contains only outer `ContextSelection.afterContext`; later text in the active block is excluded. Consequently, later typing does not invalidate already completed earlier units, while editing earlier text may invalidate later units whose exact before-context fingerprint changes. This direction supports realtime stability, predictable invalidation, lower latency, and controlled API cost without weakening full `DependencyStamp` comparison. Only `unit.text` becomes `sourceText`, and unit ranges remain relative to `ContextSelection.activeText`; adding `ContextSelection.sourceRange.start` maps them to host-source offsets.

Each unit's confirmed native intent remains isolated in that unit's `WritingSegment`. Its existing source-revision semantics invalidate the confirmation when that unit source changes; intent is never shared across unit segments. Explicit-selection fallback retains the existing whole-selection behavior.

Persistent unit identity, diff-based relocation, semantic matching, adaptive debounce, phrase-level triggers, abbreviation-aware segmentation, concurrency fan-out, streaming, persistent unit history, inline editor assistance, source navigation, and replacement behavior remain deferred.

## State ownership

Domain content consists of source tracks, derived tracks, provenance, revisions, and dependency information. These concepts express what was written or derived and the inputs on which derived content depends.

Session and application state includes:

- which tracks are visible;
- the current `AssistPolicy`;
- the current `StyleProfile`;
- language configuration;
- pending analysis runs;
- errors; and
- loading state.

Visibility is therefore not a property of track content, and pending or failed runs are not persistent track lifecycle states. The application may group session state into small context values as useful. It should not introduce a large `WritingSession` aggregate unless implementation experience demonstrates a concrete need for one.

## AssistPolicy concept

The UI may expose a small assistance-strength control, but each choice resolves to an `AssistPolicy` snapshot. A policy is configuration, not a numeric branch repeated throughout the codebase.

A policy may define:

- enabled processors and their ordering or dependency constraints;
- automatic, debounced, on-demand, or apply-triggered execution;
- eligible input and output track types;
- context scope and resource limits;
- confidence or ambiguity behavior;
- whether a hidden track may still be computed; and
- processor-specific settings through validated extension data.

Runs include the policy identity and revision in their dependency stamp when policy affects the result. Changing to an incompatible policy cancels or invalidates affected work. Policy resolution belongs in the application layer; provider adapters receive already-resolved work and do not interpret UI assistance levels.

## StyleProfile concept

A `StyleProfile` is a structured, versioned, extensible value describing desired target-language expression. It is not a single enum and must not be stored only as prompt prose.

The initial schema can cover tone, register, and verbosity. It should allow later attributes such as audience, genre, locale conventions, organization rules, terminology constraints, examples, and custom extensions. Profiles may be named and reusable, with explicit inheritance or overrides if those features are later introduced.

Processors consume the semantic profile and decide which attributes are relevant to their task. Provider-specific prompt formatting stays in the processor/provider integration path. A run includes the resolved style-profile identity and revision in its dependency stamp when the profile affects that result.

## Provider abstraction

The application exposes a minimal provider-neutral language-model port. Its initial contract should support a structured request, cancellation through an `AbortSignal` or equivalent host-neutral signal, and a normalized response or normalized failure.

The boundary must not expose provider SDK message classes, client objects, usage objects, or error types. A provider adapter is responsible for authentication, request translation, response parsing, rate-limit translation, and provider-specific error handling.

Processors depend on the neutral port when they require model work. The composition root selects the provider adapter for the MVP; capability-based provider routing is deferred. Neither providers nor processors receive direct access to a host editor, so a model response cannot bypass the explicit apply use case.

### Provider profiles and direct integrations

Provider selection is host/infrastructure configuration, not core domain state. A `ProviderProfile` has stable profile identity, a distinct provider identifier, an open-string model identifier, a reference to a separately stored secret, optional connection configuration such as a base URL, and an enabled state. It never contains a resolved API key. Profile settings may contain zero or more profiles and one optional active profile identifier.

Host persistence may retain incomplete profile drafts so users can finish or repair them, but the runtime provider source exposes only profiles that are valid and enabled for analysis. The Obsidian host persists the profile fields and active profile ID with `loadData`/`saveData`, while the referenced credential remains exclusively in `SecretStorage`. Its settings tab and writing-view selector share one host-owned profile source; neither view owns a second copy of provider state.

The direct bring-your-own-key integration uses a small static provider registry. Each registered writing-model adapter translates one provider-neutral writing request into an explicit vendor HTTP contract and normalizes the response into the shared writing-model result. Adding a vendor means implementing and registering an adapter; it does not change core or application types. Runtime adapter discovery, capability negotiation, automatic routing, retries, and fallback chains remain deferred.

The active profile is resolved for every analysis request. Changing only `activeProfileId` is sufficient to change the provider/model used by the next request; it does not rebuild writing segments, the coordinator, or core domain objects. Relevant profile properties, including provider ID, model ID, base URL, compatibility mode, and secret reference, contribute to the existing processor-configuration fingerprint. Resolved secret values never do. A host profile-settings change updates the coordinator's current configuration so an in-flight result with the old profile fingerprint is rejected by normal `DependencyStamp` comparison.

Secret resolution and HTTP transport are small host-boundary ports. The Obsidian implementation resolves `secretRef` through `SecretStorage` and sends direct requests through `requestUrl`; neither Obsidian type crosses into the shared adapter layer. Because `requestUrl` does not expose cooperative abort, the adapter checks cancellation before and after transport. Cancellation remains an optimization, while dependency comparison and latest-request checks remain the correctness mechanisms.

The localhost OpenAI development gateway remains an optional provider path. It may use a server SDK internally, but it should share the provider-neutral writing request, semantic prompt, and result validator where practical so direct adapters and the gateway do not drift.

## Processor abstraction

A processor is a composable unit with:

- a stable processor identifier and version;
- declared input track types and other required context;
- declared output track or diagnostic types;
- an execution method receiving an immutable, versioned input snapshot and cancellation signal; and
- a result containing zero or more output track instances, provenance, a dependency stamp, and normalized diagnostics.

Processors may be deterministic, rule-based, or model-backed. Model-backed processors use the provider port; deterministic processors need not know it exists. The MVP orchestrator runs a small explicitly ordered pipeline and may skip a processor when its required inputs are unavailable, failed, or stale. A generic DAG scheduler is not required.

Native-intent inference and target-language normalization should begin as separate processors, even if an early implementation optimizes some provider calls. Future capabilities should normally be added as processors or processor compositions rather than appended to one expanding prompt. Any optimization that combines calls must preserve distinct outputs, provenance, version checks, and replaceable processor boundaries.

No processor may modify source text. A processor emits tracks, diagnostics, or suggestions only.

## Diagnostics and ranges

A diagnostic is a host-neutral processor output. It may be represented as derived track content or as application-facing diagnostic data, depending on the use case, but its payload should support:

- a category or type;
- a message;
- an optional segment-relative range;
- an optional suggested replacement; and
- an optional severity.

A segment-relative range conceptually contains a start offset and an end offset measured within the source text of a particular writing segment revision. Offsets use UTF-16 code units and ranges are half-open: `[start, end)`. Implementations must validate that the range is ordered and within that segment. The exact TypeScript shape is intentionally deferred.

Host adapters map segment-relative ranges to their editor or document positions. Host editor positions and range types must not enter core diagnostic data.

## DependencyStamp

A `DependencyStamp` is a compact description of the input snapshot that produced derived content. It includes only dependencies relevant to that result, such as:

- source revision;
- confirmed native-intent revision, when applicable;
- assist-policy identity and revision;
- style-profile identity and revision;
- relevant language configuration; and
- relevant processor configuration; and
- the selected source location and effective surrounding-context fingerprint.

Implementations may represent some configuration dependencies with a stable identity, revision, or compact fingerprint. The architecture does not require a large version object with a separate field for every possible setting.

The context fingerprint is a compact deterministic change detector, not a security hash. Raw surrounding-context strings belong in the transient analysis snapshot/request and are not persisted in domain tracks merely to establish currentness.

The invariant is: a derived result may be treated as current only if its dependency stamp still matches the dependencies that would be used to produce that result now. The application owns this comparison and applies the same rule to every processor result.

## Async and versioning principles

Correctness is based on immutable snapshots and dependency-stamp comparison, not completion order.

1. Before a run starts, the application snapshots the inputs and configuration the processor will consume and creates the corresponding dependency stamp.
2. The run receives a unique identifier and a cancellation signal.
3. Superseding source or input edits, incompatible settings changes, session closure, and explicit user cancellation signal that affected work should stop.
4. Cancellation is an optimization, not the correctness mechanism. Providers may finish after cancellation.
5. When a result returns, the application compares its dependency stamp with the dependencies that would be used now. A mismatch makes the result stale; it must not replace or be presented as current derived content.
6. Accepted results update only their declared output tracks and retain provenance sufficient for later validation and debugging.
7. Applying a suggestion uses optimistic concurrency: the command includes the source revision it was reviewed against and fails safely if the current revision differs.

Debouncing and limited concurrent execution may improve responsiveness, but neither may weaken these checks. Any future caching or streaming design must preserve the same dependency-stamp acceptance rule.

## Host adapter principle

The host is an environment in which the product runs, not part of the product's domain definition. “Host adapter” names this architectural boundary; it does not require one giant interface. A future implementation may expose small ports for source observation, edit application, persistence, and presentation integration without defining all of those interfaces in advance.

Obsidian is the reference document host, not the definition of the product. The host-independent writing engine must also support text-input-session hosts that may have no file or document path, expose only limited surrounding text, and provide cursor, selection, or IME composition state. A host supplies an immutable `TextContext` describing the text currently available—not necessarily a complete document—and an application-owned `ContextSelector` chooses the active text before it enters the existing writing-segment and analysis flow.

The portable flow is `TextContext` → `ContextSelector` → `ContextSelection`. A `ContextSelection` distinguishes source-mappable `activeText`, which is the only text eligible for normalization or future replacement, from read-only `beforeContext` and `afterContext`, which may influence generation but are never implicitly part of the replacement target. Its UTF-16 source range must slice back to exactly `activeText`; the host/application boundary retains that mapping for a future explicit Accept/Replace flow without moving host editor positions into core.

Across those ports, the host integration is responsible as needed for:

- reading source snapshots and observing user edits;
- mapping host text ranges to stable application segment identifiers;
- applying an explicit, revision-checked edit through the host's undoable editing mechanism;
- presenting track state and accepting user commands;
- storing settings and minimal session metadata; and
- reporting lifecycle events such as document changes or session closure.

The first adapter may use Obsidian editor, vault, workspace, and plugin APIs internally. Those types stop at the adapter boundary. The same application use cases should be reusable by browser, VS Code, or desktop adapters with different text and storage mechanics.

The Obsidian host observes only its supported public events and APIs. A cursor-only move to another block may therefore become visible on the next source edit, manual Analyze command, or other existing synchronization event; accessing CodeMirror internals solely to observe cursor movement is deferred.

An apply flow crosses the boundary in a controlled sequence: the application validates the suggestion and expected revision, requests a specific edit from the host adapter, receives the resulting source snapshot, and records that snapshot as the new source revision. Failures leave source state unchanged and are reported to the user.

## MVP simplification rules

The MVP should not initially implement:

- a generic DAG scheduler;
- runtime processor plugin discovery;
- provider capability routing;
- provider caching infrastructure;
- streaming architecture; or
- complex variant-management aggregates.

It should begin with:

- a small ordered processor pipeline;
- a minimal provider abstraction;
- stable track type identifiers; and
- explicit dependency checks using compact dependency stamps.

These deferrals reduce framework code without closing the extension points described above. Later functionality should be added when a demonstrated requirement justifies the additional mechanism.

## Testing implications

- Domain tests cover source authority, track cardinality, track revisions, provenance, confirmed-intent invalidation, dependency stamps, and apply preconditions.
- Application tests use fake hosts, providers, clocks, and processors to cover cancellation, out-of-order completion, stale results, policy changes, multiple derived tracks of one type, and ordered processor composition.
- Adapter contract tests verify translation at provider and host boundaries without making core tests integration-dependent.
- Host UI tests verify that suggestions require a deliberate action and that stale or failed states are visible, but UI tests do not replace domain invariant tests.

## Product Host Boundary v1

The shared engine is `packages/core`, `packages/application`, and `packages/model-integration`. It operates on text-input sessions, without requiring files, Markdown, persistent documents, editor leaves, DOM elements, or host editor APIs.

Host direction:

- `apps/obsidian-plugin`: buildable, tested reference host / development integration, with no new product features in this phase.
- `apps/desktop-app`: primary standalone product host. Desktop App Shell v1 creates its Tauri/React runtime, native textarea host, context capture, capabilities, and guarded edit infrastructure. Desktop Engine Integration v1 composes that host with the existing realtime unit-analysis flow. Desktop BYOK & Secret Storage v1 supplies the production provider composition and native credential/HTTP boundaries. User-facing application of suggestions remains a later phase.
- Future Windows text-input / TSF and macOS input-method bridges: separate platform-specific hosts. Each owns text/composition capture, cursor/selection handling, lifecycle, and replacement/commit behavior. Reuse the writing engine, not a single native implementation across operating systems. TSF/InputMethodKit abstractions do not belong in core/application.

### Snapshot and technical capabilities

`TextContext` remains the canonical immutable snapshot: available text, UTF-16 cursor offset, normalized selection, and optional composition. Available text may be a small surrounding-text window with no persistent document. Offsets are relative to that exact window; shifting the window changes the mapping even if its text is identical. No duplicate TextInputSession aggregate is introduced.

`HostCapabilities` contains four readonly booleans: `canReplaceText`, `canObserveComposition`, `canObserveSelection`, and `canProvideSurroundingText`. Its factory copies only these fields and freezes the value. These describe technical facilities, not permissions, provider features, UI availability, or proof that a particular edit is safe. A host unable to observe composition must not claim that null composition proves input has committed.

### Capture, analysis, presentation, and future editing

`Host -> capture TextContext -> ContextSelector -> WritingUnit / analysis -> presentation/result -> optional guarded edit after explicit user action`.

A host may disappear or change between any stages. Keep existing DependencyStamp checks, source ranges, source fingerprints, cancellation, and latest-run checks. All result/presentation writes must remain currentness-checked; a future source write additionally requires the host to verify currentness at commit.

`TextReplacement` is a frozen value containing a frozen UTF-16 half-open `range`, exact `expectedText`, and `replacementText`. Its factory validates the range against captured `TextContext.text` and requires the slice to equal expectedText without trimming, normalization, relocation, or merging. Empty ranges permit insertion; empty replacement text permits deletion. Unit ranges must first be mapped using the existing selection source range; before/after semantic context is never a replacement target.

`TextEditPort.replace(replacement): Promise<void> | void` is a contract only. A future host supplies a port bound to one captured session, revision, and available-text window. It must not route to whatever editor is active later. The host atomically verifies session availability/identity, unchanged revision/window, composition safety, and exact expectedText before its undoable edit. Any failure (including inability to guarantee atomicity) throws/rejects without mutation; async adapters recheck at commit after awaits. Successful edits invalidate the captured port. A matching slice alone cannot prove the same session or catch edit-and-revert; host revision/lifecycle checks are mandatory. This phase implements only data validation and a test fake, not Accept/Replace behavior.

No shared HostSessionId is needed now: application already uses transient segment IDs, request tokens, and coordinator lifetimes. Hosts own session binding and must cancel/clear or replace orchestration on session changes; a fake proves this with an opaque Symbol and revision, without a file path. Obsidian document keys remain inside its adapter/controller. Do not persist them in shared state or use text/fingerprint equality as session identity.

### Composition policy

Uncommitted composing text must not be treated as ordinary committed writing input unless explicitly supported by a future policy. Existing selectors block overlapping active ranges (including zero-width composition) and omit composing neighboring blocks; the realtime trigger policy respects composition blocking. A composition-capable host recaptures text after commit before scheduling ordinary analysis. Obsidian currently lacks public composition capture in its adapter; platform composition APIs and changes to its observation behavior are deferred.

### Audit and phase limits

The reusable-package audit found no inappropriate host/document dependencies to remove. Core IDs/revisions and ranges are generic. Application blank-line blocks and sentence punctuation are plain-text policies, not Markdown parsing. Model integration owns provider prompts, profiles, secret-resolution and transport ports; URLs and cancellation are portable, and no editor, storage implementation, or host SDK crosses those ports. The Obsidian controller owns document/run routing; application currentness remains based on shared snapshots and stamps. Provider/BYOK behavior is unchanged.

That completed boundary phase deliberately deferred Tauri creation, desktop UI, framework selection, Accept/Replace runtime, global hotkeys, clipboard integration, accessibility APIs, Windows TSF, macOS InputMethodKit, browser extensions, mobile keyboards, accounts/cloud sync, updater/installer, and diff/merge conflict resolution. Desktop App Shell v1 implements the initial host runtime and Desktop Engine Integration v1 connects its editor to existing analysis orchestration; the other items remain deferred.

## Desktop App Shell v1

`apps/desktop-app` is a pnpm workspace package using React, TypeScript, Vite, and Tauri 2. It is an outer host: the frontend imports reusable application contracts, while React, browser DOM access, textarea state, and Tauri configuration remain inside the app. The Rust layer creates the native window and owns fixed-purpose storage, credential, and HTTP commands; it contains no writing-engine types or provider protocols.

The desktop text host captures the textarea's full current value, normalized selection, active caret, and observable composition as a `TextContext`. HTML textarea offsets are already UTF-16 code-unit offsets. For a backward selection, `selectionStart` is the active caret; for forward or directionless selections, `selectionEnd` is the deterministic active caret. The normalized `TextContext.selection` remains ordered independently of that direction.

Composition events are tracked at the host. When current event data maps exactly into the textarea value at the observed composition origin, the adapter emits that exact half-open range. During browser event-order transitions where the value does not confirm the event data, it emits a zero-width composition marker at the current observed caret with empty composition text. This conservatively blocks ordinary analysis without fabricating a range. `compositionend` clears the marker and causes a committed context recapture.

The desktop host advertises replacement, composition observation, selection observation, and surrounding-text access. Its `TextEditPort` adapter is bound to one textarea element, opaque process-local session token, and generation. Text mutations, composition transitions, session changes, and successful edits invalidate captured state. A replacement validates composition safety, session/generation currentness, the exact captured text, range, and `expectedText` before using the textarea's native range replacement. Success places the caret after the inserted text, invalidates the one-shot port, and emits a fresh `TextContext`. Desktop Shell v1 intentionally exposes no Accept/Replace control.

The Tauri capability for the main window has an empty permission list. Desktop Shell v1 adds no plugin permissions, filesystem, shell, process, clipboard, or generic remote-network API.

## Desktop Engine Integration v1

The desktop composition root lives under `apps/desktop-app/src/controller`. It supplies a host-local deterministic `AnalysisProvider` to the existing `AnalysisCoordinator`, then composes `LocalBlockContextSelector`, `SimpleWritingUnitSegmenter`, `SentenceUnitAnalysisTriggerPolicy`, and `IncrementalUnitAnalysisCoordinator`. React receives only immutable desktop presentation data and sends freshly captured `TextContext` values to the controller; it does not schedule provider work or interpret coordinator state.

Unfinished cursor-local units use the shared 700 ms debounce, while `.`, `!`, `?`, `。`, `！`, and `？` trigger immediate completion analysis. Commas and semicolons have no completion role. Cursor navigation selects cached current unit results without a provider call and exposes up to three other current completed units as recent assistance. Explicit selections remain one whole analysis target and hide unit history while active. Their initial analysis is explicit; after a confirmed intent exists, context or provider changes immediately regenerate that target.

Any observed composition, including a zero-width uncertainty marker, suspends desktop automatic analysis and presents no composing result. Commit recaptures the textarea before ordinary scheduling resumes. Source fingerprints, complete dependency stamps, cancellation, and controller lifecycle generations prevent stale or late work from becoming visible. The source textarea remains the sole authority and this phase has no source-application action.

The deterministic provider remains isolated for controller tests and is not selected by the production composition root. The Obsidian provider integrations are unchanged.

## Native Intent Confirmation v1

Confirmation reuses the existing `WritingSegment`, native-intent track, `user-edited-model` provenance, source revision, `AnalysisSnapshot.confirmedNativeIntent`, and `DependencyStamp.confirmedNativeIntentRevision`. `WritingSegment.confirmNativeIntent` replaces an inferred native-intent track at the same identity only when the expected source and track revisions still match. The operation preserves the source track byte-for-byte, advances only the intent revision, and records the current source revision. No desktop-specific intent aggregate or persistence store exists.

The shared unit presentation translates tracks into an explicit inferred/confirmed Native Intent state. A valid confirmed track always wins over later model-inferred intent in presentation. Model output remains available for normalization, but cannot overwrite the user's semantic checkpoint. Each cursor-local `WritingUnit` owns an isolated `WritingSegment`; an explicit selection owns one whole direct segment. Confirmation cannot cross segment, unit, selection, or source-revision boundaries.

React owns only the unconfirmed textarea draft. Its component identity contains the opaque segment identity, unit or selection identity, source revision, and confirmed revision when applicable. The component captures the target that initialized the draft, so background presentation changes cannot silently rebind a user's edit. Switching targets or clearing the active session unmounts and discards the draft. Reset restores the current presentation value and rebinds to its current target. Draft text is never normalized, logged, or persisted.

The desktop controller validates the captured target and calls the domain operation. Once confirmation succeeds, it presents the checkpoint immediately and starts a manual-priority analysis without the normal debounce. The existing snapshot path supplies the exact text to `DesktopProfiledAnalysisProvider` and every vendor adapter through the common `WritingModelRequest`. Cancellation and full dependency-stamp comparison reject pre-confirmation results. A provider failure changes generated-output status only; the confirmed track remains available for retry.

Source changes create or advance the target's source state and therefore invalidate the old confirmation. Context-only changes keep the same source-bound confirmation but stale generated results through the context fingerprint. Provider or model changes behave the same way through the processor configuration fingerprint. The active target regenerates with the preserved confirmation and new dependencies. Recent Assistance may display confirmed intent but exposes no edit actions. A separate clear-confirmation action and persistent intent/draft history are deferred.

## Desktop BYOK & Secret Storage v1

The desktop composition root builds `DesktopProfiledAnalysisProvider` over the existing `ProviderRegistry` and four reusable TypeScript adapters. The writing engine and `AnalysisCoordinator` still see only `AnalysisProvider`. React sees a desktop settings port and immutable non-secret presentation; it never calls an adapter, native HTTP command, or `SecretResolver` directly. Obsidian remains a separate reference host and none of its host-specific provider or settings code is imported.

`DesktopProviderProfileStore` validates loaded metadata with the shared provider contracts and persists it through one fixed-purpose Tauri command to `provider-settings.json` in Tauri's application-data directory. Its schema contains profile ID, name, provider/model IDs, `secretRef`, optional base URL and compatibility mode, enabled state, and active profile ID. Malformed data becomes a safe empty configuration. Profile deletion and credential deletion are separate operations. Writing-unit results, recent assistance, and requests remain session-local.

The Rust secret commands use `keyring` with the fixed service namespace `com.nonnativewriting.assistant.provider-credentials`. On Windows, keyring's native backend uses Windows Credential Manager. React can set, query presence, or explicitly delete only a validated opaque `secretRef`; only `DesktopSecretResolver` retrieves a value for an analysis request. There is no credential enumeration, caller-supplied service name, plaintext vault, browser persistence, or stored-key display.

Vendor request construction and response parsing remain in `packages/model-integration`. `DesktopHttpTransport` forwards their transport request to a fixed Rust command. Rust independently reloads the persisted active profile and permits only its configured origin and base path, requires HTTPS except for exact loopback HTTP, disables redirects, retains normal TLS verification, and returns only status, headers, and body. It contains no provider protocol logic and invokes no shell process. Abort checks remain before and after the native call; dependency stamps and latest-request checks remain the correctness boundary when an in-flight native request cannot be cancelled.

The Tauri capability continues to grant an empty permission list. These native operations are application-owned commands registered directly by the Rust builder, so no filesystem, shell, process, clipboard, or broad HTTP plugin capability is exposed. A profile/model switch persists first, changes the processor fingerprint, cancels or stales obsolete analysis, removes incompatible presentation immediately, and refreshes the current target under the existing immediate/debounce policy.
