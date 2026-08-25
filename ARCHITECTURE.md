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

The Obsidian plugin UI, commands, lifecycle integration, and composition root. This layer selects concrete adapters, maps track presentation to Obsidian views, and wires dependencies together. Future hosts provide their own presentation and composition without changing the core.

## Dependency rules

Dependencies point inward:

```text
Obsidian presentation/composition ─┐
Provider and persistence adapters ─┼─> application/orchestration ─> core domain
Future host adapters ──────────────┘
```

- The core domain may depend only on the TypeScript standard language/runtime surface and deliberately chosen host-neutral utilities.
- The application layer may depend on core types and port interfaces, never on concrete Obsidian or provider implementations.
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

A `WritingUnit` is an immutable, host-neutral application-layer value representing a source-mappable fragment within a selected writing segment. It exists to prepare for future incremental analysis, sentence-level assistance, local regeneration, and explicit Accept/Reject mapping without moving those behaviors into the current MVP flow.

Each unit contains an ephemeral string identifier, the exact source text it represents, a UTF-16 half-open range relative to the segmented `ContextSelection.activeText`, and a zero-based order within that segmentation result. The range must slice back to the unit text exactly. Units do not contain provider data, AI output, language configuration, host types, or file paths.

Unit identity is stable only within one selection analysis. V1 uses deterministic positional identifiers such as `writing-unit:0`; equality of those ephemeral IDs alone is not evidence that previously analyzed content is still current. Persistent identity across source edits, diff-based relocation tracking, and semantic matching remain intentionally deferred.

The initial `SimpleWritingUnitSegmenter` is deterministic. It includes sentence-ending punctuation (`.`, `!`, `?`, `。`, `！`, and `？`) in the preceding unit and also splits at blank-line paragraph breaks. It retains unfinished text, emits no empty or whitespace-only units, excludes inter-unit sentence whitespace and paragraph separators, and otherwise preserves every character inside each unit range without trimming. It is deliberately language-agnostic and does not attempt abbreviation, decimal, or NLP-aware sentence detection.

This is an available parallel capability:

```text
TextContext → ContextSelection → WritingUnitSegmenter → WritingUnit[]
```

The active analysis path remains unchanged:

```text
ContextSelection → WritingSegment → Analysis
```

Writing units do not yet alter snapshots, processors, provider requests, debouncing, or presentation.

`WritingUnit`, `UnitAnalysisState`, and tracks have intentionally separate responsibilities:

- a `WritingUnit` is an addressable source region within one selection analysis;
- a `UnitAnalysisState` is an immutable application-layer snapshot of that unit's analysis lifecycle, source revision, explicit unit-source fingerprint when analyzed, and optional opaque result; and
- a derived track is generated content with domain provenance and dependency information.

The unit-source fingerprint is a deterministic, non-cryptographic change detector over the exact unit text and its UTF-16 source-range start and end. It answers only whether unit analysis is associated with the same source; it contains no provider, model, policy, native-intent, or UI dependency and is deliberately separate from `DependencyStamp`.

`UnitAnalysisManager` synchronizes lifecycle states by both ephemeral unit ID and unit-source fingerprint. The same ID with the same text and range preserves its immutable state. New units and units whose text or relevant range changed receive fresh idle state with revision `0`, no analyzed-source fingerprint, and no result; old results are discarded rather than retained as stale because v1 has no consumer for them. Removed units are discarded and duplicate IDs are rejected atomically. Individual immutable replacements are accepted only for a known ID and the currently synchronized source. The manager remains scoped to one selection analysis and performs no persistent identity or cross-edit matching.

This state boundary remains an available capability only:

```text
ContextSelection → WritingUnit[] → UnitAnalysisState
```

It is not connected to `AnalysisCoordinator`, and it does not change current segment-level analysis or track generation.

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
