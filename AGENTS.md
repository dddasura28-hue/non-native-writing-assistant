# Instructions for Codex Sessions

## Before making changes

1. Read `SPEC.md` and `ARCHITECTURE.md` in full before planning or editing.
2. Inspect the current repository state and preserve unrelated user changes.
3. If a requested change affects an architectural decision or dependency boundary, explain the proposed architectural change and its tradeoffs before making it.

## Required boundaries

- Keep core TypeScript independent from Obsidian, DOM APIs, UI frameworks, storage implementations, and host-specific types.
- Do not couple core or application code to a specific LLM provider or expose provider SDK types across the provider boundary.
- Keep source text authoritative. AI and processor output is derived data and must never silently overwrite source text.
- Require an explicit, revision-checked user action before a suggestion modifies source text.
- Model representations as extensible tracks, assistance levels as policies, writing style as profiles, and new analysis capabilities as composable processors.
- Preserve cancellation and stale-result rejection for asynchronous work. Do not rely on cancellation alone for correctness.
- Respect the dependency direction defined in `ARCHITECTURE.md`. Never weaken an architectural boundary merely to make one feature easier.

If a feature appears to require crossing a boundary, stop and propose a boundary-respecting design or an explicit architecture update before implementation.

## Change discipline

- Prefer small, incremental changes with a single clear purpose.
- Avoid unrelated refactors, formatting churn, speculative abstractions, and unrequested dependencies.
- Add or update tests for core behavior and domain invariants whenever behavior changes.
- Favor host-neutral fakes and deterministic tests for core and application logic.
- Keep provider prompts, response parsing, authentication, and SDK details in replaceable integration code.
- Keep Obsidian lifecycle, editor, vault, and view details in the Obsidian adapter and presentation layers.
- Update `SPEC.md` or `ARCHITECTURE.md` when a product or architecture decision changes; do not let implementation silently redefine them.

## Verification and handoff

- Run the relevant tests and typechecks after changes. Run the narrowest useful checks during iteration and the broader relevant checks before handoff.
- Report what changed, what was verified, any checks that could not run, and any remaining design questions or risks.
- Do not claim completion when required checks are failing or architectural questions have been bypassed.

