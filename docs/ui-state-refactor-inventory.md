# Svelte UI state refactor inventory

This inventory records the ownership and dependency baseline of the original
`ui/src/lib/battle-state.svelte.ts` before it is split. It is intentionally
about behavior and ownership rather than line counts.

## Original state surface

| Responsibility | State fields | Derived values | Operations |
| --- | --- | --- | --- |
| Resources and session | `catalog`, `profiles`, `snapshot` | `ready`, `mode`, `capabilities`, `savedSetups`, `currentPlayerTeam` | `initialize`, `applySnapshot`, `character`, `entity`, `costume`, `legalFor`, `battleLog` |
| Turn planning and preview | `selectedUnitId`, `plannedOrder`, `plannedCommands`, `plannedBurstLevels`, `plannedFormation`, `preview`, `previewPending`, `autoReserveEnabled` | `selectedUnit`, `selectedCommand`, `actionableOrder`, `reservedSp`, `reservedBurstSp`, `sp`, `previewCells`, `previewTargetIds`, `selectedDamage`, `effectivePosition` | `selectedCommandIndex`, `selectUnit`, `selectAction`, `moveOrder`, `moveBattleUnit`, `toggleAutoReserve`, `requestPreview` |
| Execution and playback | `autoTurnEnabled`, `speed`, `executing`, `paused`, `cue`, `floating`, `playbackUnits`, `playbackCreated`, `playbackTargetId`, `playbackTargetCell`, `playbackActorId`, `playbackMonster`, `playbackParty`, `playbackSp`, `playbackCanRollback` | `units`, `activeParty`, `monsterState`, `canRollback`, `playerUnits`, `enemyUnits` | `executePlan`, `aiStep`, `resetBattle`, `rollbackBattle`, `playEvents`, `playEvent`, `addFloating`, `animationSleep`, `cancelPlayback`, `resume`, `toggleAutoTurn`, `cycleSpeed`, `scheduleAutoTurn`, `cancelAutoTurn` |
| Battle preparation | `draft`, `editorParty`, `editorFocus`, `advancedEditor`, `setupSeed`, `monsterLevel`, `mctsSimulations`, `savedSetupName`, `selectedSavedSetup`, `savedSetupStatus` | none | `loadDraft`, `loadPreset`, `applyProfile`, `partyUnits`, `moveDraftUnit`, `usedCostumeIds`, `defaultCostumes`, `replaceDraftUnit`, `replaceDraftCharacter`, `removeDraftUnit`, `addCharacter`, `cleanUnit`, `startRequest`, `startBattle`, `saveSetup`, `loadSetup` |
| Profile editing | `selectedProfileId`, `profileSearch`, `profileElementFilter`, `profileDrafts` plus shared `profiles` | none | `profileFor`, `openProfiles`, `editableProfile`, `profileDirty`, `mutateProfile`, `saveProfile`, `resetProfile` |
| Dialog transitions | `dialog`, `returnDialog`, `inspectedUnitId`, `pickerTarget` | none | `open`, `close`, `openPicker` |
| Feedback and live regions | `busy`, `busyLabel`, `error`, `tip`, `announcement` | none | `withBusy`, `showError`, `announce`, `updateTip` |

## Async resources and cancellation baseline

| Resource | Original owner | Trigger | Cancellation/guard before refactor |
| --- | --- | --- | --- |
| `errorTimer` | root state | transient error | replaces the previous timeout, but has no component-disposal cleanup |
| untracked announcement timeout | root state | live-region announcement | zero-delay timeout, with neither cancellation nor disposal |
| `previewTimer` | root state | planning changes | debounced for 120 ms and replaced on every request |
| `previewController` | root state | preview HTTP request | aborts superseded requests |
| `previewGeneration` | root state | preview HTTP request | rejects stale debounce callbacks and responses |
| `playbackGeneration` | root state | event playback | invalidates active playback loops |
| untracked playback sleep timeouts | root state | every animation tick | generation-guarded, but not explicitly cleared on disposal |
| untracked floating-cue timeouts | root state | damage/heal/chain cues | removes a cue after 900 ms, but has no disposal cleanup |
| `autoTimer` | root state | automatic turn | replaced and cancelled when automation is suspended |

The refactor must give every timer, request, and playback loop an explicit
`dispose()` path called by `App.svelte` on destruction.

## API orchestration baseline

The root state directly calls every HTTP operation: `catalog`, `profiles`, and
`state` during initialization; `preview` while planning; `step` and `aiStep`
during execution; `reset` and `rollback` from battle controls; `start`,
`saveSetup`, and `loadSetup` from preparation; and `saveProfile` and
`resetProfile` from the profile editor. All calls share the root `withBusy`
error/loading wrapper. Only preview requests are abortable.

## Component dependency baseline

Every component below imports the complete `BattleState` type. The members in
the right column are the actual direct dependencies found before refactoring.

| Component | Root-state dependencies |
| --- | --- |
| `HeaderBar` | session, planning, execution, catalog lookups, dialog opening |
| `ActionOrder` | session, planning, catalog lookups |
| `CommandSelection` | session, planning, catalog lookups, feedback |
| `BattleBoard` | session, planning, playback, catalog lookups, dialog opening, feedback |
| `EnemyInfo` | session/playback, catalog lookups, inspect-dialog opening |
| `FooterSp` | session, planning SP, execution, feedback, pause-dialog opening |
| `NotificationLayer` | loading/error/live-region feedback |
| `PreparationDialog` | dialogs, setup draft, session saved setups |
| `CharacterPickerDialog` | dialogs, setup draft, catalog lookups, feedback |
| `CharacterProfilesDialog` | dialogs, catalog and profile editing |
| `PauseDialog` | dialogs and execution controls |
| `LogDialog` | dialogs and session log formatting |
| `InspectDialog` | dialogs, session/playback and catalog lookups |
| `HelpDialog` | dialog state only |
| `FormationEditor` | setup draft and catalog lookups |
| `AdvancedUnitEditor` | setup draft, catalog/profile selection, dialog opening |
| `GoldenSettings` | setup draft and catalog data |

## Target ownership and dependency direction

The application composition root instantiates these per application, connects
their typed interfaces, initializes them, and disposes them. No domain imports
the composition root.

```text
BattleAppState (composition/lifecycle only)
  -> CatalogState
  -> SessionState
  -> FeedbackState
  -> ProfileState -> CatalogState, API, FeedbackState
  -> SetupState -> CatalogState, ProfileState(read-only), API, FeedbackState
  -> PlanningState -> CatalogState, SessionState, PlaybackState(read-only), API, FeedbackState
  -> PlaybackState -> CatalogState, SessionState(read-only)
  -> ExecutionState -> SessionState, PlanningState(read-only), PlaybackState, API, FeedbackState
  -> DialogState -> ExecutionState(control), ProfileState(control), SetupState(picker state)
```

Cross-domain commits that must update several owners (`initialize`, accepting a
new battle snapshot, starting/loading a setup, and refreshing setup units after
a profile write) are application orchestration, not hidden shared mutation.
They are connected through narrow constructor callbacks or typed interfaces.
Pure setup normalization, event decoding, and planning transformations live in
ordinary `.ts` modules with no Svelte, DOM, timer, or browser dependencies.
