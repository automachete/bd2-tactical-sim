# Svelte UI state refactor validation

Date: 2026-09-04

## Outcome

The 1,085-line `ui/src/lib/battle-state.svelte.ts` state owner has been removed.
Its state, derived values, API orchestration, and async lifecycle are now split
by responsibility. `App.svelte` is a 65-line composition root; components
receive only the domain states and actions they use, never the application root
or a forwarding `model` facade.

This refactor does not change the Rust battle core, Python RL path, HTTP routes
or payloads, catalog data, game rules, visible copy, CSS, stable DOM IDs,
`data-testid` values, or accessibility contracts.

The pre-refactor ownership and component dependency inventory is recorded in
`docs/ui-state-refactor-inventory.md`.

## Final ownership

| Module | Lines | Responsibility |
| --- | ---: | --- |
| `app-state.svelte.ts` | 91 | Per-application construction, initialization, cross-domain snapshot commit, and disposal |
| `catalog-state.svelte.ts` | 27 | Catalog resource and character/entity/costume lookup |
| `session-state.svelte.ts` | 52 | Authoritative battle snapshot, mode capabilities, legal actions, saved setups, and history formatting |
| `feedback-state.svelte.ts` | 65 | Busy/error/tip/live-region state and its timers |
| `profile-state.svelte.ts` | 117 | Persistent character profiles and profile editor drafts |
| `setup-state.svelte.ts` | 299 | Preparation draft/editor state and setup API workflows |
| `planning-state.svelte.ts` | 341 | Selection, action order, commands, formation, SP derivation, and authoritative preview |
| `playback-state.svelte.ts` | 299 | Event playback, transient units/cues, pause, speed, and animation waits |
| `execution-state.svelte.ts` | 155 | Step/AI/reset/rollback orchestration and automatic turns |
| `dialog-state.svelte.ts` | 100 | Dialog transitions, return targets, inspection, and picker context |

`contracts.ts` defines narrow read/feedback ports between domains.
`setup-model.ts` and `playback-model.ts` hold newly extracted pure
transformations and event decoding alongside the existing pure
`battle-ui-model.ts`. These files have no rune, Svelte, DOM, timer,
`AbortController`, or browser dependency.

The production dependency direction is one-way:

```text
App.svelte -> BattleAppState (composition/lifecycle only)
                    |
                    +-> catalog/session/feedback
                    +-> profiles -> catalog + API + feedback
                    +-> setup -> catalog + profiles(read) + API + feedback
                    +-> planning -> catalog + session + playback(read) + API + feedback
                    +-> playback -> catalog + session(read)
                    +-> execution -> session + planning(read) + playback + API + feedback
                    +-> dialogs -> execution/playback/profiles/setup controls

components -> only the domain states/actions each component uses
domains -X-> application root
```

There is no module-level API or state singleton. `createBattleApi()` creates one
typed API client per application instance, preserving every existing endpoint.

## Async lifecycle and regression guards

- Preview debounce ownership, request abortion, and generation checks live in
  `PlanningState`. Superseded and disposed requests cannot commit stale data.
- Playback sleep and floating-cue timers are tracked by `PlaybackState`.
  Cancellation resolves active waits immediately and prevents later mutation.
- Automatic-turn scheduling is owned and disposed by `ExecutionState`.
- Error and live-region timers are owned and disposed by `FeedbackState`.
- The remaining component-local zero-delay focus/drag timers use `onDestroy`.
- `App.svelte` calls the complete disposal chain from its `onMount` cleanup.

Architecture tests now enforce the absence of the former root file and root
component dependency, one owner for every major rune field, domain modules no
larger than 350 lines, no state import cycle or module singleton, a root without
forwarded domain methods, pure-model browser independence, explicit cleanup for
every timer/abort owner, and strict TypeScript without suppression escapes.

New focused tests cover pure setup/profile normalization, immutable formation
and character editing, request serialization, playback event decoding, preview
abort/stale-response/disposal behavior, and playback cancellation. The rapid
preview Playwright case now waits for the initial authoritative preview before
measuring calls caused by rapid user input; its one-request assertion is
unchanged and passed five consecutive repetitions.

## Validation results

- `npm run verify`: Svelte diagnostics 0 errors/0 warnings; ESLint passed;
  Vitest 147/147; Vite production build passed.
- Focused preview concurrency stress: 5/5 consecutive Playwright repetitions.
- `npm run test:ui`: Playwright 83/83. Model-based quality completed four
  sequences and six turns across `NORMAL`, `MIRROR_WAR`, `MONSTER_CHASER`, and
  `GOLDEN_COLOSSEUM`; failures 0, status `ok`.
- Production screenshot comparison: 9/9 SHA-256 digests exactly match the
  baseline (all four modes plus preparation, profiles, pause, log, and help).
- Python: pytest 69/69; Ruff check passed; Ruff format check reports all 17
  files already formatted.
- RL import isolation: importing the training entry point loads neither
  `bd2rl.gui` nor `http.server` (focused integration test 1/1).
- Rust: `cargo fmt --check` passed; Clippy passed with `-D warnings` for all
  workspace targets; `cargo test --workspace` passed 67/67 plus doc-test
  targets.
- Catalog semantic validation: 66 characters, 164 costumes, 12,509 variants,
  47 blessings, and 450,463 lineage checks; status `ok`.
- Portrait validation: 61/61 unique local 64 px runtime images, with alpha and
  metadata validation.
- `git diff --check`: passed.

The screenshot digests are identical to
`docs/validation/ui-screenshots/baseline/`; no replacement baseline was
generated.

## Performance comparison

The before and after measurements use Windows, Python 3.13.7, Torch
2.13.0+cu130, batch size 64, 200 repetitions, seed 123, and 12,800 measured
environment steps. The baseline is
`docs/validation/svelte-migration-performance-svelte.json`.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Legacy JSON environment steps/s | 147.9 | 148.8 | +0.61% |
| Direct NumPy environment steps/s | 2,783.4 | 3,035.2 | +9.05% |
| Direct/legacy speedup | 18.82x | 20.40x | +8.40% |
| GPU transfer frames/s | 65,868.3 | 66,990.0 | +1.70% |
| GPU forward frames/s | 17,614.0 | 17,902.9 | +1.64% |

There is no measured RL throughput regression. The variation is consistent
with runtime measurement noise because this change does not modify or import
the Python/Rust execution path.

## Retained platform boundaries

- Native `<dialog>.showModal()`, fullscreen, pointer capture, focus scheduling,
  and layout measurement remain explicit browser boundaries.
- Preview requests remain the only abortable HTTP operation in the unchanged
  API contract. Other async workflows reject post-disposal state commits.
- `ui/dist` and dependency directories remain generated and ignored; a source
  checkout must build the production bundle before launching `bd2-play` or
  `bd2-gui` outside the Playwright workflow.

No refactor-specific functional limitation or visual difference remains.
