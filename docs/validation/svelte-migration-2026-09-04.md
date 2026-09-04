# Svelte 5 UI migration validation

Date: 2026-09-04

## Scope and rejected implementation

This migration replaces the production browser UI with Svelte 5, strict TypeScript, and Vite. It does not change the Rust battle core, Python RL data path, HTTP API semantics, catalog data, or game rules.

Commit `7ae9d4c` was examined as a failed migration. It copied nearly the complete legacy page into `App.svelte`, initialized the application by dynamically importing a 3,079-line controller from `onMount`, and disabled strict TypeScript. The final implementation does not use that structure: `App.svelte` is a 64-line composition root, startup is an explicit `mount` plus state initialization, and no legacy controller or runtime fallback exists.

## Pre-migration inventory

The inventory covered:

- Screens: selected-unit header, action order, command reservation, two-sided battle grid, enemy information, SP/footer, terminal state, and loading/error/live-region overlays.
- Dialogs and editors: battle preparation, character picker, character profiles, pause, battle log, help, unit inspection, formation, advanced unit settings, costumes, equipment, build settings, and Golden Colosseum blessings.
- Modes: `NORMAL`, `MIRROR_WAR`, `MONSTER_CHASER`, and `GOLDEN_COLOSSEUM`, including their formation, command, automation, party, boss, and SP constraints.
- API contract: `GET /api/catalog`, `/api/state`, and `/api/character-profiles`; `POST /api/start`, `/api/reset`, `/api/step`, `/api/ai-step`, `/api/rollback`, `/api/preview`, `/api/save-setup`, `/api/load-setup`, `/api/save-character-profile`, and `/api/reset-character-profile`.
- Input: click, native drag/drop, pointer/touch dragging with pointer capture, keyboard board pickup/movement/confirmation/cancellation, keyboard order movement, search/filter inputs, form binding, pause/resume, fullscreen, and playback speed.
- Stable contracts: existing IDs and `data-testid` values, grid/listbox/dialog semantics, accessible names, `aria-selected`, `aria-pressed`, `aria-grabbed`, `aria-disabled`, and assertive/polite live regions.

The pre-migration Node suite passed 123/123 tests. The pre-migration Playwright run passed 82 tests; one test process hit Windows `ERR_NO_BUFFER_SPACE` while starting a browser and did not reach its touch-order assertion. The final run below executes that test successfully.

Baseline screenshots are stored in `docs/validation/ui-screenshots/baseline/`: four mode views and five major dialog views.

## Final architecture

- `ui/src/App.svelte`: top-level composition and state connection only.
- Battle components: `BattleBoard`, `ActionOrder`, `CommandSelection`, `EnemyInfo`, `HeaderBar`, and `FooterSp`.
- Dialog components: `PreparationDialog`, `CharacterPickerDialog`, `CharacterProfilesDialog`, `PauseDialog`, `LogDialog`, `HelpDialog`, and `InspectDialog`.
- Editor components: `FormationEditor`, `AdvancedUnitEditor`, `CostumeEditor`, `EquipmentEditor`, `BuildSettingsEditor`, and `GoldenSettings`.
- Cross-cutting presentation: `Avatar`, `MiniRange`, and `NotificationLayer`.
- Typed state and boundaries: rune-based `BattleState`, typed `battleApi`, explicit API/catalog/setup/profile/snapshot/command types, DOM-free battle model functions, presentation helpers, and the Japanese i18n resource.

The production source has no `querySelector`, `querySelectorAll`, `innerHTML`, `insertAdjacentHTML`, `{@html}`, dynamic import, `any`, `as any`, `@ts-ignore`, or lint suppression. An architecture test enforces these constraints, strict TypeScript, the small composition root, and absence of legacy fallback files. Japanese user-facing copy is also required to remain in the i18n resource.

The only direct browser boundaries are the explicit mount target, native modal promotion, fullscreen, focus scheduling, animation timers, pointer capture, and element measurement for pointer hit-testing.

## Build and Python integration

Vite emits `ui/dist`, which is ignored by Git along with `ui/node_modules`. `package-lock.json` is committed and `npm ci` completes with zero reported vulnerabilities. Development uses the Vite proxy for the existing Python API.

`bd2-play` and `bd2-gui` serve the Vite production bundle through the existing Python GUI server. Missing or incomplete output produces an actionable error directing the operator to `npm ci` and `npm run build`. Python integration tests also prove that importing the RL training entry point imports neither the GUI module nor `http.server`.

The legacy production files `ui/app.js`, `ui/battle-ui-model.mjs`, `ui/i18n.mjs`, and `ui/styles.css` are removed. Static portraits now live under Vite's `ui/public/assets` tree, leaving one executable UI implementation.

## Validation results

- `npm run verify`: Svelte diagnostics 0 errors/0 warnings; ESLint passed; Vitest 128/128; Vite production build passed.
- `npm run test:ui`: Playwright 83/83, including model-based multi-turn synchronization across all four modes.
- `python -m pytest -q`: 69/69.
- Ruff check and format check: passed.
- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace`: 67/67 unit/integration/property tests plus doc tests.
- Catalog semantic validation: 66 characters, 164 costumes, 12,509 variants, 47 blessings, and 450,463 lineage checks; status `ok`.
- Portrait validation: 61/61 unique local 64px assets with alpha and metadata validation.

Post-migration screenshots are stored in `docs/validation/ui-screenshots/svelte/`. Every one of the nine PNG files has the same SHA-256 digest as its baseline counterpart.

## Performance comparison

Both measurements use Windows, Python 3.13.7, Torch 2.13.0+cu130, batch size 64, 200 repetitions, and 12,800 measured environment steps.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Legacy JSON environment steps/s | 147.2 | 147.9 | +0.48% |
| Direct NumPy environment steps/s | 2,783.7 | 2,783.4 | -0.01% |
| Direct/legacy speedup | 18.91x | 18.82x | -0.48% |
| GPU transfer frames/s | 60,701.9 | 65,868.3 | +8.51% |
| GPU forward frames/s | 17,339.4 | 17,614.0 | +1.58% |

The direct RL environment result is unchanged within measurement noise, consistent with the UI and HTTP server remaining outside the RL import path. Raw results are in `svelte-migration-performance-baseline.json` and `svelte-migration-performance-svelte.json`.

## Known constraints

- A source checkout intentionally has no production `dist`; operators must build it before starting `bd2-play` or `bd2-gui` outside the Playwright workflow.
- Native `<dialog>.showModal()`, fullscreen, pointer capture, focus, and layout measurement remain browser boundaries by design.
- The independent full equipment-provenance validator currently reports a pre-existing mismatch between catalog and oracle `observed_at`/`source_digest` metadata. Catalog semantic validation and all Rust equipment-oracle behavior tests pass; the UI migration does not rewrite external-source provenance.
