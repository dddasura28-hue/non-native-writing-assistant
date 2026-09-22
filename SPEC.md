# Product Specification

## Product problem

People writing in a non-native language often know what they want to say but cannot yet express it naturally, accurately, or at the desired level of formality. Conventional translation tools encourage them to compose somewhere else in their native language and then translate a finished thought. That interrupts writing, hides uncertainty, and makes the translated result feel detached from the author's developing text.

This product helps users compose directly in a non-native target language. A draft may contain target-language text, native-language fragments, placeholders, and incomplete thoughts. The system interprets that unfinished source, makes its understanding visible when useful, and proposes natural target-language expression without taking control of the draft.

## Product philosophy

- The user remains the author. Assistance should preserve agency rather than turn writing into an opaque translation step.
- Source text is the only authoritative representation of the actual draft. Everything produced by AI is derived from it or from user-confirmed intent.
- Uncertainty should be visible. When the system may have misunderstood the user, the native-language intent track provides a way to inspect and correct that understanding.
- Suggestions never silently replace source text. Applying a suggestion is a distinct user action, and the affected source range must be clear.
- Mixed-language and unfinished text are valid input states, not errors that must be cleaned up before assistance begins.
- Assistance is adjustable. Users decide how much help they want, which representations they see, and what style they are aiming for.
- Representations are extensible tracks. Native intent and normalized expression are the first derived tracks, not permanent limits on the product.
- The product is host- and provider-independent in concept. Obsidian is a reference host; the planned primary product is a standalone desktop application. Any particular language model is an implementation choice.

## Key user flows

### 1. Write directly in the target language

The user starts or resumes a writing session and edits source text made available by their host. They may write fluent target-language passages, mix in native-language words, or leave incomplete phrases. Source edits remain ordinary user edits and immediately become the latest truth for analysis.

### 2. Inspect assistance tracks

According to the active assistance policy, the system analyzes a relevant segment of the source and may show:

- a native-language intent track directly expressing what it believes the user means in the user's native language; and
- a normalized target-language expression that conveys that intent naturally and correctly.

The user can show or hide each optional track independently. A track that is hidden may still be available to processors when policy and privacy settings allow it; visibility and processing are separate controls and must be presented clearly.

### 3. Correct misunderstood intent

If the native-language intent is wrong, the user can edit it. That edit records user-confirmed intent for the current source revision and can trigger regeneration of downstream tracks. It does not modify the source and does not replace the source as the record of what is actually written. A later source edit must cause the system to revalidate or invalidate the confirmed intent rather than assume it is still current.

### 4. Apply a suggestion deliberately

The user reviews a normalized expression and explicitly chooses to apply all or part of it to a clearly identified source range. The system verifies that the source has not changed since the suggestion was produced. The host performs the edit through its normal editing and undo mechanisms. The resulting text is a new source revision, and dependent outputs are recomputed or invalidated.

### 5. Adjust assistance and writing goals

The user can change assistance strength, track visibility, and a writing style profile containing choices such as tone, register, verbosity, audience, and genre conventions. Assistance levels resolve to named policies; they are not direct model parameters. Changes that affect processor inputs create a new analysis context and make incompatible in-flight or cached results stale.

## MVP scope

The planned primary product is a standalone desktop writing application over the reusable engine. Obsidian remains a buildable, tested reference host and development integration; active Obsidian-first product development has ended. The following describes the broader product scope, not features all implemented in Product Host Boundary v1:

- writing sessions over source text exposed by the host;
- stable-enough writing segments for analysis and targeted application of suggestions;
- a required source track and optional native-intent and normalized-expression tracks;
- support for target language and native language selection;
- independent visibility controls for optional tracks;
- user-editable native intent with explicit provenance;
- configurable assistance policies selected through a simple assistance-strength control;
- configurable style profiles covering at least tone, register, and verbosity, with room for additional attributes;
- processor-based generation of native intent and normalized expression;
- a provider-neutral language-model boundary;
- cancellation, version tracking, stale-result rejection, and visible error or pending states;
- explicit application of suggestions to source text with revision checks; and
- host-appropriate persistence of user settings and the minimum session metadata needed to restore the experience.

Desktop App Shell v1 establishes the first standalone host with a Tauri 2 window, a React textarea editor, host-neutral `TextContext` capture, observable selection and composition state, and guarded edit infrastructure. Desktop Engine Integration v1 adds cursor-local automatic assistance through the existing selectors, writing-unit segmentation, trigger policy, incremental coordinator, analysis coordinator, and provider boundary. Desktop BYOK & Secret Storage v1 makes the existing OpenAI, Anthropic, Gemini, and OpenAI-compatible adapters the production desktop path. Provider metadata and active selection persist separately from credentials; the native host stores secrets in the operating system credential store and performs adapter-built HTTP requests. A missing configuration never blocks source editing or produces fake output. Native Intent Confirmation v1 adds an active-target editor and explicit confirmation checkpoint. Accept / Replace v1 lets the user apply a current Normalized variant to its exact source target through the guarded desktop edit boundary. System-wide assistance remains a later phase.

### Desktop Native Intent confirmation

The active assistance item presents Native Intent in one of two states. An inferred intent is the model's editable semantic mirror. A confirmed intent is the user's semantic checkpoint, stored with user-confirmed provenance against the exact current source revision. Confirm preserves the draft text exactly, never changes Source, and immediately regenerates Normalized for the same writing unit or whole explicit selection through the provider-neutral confirmed-intent request field.

The editable draft is transient React state bound to the current segment, unit or selection, source revision, and intent track revision. It is discarded when the active semantic target changes and is never written to settings, browser storage, the filesystem, credential storage, or history. Reset Draft restores the current inferred or confirmed semantic value without changing domain state or calling a provider. Recent Assistance remains read-only.

A source mutation invalidates confirmation without fuzzy migration. A context-only, provider, or model change leaves a source-current confirmed intent intact while making older generated output dependency-stale; regeneration uses the current dependencies plus the same confirmed text. Provider failure after confirmation does not undo the confirmation. Clearing an existing confirmation is deferred to a separate future action and is not part of Reset Draft.

### Desktop Accept / Replace

Normalized output remains advisory until the user explicitly chooses Accept on a current variant. Accept means replacing exactly the source target that produced that variant. For cursor-local assistance, the target is one current `WritingUnit`; its range is mapped from `ContextSelection.activeText` into the captured host text by adding `ContextSelection.sourceRange.start`. For a non-empty explicit selection, the whole exact selection is the target even when it contains multiple sentences.

An Accept control is enabled only while source identity and the complete analysis dependency stamp remain current. The prepared action binds the desktop session's active analysis target, source revision and fingerprint, Normalized track identity and revision, dependency stamp, absolute UTF-16 half-open range, and exact expected source text. Provider, model, style, policy, context, confirmed-intent, or source changes make incompatible output stale. Unit identity alone is never sufficient.

The desktop controller constructs the existing `TextReplacement { range, expectedText, replacementText }`; React neither calculates offsets nor writes the editor. The captured `TextEditPort` performs the final session, generation, composition, captured-text, range, and exact-slice checks immediately before mutation. Failure leaves Source unchanged and reports a compact stale-source status. There is no fuzzy relocation, merge, whole-document fallback, trimming, newline conversion, or whitespace normalization.

Success replaces only that guarded range, preserves all surrounding text, collapses the selection at the end of the exact inserted variant, consumes the captured edit port, and recaptures a fresh `TextContext`. The accepted text becomes a new Source revision, so old results, confirmed Native Intent, and the old target's transient intent draft no longer apply. The recapture caused by the successful host edit suppresses only its one automatic analysis opportunity; the next genuine user edit resumes realtime analysis, and an explicit manual analysis remains available. Each current Normalized variant has its own Accept action. Recent Assistance remains read-only in v1.

### Desktop Inline Assistance

Desktop Inline Assistance v1 adds one compact floating presentation near the current textarea caret for cursor-local writing-unit assistance. It consumes the same active presentation, lifecycle status, ordered Normalized variants, and prepared Accept identity as the canonical side Assistance panel. It does not create a second analysis pipeline, cache wording independently, or introduce separate inline target semantics. The side panel continues to provide Source, editable Native Intent, confirmation actions, every Normalized variant, detailed safe status, and Recent Assistance.

The inline surface shows the first current Normalized variant in existing presentation order and its existing Accept action. The controller prepares its compact inline status so both surfaces share one authoritative lifecycle: analyzing is `Analyzing…`, ordinary provider failure is `Assistance unavailable`, and configuration-required states stay in the side panel without creating an empty floating card. Stale wording disappears immediately. Empty input, blank separators, no active target, explicit selections, and active IME composition produce no inline surface. Recent Assistance never creates floating cards and remains visually secondary.

The textarea remains an ordinary controlled textarea with soft wrapping. Inline content is absolutely positioned and never enters or decorates `textarea.value`. A desktop-only hidden mirror measures the current UTF-16 caret using the exact textarea value and matching typography, padding, width, alignment, whitespace, and wrapping properties. Scroll offsets are subtracted and offscreen anchors are hidden. Caret geometry is remeasured for source, caret, scroll, textarea or pane size, and relevant font-layout changes; analysis wording changes only remeasure the actual card for placement. The card stays within the Writing pane, prefers a non-overlapping position below the active line, moves above when needed, and clamps horizontally. The mirror is aria-hidden, unfocusable, invisible, noninteractive, and transient.

Inline Accept sends the selected variant's existing prepared identity to the desktop controller. The controller and captured `TextEditPort` perform the same dependency, source, session, generation, range, and expected-text checks used by side-panel Accept. Pointerdown does not mutate Source or its selection before those checks. Success follows the same replacement, caret, invalidation, confirmation/draft cleanup, fresh-context, and one-shot automatic-analysis suppression lifecycle without a success toast. After either success or a stale rejection, the textarea regains focus; a successful edit retains the caret established by the guarded replacement.

### Global Desktop Assistant boundary

Global Desktop Assistant Boundary v1 defines a desktop-host seam for future text surfaces owned by other applications. An active-surface capture contains the existing `TextContext`, truthful `HostCapabilities`, and either a host-bound guarded `TextEditPort` or no edit port. `TextContext.text` remains the exact window supplied by the host, which may be a whole control, partial surrounding text, or selected text only. Every offset is a UTF-16 offset relative to that captured string; application code receives no document-global offsets, window handles, process identity, accessibility objects, or screen geometry.

Manual global analysis always starts with a fresh capture and feeds it through the existing desktop engine, context selector, writing-unit pipeline, provider, dependency checks, and presentation semantics. A selected-text-only capture uses the existing whole explicit-selection target with empty before/after context. Missing surrounding text is never invented. An unavailable host or empty capture produces a neutral state and no provider request.

Capabilities determine safe behavior. Automatic realtime assistance is eligible only when composition can be observed reliably and no composition is active. If composition visibility is unavailable, an intentional manual action may analyze the exact committed/captured text, but realtime remains disabled. A read-only host may produce Native Intent and Normalized output but never receives an enabled Accept action. The owned textarea continues to declare full selection, surrounding-text, composition, and guarded-replacement capabilities.

External Accept still uses the current Normalized result and the existing exact `TextReplacement`. The external adapter binds its one-shot `TextEditPort` to the exact application, control, captured text window, and opaque native session generation. Matching text is insufficient: an old port rejects after a host/session change even when the visible text is identical. The controller also invalidates old presentation actions when a new capture or provider profile supersedes them. No fuzzy relocation or recapture-and-force behavior exists.

Windows External Host Adapter v1 is the first real adapter over this boundary. It supports deliberate manual capture and analysis of a focused external Windows text control through UI Automation. It does not provide realtime global assistance, a production global overlay, a global shortcut, or external replacement.

### Experimental Windows external-host capture

Every manual Windows capture obtains the focused UI Automation element again. The adapter rejects this application's own process, password/protected controls, disabled or non-focusable elements, disappeared elements, and elements whose text plus caret/selection cannot be represented truthfully. It never returns a window title, process path, process ID, runtime ID, native handle, accessibility object, or unrelated application content to the writing engine or provider.

TextPattern2 caret data is preferred when it is active. TextPattern supplies document text and selection ranges. One non-empty contiguous selection becomes an exact selected-text-only window; a degenerate selection becomes a caret. Multiple disjoint selections are never concatenated: when TextPattern2 provides a reliable caret, the adapter degrades to a caret-centered capture with selection observation disabled, and otherwise reports the control as unsupported. Cursor and selection offsets are UTF-16 offsets relative to the exact returned text.

Cursor captures use a deterministic bounded UIA range of up to 8,192 UIA character units on each side of the caret. The returned string is exactly the text read from that range, so shorter provider ranges remain truthful. Selected captures contain exactly the selected range and claim no surrounding-text capability. ValuePattern availability is detected, but ValuePattern-only controls are not captured because that pattern does not expose a reliable cursor or selection.

UI Automation v1 reports `canObserveComposition: false`, so automatic cross-application analysis remains disabled. Manual analysis is supported for committed text intentionally captured by the user. TextPattern readability does not imply write safety, and this adapter reports `canReplaceText: false` with no `TextEditPort`. ValuePattern writing is deferred because arbitrary providers do not prove atomic partial replacement, deterministic caret placement, and rollback-safe post-write verification required by the existing guarded-edit contract.

The standalone app includes a clearly labeled development section. Its manual Analyze action waits three seconds so the user can return focus to an external field before the native command performs one fresh capture. This is a deliberate one-shot timer, not polling or event monitoring. Protected text is never analyzed, and captured text is not logged or persisted. There is no clipboard, SendKeys, SendInput, simulated typing, global hotkey, UIA event subscription, background monitoring, system tray workflow, or floating global assistant in this phase.

### Desktop provider configuration

The desktop settings surface supports multiple named profiles, an open model ID, enable/disable state, explicit active-profile selection, and separate credential replacement/removal. OpenAI-compatible profiles also expose their visible base URL and structured-output compatibility mode; DeepSeek uses this custom-provider path rather than a dedicated adapter. Only HTTPS endpoints are accepted, except for exact loopback HTTP endpoints used deliberately in local development. Credentials embedded in URLs are invalid.

Persisted profile metadata may contain a generated `secretRef`, but never the resolved credential, authorization headers, or provider response data. Deleting profile metadata does not delete its credential. Analysis resolves the active profile and credential at request time. Profile and model changes alter the analysis dependency fingerprint, immediately make incompatible output non-current, and refresh only the active target under the existing trigger policy.

## Explicit non-goals

- Acting primarily as a general-purpose translation tool for completed documents.
- Automatically rewriting or replacing source text without a user action.
- Treating AI output as authoritative or silently resolving ambiguous intent.
- Building a complete word processor, document-management system, or collaboration platform.
- Supporting every possible host application in the MVP.
- Providing every future track, including academic review, deep explanations, or full-document consistency analysis, in the MVP.
- Encoding provider SDK types, Obsidian APIs, prompts, or UI layout assumptions in the core domain.
- Training or fine-tuning a proprietary language model as part of the MVP.

## Terminology

**Writing session**  
The product context in which a user composes source text with a chosen language setup, assistance policy, style profile, and visible tracks.

**Writing segment**  
A versioned, addressable portion of a writing session used as the unit of analysis and suggestion application. Its exact granularity is an implementation decision, but its identity must not depend on Obsidian types.

**Track**  
A typed representation associated with a writing segment. Tracks share common lifecycle and provenance concepts so new representations can be added without creating new hard-coded UI fields.

**Source track / source text**  
The required, user-authored track containing what is actually in the draft. It is the source of truth.

**Derived track**  
A non-authoritative representation computed from versioned inputs. It may be generated by AI or another processor and may be invalidated when an input changes.

**Native-language intent**  
An optional semantic mirror of the user's intended meaning, expressed naturally and concisely in the user's native language. It directly states the intended thought from the user's point of view; it is not an explanation, summary, commentary, analysis, or description of the writing problem. It preserves meaningful structure, uncertainty, contrast, conditions, and unfinished thoughts without expanding or strengthening them. A user may correct it to provide confirmed intent for downstream processing.

**Normalized target-language expression**  
An optional track proposing a grammatical, natural target-language rendering of the current inferred or confirmed intent. “Normalized” does not mean flattening the user's voice into one universal style.

**Suggestion**  
A proposed change or expression that has not modified source text.

**Accept / Apply**
An explicit user command that requests one selected, current suggestion be written to its exact source range after source, dependency, and host-session checks.

**Assistance strength**  
A user-facing choice that selects an assistance policy. It is not itself a collection of scattered numeric thresholds.

**Assist policy**  
A named, configurable set of rules governing which processors run, when they run, which inputs and outputs they use, and how proactive assistance may be.

**Style profile**  
A structured, extensible description of the desired target-language expression, such as tone, register, verbosity, audience, genre, locale conventions, or terminology constraints.

**Processor**  
A composable unit that consumes versioned session or track inputs and produces track updates, suggestions, or diagnostics without directly editing source text.

**Provider adapter**  
An integration that implements provider-neutral language-model capabilities using a specific service or local model.

**Host adapter**  
An integration between product use cases and a host application's text, storage, lifecycle, and editing facilities. Obsidian is the reference host.

## Future possibilities

- Explanations of grammar, word choice, pragmatics, and differences between source and normalized expression.
- Multiple alternative expressions with explicit tradeoffs.
- Terminology suggestions, glossaries, and domain-specific constraints.
- Reusable style profiles, organization profiles, and style variants.
- Academic writing assistance, citation-aware guidance, and discipline-specific conventions.
- Cross-segment terminology, voice, and consistency checks.
- Learning-oriented feedback that adapts to recurring user needs without taking over authorship.
- Additional deterministic and AI-backed processors composed into task-specific pipelines.
- Platform-specific native text-input hosts after the standalone desktop application; browser and other host adapters remain future possibilities.
- Multiple model providers, local models, capability-based routing, and privacy-sensitive execution policies.
