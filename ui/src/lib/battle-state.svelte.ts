import { SvelteMap, SvelteSet } from "svelte/reactivity";

import { battleApi } from "./api";
import {
  actionIndices,
  autoReserve,
  cellKey,
  modeCapabilities,
  moveFormation,
  plannedBurstSpCost,
  plannedSpCost,
  projectRangeCells,
  selectCommand,
  serializeFormation,
  spBreakdown,
} from "./battle-ui-model";
import { t } from "./i18n";
import { commandPresentation, costumeById, entityById, formatNumber, humanEvent } from "./presentation";
import type {
  BattleCommand,
  BattleEvent,
  BattleMode,
  BattleSetup,
  BattleSnapshot,
  BattleUnit,
  Catalog,
  CharacterDefinition,
  CharacterProfile,
  CharacterProfileDocument,
  CostumeDefinition,
  Formation,
  LegalActions,
  ModeCapabilities,
  MonsterChaserState,
  PreviewResult,
  SavedSetup,
  SetupSide,
  SetupUnit,
  Side,
} from "./types";
import type { SpBreakdown } from "./battle-ui-model";

export type DialogName = "formation" | "profiles" | "picker" | "pause" | "log" | "help" | "inspect";
export type Cue = { title: string; detail: string; turn: string };
export type FloatingCue = { id: number; unitId: number; text: string; className: string };
export type PickerTarget = { side: Side; party: number };
export type EditorFocus = { sideKey: SetupSide; index: number };

const clone = <T>(value: T): T => {
  const snapshot: unknown = $state.snapshot(value);
  return structuredClone(snapshot) as T;
};
const asNumber = (value: unknown, fallback = 0): number => typeof value === "number" ? value : Number(value ?? fallback);
const eventNumber = (event: BattleEvent, key: string): number => asNumber(event.kind[key]);
const eventString = (event: BattleEvent, key: string): string => {
  const value = event.kind[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};

export class BattleState {
  catalog = $state<Catalog | null>(null);
  profiles = $state<CharacterProfileDocument | null>(null);
  snapshot = $state<BattleSnapshot | null>(null);
  draft = $state<BattleSetup | null>(null);

  selectedUnitId = $state<number | null>(null);
  plannedOrder = $state<number[]>([]);
  plannedCommands = $state<Map<number, number>>(new SvelteMap());
  plannedBurstLevels = $state<Map<string, number>>(new SvelteMap());
  plannedFormation = $state<Formation>({});

  preview = $state<PreviewResult | null>(null);
  previewPending = $state(false);
  dialog = $state<DialogName | null>(null);
  returnDialog = $state<DialogName | null>(null);
  inspectedUnitId = $state<number | null>(null);
  pickerTarget = $state<PickerTarget | null>(null);
  editorParty = $state(1);
  editorFocus = $state<EditorFocus>({ sideKey: "player_units", index: 0 });
  advancedEditor = $state<EditorFocus | null>(null);

  setupSeed = $state(42);
  monsterLevel = $state(6);
  mctsSimulations = $state(48);
  savedSetupName = $state("");
  selectedSavedSetup = $state("");
  savedSetupStatus = $state("");

  selectedProfileId = $state<string | null>(null);
  profileSearch = $state("");
  profileElementFilter = $state("ALL");
  profileDrafts = $state<Map<string, CharacterProfile>>(new SvelteMap());

  busy = $state(false);
  busyLabel = $state(t("status.busy"));
  error = $state("");
  tip = $state(t("board.initialTip"));
  announcement = $state("");
  autoReserveEnabled = $state(false);
  autoTurnEnabled = $state(false);
  speed = $state(1);

  executing = $state(false);
  paused = $state(false);
  cue = $state<Cue>({ title: "", detail: "", turn: "" });
  floating = $state<FloatingCue[]>([]);
  playbackUnits = $state<Record<string, BattleUnit>>({});
  playbackCreated = $state<Set<number>>(new SvelteSet());
  playbackTargetId = $state<number | null>(null);
  playbackTargetCell = $state<{ side: Side; row: number; depth: number } | null>(null);
  playbackActorId = $state<number | null>(null);
  playbackMonster = $state<MonsterChaserState | null>(null);
  playbackParty = $state<number | null>(null);
  playbackSp = $state<number | null>(null);
  playbackCanRollback = $state(false);

  private errorTimer: number | undefined;
  private autoTimer: number | undefined;
  private previewTimer: number | undefined;
  private previewController: AbortController | null = null;
  private previewGeneration = 0;
  private playbackGeneration = 0;
  private floatingSequence = 0;

  get ready(): boolean {
    return this.catalog !== null && this.profiles !== null && this.snapshot !== null && this.draft !== null;
  }

  get mode(): BattleMode {
    return this.snapshot?.state.rules.mode ?? this.draft?.mode ?? "NORMAL";
  }

  get capabilities(): ModeCapabilities {
    return modeCapabilities(this.mode, this.snapshot?.state.rules.allow_formation_change ?? true);
  }

  get units(): Record<string, BattleUnit> {
    return this.executing ? this.playbackUnits : (this.snapshot?.state.units ?? {});
  }

  get activeParty(): number {
    return this.executing ? this.playbackParty ?? 1 : this.snapshot?.state.monster_chaser?.current_party ?? 1;
  }

  get monsterState(): MonsterChaserState | null {
    return this.executing ? this.playbackMonster : this.snapshot?.state.monster_chaser ?? null;
  }

  get canRollback(): boolean {
    return this.executing ? this.playbackCanRollback : Boolean(this.snapshot?.can_rollback);
  }

  get playerUnits(): BattleUnit[] {
    return Object.values(this.units).filter((unit) => unit.side === "PLAYER" && Number(unit.party_no || 1) === this.activeParty);
  }

  get enemyUnits(): BattleUnit[] {
    return Object.values(this.units).filter((unit) => unit.side === "ENEMY");
  }

  get currentPlayerTeam() {
    return this.snapshot?.state.teams.find((team) => team.side === "PLAYER") ?? null;
  }

  get selectedUnit(): BattleUnit | null {
    return this.selectedUnitId === null ? null : this.units[String(this.selectedUnitId)] ?? null;
  }

  get selectedCommand(): BattleCommand | undefined {
    const unitId = this.selectedUnitId;
    if (unitId === null) return undefined;
    return this.legalFor(unitId)?.commands[this.selectedCommandIndex(unitId)];
  }

  get actionableOrder(): number[] {
    return this.plannedOrder.filter((unitId) => this.legalFor(unitId) !== undefined);
  }

  get reservedSp(): number {
    if (!this.snapshot || !this.catalog) return 0;
    return plannedSpCost(this.actionableOrder, this.plannedCommands, (id) => this.legalFor(Number(id)), (id) => costumeById(this.catalog!, id));
  }

  get reservedBurstSp(): number {
    return plannedBurstSpCost(this.actionableOrder, this.plannedCommands, (id) => this.legalFor(Number(id)));
  }

  get sp(): SpBreakdown {
    const current = this.executing ? this.playbackSp ?? 0 : this.currentPlayerTeam?.sp ?? 0;
    const cap = this.snapshot?.state.rules.sp_cap ?? 20;
    return spBreakdown({ current, reserved: this.reservedSp, burst: this.reservedBurstSp, cap });
  }

  get previewCells(): Set<string> {
    const preview = this.preview;
    const grid = this.snapshot?.state.rules.grid;
    const meta = this.selectedUnit && this.catalog
      ? commandPresentation(this.catalog, this.selectedUnit, this.selectedCommand)
      : null;
    if (!preview?.anchor || !grid || !meta) return new SvelteSet();
    if (preview.affected_cells) return new SvelteSet(preview.affected_cells.map((cell) => cellKey(cell.row, cell.depth)));
    return projectRangeCells(meta.range, preview.anchor, {
      targetAll: Boolean(meta.target_all), rows: grid.rows, depths: grid.depths,
    });
  }

  get previewTargetIds(): Set<number> {
    return new SvelteSet(this.preview?.affected_unit_ids ?? []);
  }

  get selectedDamage(): number {
    return this.preview?.total_damage ?? 0;
  }

  get savedSetups(): SavedSetup[] {
    return this.snapshot?.saved_setups ?? [];
  }

  async initialize(): Promise<void> {
    await this.withBusy(t("status.loadingData"), async () => {
      const [catalog, profiles, snapshot] = await Promise.all([
        battleApi.catalog(), battleApi.profiles(), battleApi.state(),
      ]);
      this.catalog = catalog;
      this.profiles = profiles;
      this.setupSeed = snapshot.seed;
      this.mctsSimulations = snapshot.mcts.simulations;
      this.monsterLevel = snapshot.setup.monster_level ?? 6;
      this.loadDraft(snapshot.setup ?? catalog.presets[snapshot.state.rules.mode]);
      this.applySnapshot(snapshot);
    });
  }

  private async withBusy<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.busyLabel = label;
    try {
      return await operation();
    } catch (error) {
      this.showError(error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  showError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.announce(this.error);
    if (this.errorTimer !== undefined) window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => { this.error = ""; }, 5000);
  }

  announce(message: string): void {
    this.announcement = "";
    window.setTimeout(() => { this.announcement = message; }, 0);
  }

  character(id: string): CharacterDefinition | undefined {
    return this.catalog?.characters.find((character) => character.id === id);
  }

  entity(id: string) {
    return this.catalog ? entityById(this.catalog, id) : undefined;
  }

  costume(id: string): CostumeDefinition | undefined {
    return this.catalog ? costumeById(this.catalog, id) : undefined;
  }

  legalFor(unitId: number): LegalActions | undefined {
    return this.snapshot?.legal.find((entry) => Number(entry.unit_id) === Number(unitId));
  }

  selectedCommandIndex(unitId: number): number {
    return this.plannedCommands.get(Number(unitId)) ?? 0;
  }

  effectivePosition(unit: BattleUnit) {
    return this.plannedFormation[String(unit.id)] ?? unit.position;
  }

  open(name: DialogName): void {
    this.cancelAutoTurn();
    if (name === "pause") this.paused = this.executing;
    if (name === "profiles") this.openProfiles();
    this.dialog = name;
  }

  close(name: DialogName): void {
    if (this.dialog === name) {
      this.dialog = this.returnDialog;
      this.returnDialog = null;
    }
    if (name === "picker") this.pickerTarget = null;
    if (name === "profiles") this.profileDrafts = new SvelteMap();
    if (name === "pause") this.paused = false;
    this.scheduleAutoTurn();
  }

  applySnapshot(data: BattleSnapshot): void {
    this.snapshot = data;
    if (data.state.terminal) {
      this.autoTurnEnabled = false;
      this.cancelAutoTurn();
    }
    const golden = data.state.rules.mode === "GOLDEN_COLOSSEUM";
    const planSide: Side = golden ? data.state.active_side : "PLAYER";
    this.plannedOrder = (data.state.teams.find((team) => team.side === planSide)?.action_order ?? []).map(Number);
    const commands = new SvelteMap<number, number>(this.plannedOrder.map((id) => [id, 0] as const));
    if (golden && data.auto_plan) {
      for (const [rawId, command] of Object.entries(data.auto_plan.commands)) {
        const entry = data.legal.find((item) => Number(item.unit_id) === Number(rawId));
        const index = entry?.commands.findIndex((item) => item.type === command.type
          && item.costume_id === command.costume_id
          && Number(item.burst_level ?? 0) === Number(command.burst_level ?? 0));
        if (index !== undefined && index >= 0) commands.set(Number(rawId), index);
      }
    }
    this.plannedCommands = commands;
    this.plannedBurstLevels = new SvelteMap();
    this.plannedFormation = Object.fromEntries(
      Object.values(data.state.units)
        .filter((unit) => unit.alive && unit.side === "PLAYER" && Number(unit.party_no || 1) === (data.state.monster_chaser?.current_party ?? 1))
        .map((unit) => [String(unit.id), clone(unit.position)]),
    );
    this.selectedUnitId = this.plannedOrder.find((id) => (this.legalFor(id)?.commands.length ?? 0) > 0) ?? null;
    if (this.autoReserveEnabled && !golden && this.currentPlayerTeam) {
      this.plannedCommands = autoReserve({
        order: this.actionableOrder,
        selections: this.plannedCommands,
        legalById: (id) => this.legalFor(Number(id)),
        costumeLookup: (id) => this.costume(id),
        sp: this.currentPlayerTeam.sp,
      });
    }
    this.updateTip();
    this.requestPreview();
    this.scheduleAutoTurn();
  }

  updateTip(): void {
    const state = this.snapshot?.state;
    if (!state) return;
    if (this.mode === "MONSTER_CHASER" && state.monster_chaser) {
      this.tip = t("tip.monster", {
        party: this.activeParty, current: state.monster_chaser.current_level, selected: state.monster_chaser.selected_level,
      });
    } else if (this.mode === "GOLDEN_COLOSSEUM" && state.golden_colosseum) {
      this.tip = t("tip.golden", {
        turn: state.golden_colosseum.all_turn,
        initiative: t("golden.initiative", { side: t(`battle.side.${state.golden_colosseum.initiative}`) }),
      });
    } else {
      this.tip = t(this.capabilities.formation ? "tip.editable" : "tip.locked");
    }
  }

  selectUnit = (unitId: number): void => {
    if (this.executing || !this.legalFor(unitId)) return;
    this.selectedUnitId = Number(unitId);
    this.requestPreview();
  };

  selectAction = (unitId: number, index: number): void => {
    if (this.executing || !this.currentPlayerTeam) return;
    const result = selectCommand({
      order: this.actionableOrder,
      selections: this.plannedCommands,
      legalById: (id) => this.legalFor(Number(id)),
      costumeLookup: (id) => this.costume(id),
      sp: this.currentPlayerTeam.sp,
    }, unitId, index);
    if (!result.accepted) {
      this.showError(t(result.reason === "INSUFFICIENT_SP" ? "error.insufficientSp" : "error.maskedAction"));
      return;
    }
    const selected = this.legalFor(unitId)?.commands[index];
    if (selected?.type === "USE_COSTUME" && selected.costume_id) {
      const next = new SvelteMap(this.plannedBurstLevels);
      next.set(`${unitId}:${selected.costume_id}`, Number(selected.burst_level ?? 0));
      this.plannedBurstLevels = next;
    }
    this.plannedCommands = result.selections;
    this.requestPreview();
  };

  moveOrder = (movingId: number, targetId: number, after = false): void => {
    if (movingId === targetId || !this.plannedOrder.includes(movingId) || !this.plannedOrder.includes(targetId)) return;
    const next = this.plannedOrder.filter((id) => id !== movingId);
    const targetIndex = next.indexOf(targetId);
    next.splice(targetIndex + (after ? 1 : 0), 0, movingId);
    this.plannedOrder = next;
    const unit = this.snapshot?.state.units[String(movingId)];
    if (unit) this.announce(t("order.moved", { name: this.entity(unit.character_id)?.name ?? unit.character_id, order: next.indexOf(movingId) + 1 }));
    this.requestPreview();
  };

  moveBattleUnit = (unitId: number, row: number, depth: number): boolean => {
    const unit = this.snapshot?.state.units[String(unitId)];
    if (this.executing || !unit) return false;
    if (!this.capabilities.formation || this.snapshot?.state.active_side !== "PLAYER" || this.snapshot.state.terminal) {
      this.showError(t("error.formationLocked"));
      return false;
    }
    if (!unit.alive || Number(unit.party_no || 1) !== this.activeParty) {
      this.showError(t("error.unitNotMovable"));
      return false;
    }
    try {
      const grid = this.snapshot.state.rules.grid;
      const result = moveFormation(this.plannedFormation, unitId, row, depth, { rows: grid.rows, depths: grid.depths });
      this.plannedFormation = result.formation;
      this.selectedUnitId = unitId;
      const name = this.entity(unit.character_id)?.name ?? unit.character_id;
      if (result.swappedUnitId) {
        const other = this.snapshot.state.units[result.swappedUnitId];
        const otherName = other ? (this.entity(other.character_id)?.name ?? other.character_id) : result.swappedUnitId;
        this.tip = t("formation.swapPending", { name, other: otherName });
        this.announce(t("formation.swap", { name, other: otherName }));
      } else if (result.moved) {
        this.tip = t("formation.movePending", { name, row: row + 1, depth: depth + 1 });
        this.announce(t("formation.move", { name, row: row + 1, depth: depth + 1 }));
      }
      this.requestPreview();
      return true;
    } catch (error) {
      this.showError(error);
      return false;
    }
  };

  toggleAutoReserve = (): void => {
    this.autoReserveEnabled = !this.autoReserveEnabled;
    if (this.autoReserveEnabled && this.currentPlayerTeam) {
      this.plannedCommands = autoReserve({
        order: this.actionableOrder,
        selections: this.plannedCommands,
        legalById: (id) => this.legalFor(Number(id)),
        costumeLookup: (id) => this.costume(id),
        sp: this.currentPlayerTeam.sp,
      });
    }
    this.requestPreview();
  };

  toggleAutoTurn = (): void => {
    if (this.snapshot?.state.terminal) {
      this.autoTurnEnabled = false;
      this.cancelAutoTurn();
      return;
    }
    this.autoTurnEnabled = !this.autoTurnEnabled;
    if (this.autoTurnEnabled) this.scheduleAutoTurn();
    else this.cancelAutoTurn();
  };

  cycleSpeed = (): void => {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 3 : 1;
    this.scheduleAutoTurn();
  };

  requestPreview(): void {
    this.previewGeneration += 1;
    const generation = this.previewGeneration;
    if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
    this.previewController?.abort();
    this.previewController = null;
    this.preview = null;
    const unit = this.selectedUnit;
    const command = this.selectedCommand;
    if (!unit || !command || this.executing) return;
    this.previewTimer = window.setTimeout(() => {
      if (generation !== this.previewGeneration || this.selectedUnitId !== unit.id) return;
      const controller = new AbortController();
      this.previewController = controller;
      this.previewPending = true;
      const formation = this.capabilities.formation
        ? serializeFormation(this.plannedFormation, this.playerUnits.map((item) => item.id))
        : {};
      void battleApi.preview({
        unit_id: unit.id,
        action_index: this.selectedCommandIndex(unit.id),
        order: this.plannedOrder,
        formation,
        actions: actionIndices(this.plannedOrder, this.plannedCommands),
      }, controller.signal).then((preview) => {
        if (generation === this.previewGeneration && this.selectedUnitId === unit.id) this.preview = preview;
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError") && generation === this.previewGeneration) this.showError(error);
      }).finally(() => {
        if (this.previewController === controller) this.previewController = null;
        if (generation === this.previewGeneration) this.previewPending = false;
      });
    }, 120);
  }

  executePlan = async (): Promise<void> => {
    if (this.busy || this.executing || !this.snapshot || this.snapshot.state.terminal) return;
    this.cancelAutoTurn();
    const before = this.snapshot;
    try {
      const result = await this.withBusy(
        this.mode === "GOLDEN_COLOSSEUM" ? t("status.goldenActing") : this.mode === "MONSTER_CHASER" ? t("status.monsterActing") : t("status.enemyThinking"),
        () => this.mode === "GOLDEN_COLOSSEUM"
          ? battleApi.aiStep()
          : battleApi.step(
              actionIndices(this.plannedOrder, this.plannedCommands),
              this.plannedOrder,
              this.capabilities.formation
                ? serializeFormation(this.plannedFormation, this.playerUnits.filter((unit) => unit.alive).map((unit) => unit.id))
                : {},
            ),
      );
      if (await this.playEvents(before, result)) this.applySnapshot(result);
    } catch {
      this.cancelPlayback();
      this.scheduleAutoTurn();
    }
  };

  aiStep = async (): Promise<void> => {
    if (!this.snapshot) return;
    const before = this.snapshot;
    try {
      const result = await this.withBusy(t("status.playerThinking"), () => battleApi.aiStep());
      this.close("pause");
      if (await this.playEvents(before, result)) this.applySnapshot(result);
    } catch {
      this.cancelPlayback();
    }
  };

  resetBattle = async (): Promise<void> => {
    this.cancelPlayback();
    try {
      const result = await this.withBusy(t("status.resetting"), () => battleApi.reset(this.setupSeed));
      this.applySnapshot(result);
      this.close("pause");
    } catch { /* surfaced by withBusy */ }
  };

  rollbackBattle = async (): Promise<void> => {
    this.cancelPlayback();
    try {
      const result = await this.withBusy(t("status.rollingBack"), () => battleApi.rollback());
      this.applySnapshot(result);
      this.close("pause");
    } catch { /* surfaced by withBusy */ }
  };

  private async playEvents(before: BattleSnapshot, result: BattleSnapshot): Promise<boolean> {
    const generation = ++this.playbackGeneration;
    this.executing = true;
    this.paused = false;
    this.preview = null;
    this.playbackUnits = clone(before.state.units);
    for (const [unitId, position] of Object.entries(this.plannedFormation)) {
      const unit = this.playbackUnits[unitId];
      if (unit) unit.position = clone(position);
    }
    this.playbackCreated = new SvelteSet();
    this.playbackMonster = clone(before.state.monster_chaser);
    this.playbackParty = before.state.monster_chaser?.current_party ?? null;
    this.playbackSp = before.state.teams.find((team) => team.side === "PLAYER")?.sp ?? null;
    this.playbackCanRollback = result.can_rollback;
    const lastSequence = Math.max(-1, ...before.state.event_log.map((event) => event.sequence));
    const events = result.state.event_log.filter((event) => event.sequence > lastSequence);
    for (const event of events) {
      if (!await this.playEvent(event, result, generation)) return false;
    }
    if (generation !== this.playbackGeneration) return false;
    this.executing = false;
    this.paused = false;
    this.cue = { title: "", detail: "", turn: "" };
    this.floating = [];
    this.playbackActorId = null;
    this.playbackTargetId = null;
    this.playbackTargetCell = null;
    return true;
  }

  private async playEvent(event: BattleEvent, result: BattleSnapshot, generation: number): Promise<boolean> {
    const turn = event.turn === undefined ? "" : t("battle.turn", { turn: event.turn });
    const actorId = eventNumber(event, "actor_id");
    const targetId = eventNumber(event, "target_id") || eventNumber(event, "unit_id");
    const unitName = (unitId: number): string => {
      const unit = result.state.units[String(unitId)] ?? this.playbackUnits[String(unitId)];
      return unit ? (this.entity(unit.character_id)?.name ?? unit.character_id) : `#${unitId}`;
    };
    switch (event.kind.type) {
      case "ACTION_STARTED":
      case "ACTION_DECLARED":
        this.playbackTargetId = null;
        this.playbackTargetCell = null;
        this.playbackActorId = actorId;
        this.cue = { title: unitName(actorId), detail: eventString(event, "skill_name") || eventString(event, "action_type"), turn };
        return this.animationSleep(260, generation);
      case "TARGET_LOCKED":
        this.playbackTargetCell = null;
        this.playbackTargetId = targetId;
        this.cue = { title: unitName(actorId), detail: t("battle.targeted", { name: unitName(targetId) }), turn };
        return this.animationSleep(180, generation);
      case "TARGET_CELL_LOCKED": {
        const actor = result.state.units[String(actorId)];
        const cell = event.kind.cell;
        if (actor && typeof cell === "object" && cell !== null && "row" in cell && "depth" in cell
          && typeof cell.row === "number" && typeof cell.depth === "number") {
          this.playbackTargetId = null;
          this.playbackTargetCell = {
            side: actor.side === "PLAYER" ? "ENEMY" : "PLAYER",
            row: cell.row,
            depth: cell.depth,
          };
          this.cue = { title: unitName(actorId), detail: t("battle.targetCell", { row: cell.row + 1, depth: cell.depth + 1 }), turn };
        }
        return this.animationSleep(180, generation);
      }
      case "DAMAGE_APPLIED": {
        const amount = eventNumber(event, "amount");
        this.addFloating(targetId, `−${formatNumber(amount)}`, event.kind.critical === true ? "critical" : "");
        const target = this.playbackUnits[String(targetId)];
        if (target) {
          target.hp = Math.max(0, eventNumber(event, "hp_after"));
          if (target.side === "ENEMY" && this.playbackMonster) {
            this.playbackMonster = { ...this.playbackMonster, battle_hp_remaining: target.hp };
          }
        }
        this.cue = { title: unitName(targetId), detail: t("battle.damage", { amount: formatNumber(amount) }), turn };
        return this.animationSleep(240, generation);
      }
      case "HEAL_APPLIED": {
        const amount = eventNumber(event, "amount");
        this.addFloating(targetId, `+${formatNumber(amount)}`, "heal");
        const target = this.playbackUnits[String(targetId)];
        if (target) target.hp = Math.max(0, eventNumber(event, "hp_after"));
        return this.animationSleep(220, generation);
      }
      case "CHAIN_CHANGED":
      case "CHAIN_UPDATED": {
        const chain = eventNumber(event, "after") || eventNumber(event, "chain") || eventNumber(event, "value");
        if (chain > 0) this.addFloating(targetId, t("battle.chain", { chain }), "chain");
        return this.animationSleep(180, generation);
      }
      case "UNIT_DIED":
      case "UNIT_DEFEATED": {
        const target = this.playbackUnits[String(targetId)];
        if (target) target.alive = false;
        this.cue = { title: unitName(targetId), detail: t("battle.defeated"), turn };
        return this.animationSleep(300, generation);
      }
      case "UNIT_SUMMONED": {
        const summoned = result.state.units[String(targetId)];
        if (summoned) {
          const visibleSummon = clone(summoned);
          visibleSummon.alive = true;
          visibleSummon.hp = visibleSummon.base_stats.max_hp;
          const position = event.kind.position;
          if (typeof position === "object" && position !== null && "row" in position && "depth" in position
            && typeof position.row === "number" && typeof position.depth === "number") {
            visibleSummon.position = { row: position.row, depth: position.depth };
          }
          this.playbackUnits[String(targetId)] = visibleSummon;
          const created = new SvelteSet(this.playbackCreated);
          created.add(targetId);
          this.playbackCreated = created;
        }
        this.addFloating(targetId, t("battle.summoned"), "heal");
        return this.animationSleep(360, generation);
      }
      case "UNIT_MOVED": {
        const target = this.playbackUnits[String(targetId)];
        const position = event.kind.to;
        if (target && typeof position === "object" && position !== null && "row" in position && "depth" in position
          && typeof position.row === "number" && typeof position.depth === "number") {
          target.position = { row: position.row, depth: position.depth };
        }
        return this.animationSleep(220, generation);
      }
      case "UNIT_REVIVED": {
        const target = this.playbackUnits[String(targetId)];
        if (target) {
          target.alive = true;
          target.hp = eventNumber(event, "hp");
        }
        return this.animationSleep(260, generation);
      }
      case "SP_CHANGED":
        if (eventString(event, "side") === "PLAYER") this.playbackSp = eventNumber(event, "after");
        return this.animationSleep(100, generation);
      case "MONSTER_PARTY_ACTIVATED": {
        const ids = Array.isArray(event.kind.unit_ids) ? event.kind.unit_ids.filter((id): id is number => typeof id === "number") : [];
        for (const id of ids) {
          const unit = result.state.units[String(id)];
          if (unit) this.playbackUnits[String(id)] = clone(unit);
        }
        this.playbackParty = eventNumber(event, "party_no");
        this.cue = { title: t("battle.partyActivated", { party: eventNumber(event, "party_no") }), detail: t("battle.partyActivatedDetail"), turn };
        return this.animationSleep(420, generation);
      }
      case "MONSTER_LEVEL_ADVANCED":
        if (this.playbackMonster) {
          this.playbackMonster = { ...this.playbackMonster, current_level: eventNumber(event, "to_level") };
        }
        this.cue = { title: t("battle.levelAdvanced", { level: eventNumber(event, "to_level") }), detail: t("battle.carryDamage", { amount: formatNumber(eventNumber(event, "carry_damage")) }), turn };
        return this.animationSleep(420, generation);
      case "BATTLE_ENDED":
        this.cue = { title: t("battle.ended"), detail: t(`battle.outcome.${eventString(event, "result") || result.state.terminal?.outcome || ""}`), turn };
        return this.animationSleep(480, generation);
      default:
        return this.animationSleep(60, generation);
    }
  }

  private addFloating(unitId: number, text: string, className: string): void {
    const cue = { id: ++this.floatingSequence, unitId, text, className };
    this.floating = [...this.floating, cue];
    window.setTimeout(() => { this.floating = this.floating.filter((item) => item.id !== cue.id); }, 900);
  }

  private async animationSleep(milliseconds: number, generation: number): Promise<boolean> {
    let remaining = milliseconds;
    let previous = performance.now();
    while (remaining > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      if (generation !== this.playbackGeneration) return false;
      const now = performance.now();
      if (!this.paused) remaining -= (now - previous) * this.speed;
      previous = now;
    }
    return generation === this.playbackGeneration;
  }

  cancelPlayback(): void {
    this.playbackGeneration += 1;
    this.executing = false;
    this.paused = false;
    this.cue = { title: "", detail: "", turn: "" };
    this.floating = [];
    this.playbackActorId = null;
    this.playbackTargetId = null;
    this.playbackTargetCell = null;
    this.playbackMonster = null;
    this.playbackParty = null;
    this.playbackSp = null;
    this.playbackCanRollback = false;
  }

  resume = (): void => {
    this.close("pause");
    this.paused = false;
  };

  scheduleAutoTurn(): void {
    this.cancelAutoTurn();
    if (!this.autoTurnEnabled || this.busy || this.executing || this.snapshot?.state.terminal || this.dialog !== null) return;
    if (!this.capabilities.automaticBattle && this.snapshot?.state.active_side !== "PLAYER") return;
    this.autoTimer = window.setTimeout(() => { void this.executePlan(); }, Math.max(180, 850 / this.speed));
  }

  cancelAutoTurn(): void {
    if (this.autoTimer !== undefined) window.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
  }

  battleLog(): string[] {
    return [...(this.snapshot?.state.event_log ?? [])].reverse().map((event) => humanEvent(event, (unitId) => {
      const unit = this.snapshot?.state.units[String(unitId)];
      return unit ? (this.entity(unit.character_id)?.name ?? unit.character_id) : `#${unitId}`;
    }));
  }

  loadDraft(preset: BattleSetup): void {
    if (!this.catalog || !this.profiles) return;
    const value = clone(preset);
    const playable = new SvelteSet(this.catalog.characters.map((character) => character.id));
    for (const side of ["player_units", "enemy_units"] as const) {
      value[side] = value[side].filter((unit) => playable.has(unit.character_id)).map((unit) => {
        const normalized: SetupUnit = {
          ...unit,
          equipment: clone(unit.equipment ?? {}),
          build_settings: clone(unit.build_settings ?? this.catalog!.build_settings_default),
          costumes: unit.costumes.map((costume) => ({ ...costume, enabled: costume.enabled !== false })),
        };
        return side === "player_units" ? this.applyProfile(normalized) : normalized;
      });
    }
    this.draft = value;
    this.editorParty = 1;
    this.editorFocus = { sideKey: "player_units", index: 0 };
    this.monsterLevel = value.monster_level ?? 6;
    this.advancedEditor = null;
  }

  loadPreset = (mode: BattleMode): void => {
    const preset = this.catalog?.presets[mode];
    if (preset) this.loadDraft(preset);
  };

  profileFor(characterId: string): CharacterProfile {
    const profile = this.profiles?.profiles.find((item) => item.character_id === characterId);
    if (!profile) throw new Error(`character profile is missing for ${characterId}`);
    return profile;
  }

  private applyProfile(unit: SetupUnit): SetupUnit {
    const character = this.character(unit.character_id);
    const profile = this.profileFor(unit.character_id);
    if (!character) throw new Error(`catalog character is missing for ${unit.character_id}`);
    const existing = new SvelteMap(unit.costumes.map((item) => [item.costume_id, item] as const));
    unit.costumes = profile.costumes.map((fixed) => ({
      ...fixed,
      permanent_potential_enabled: true,
      enabled: existing.get(fixed.costume_id)?.enabled !== false && existing.has(fixed.costume_id),
    }));
    unit.equipment = clone(profile.equipment);
    unit.build_settings = clone(unit.build_settings ?? this.catalog!.build_settings_default);
    unit.build_settings.awakening_enabled = profile.awakening_enabled;
    return unit;
  }

  partyUnits(sideKey: SetupSide): Array<{ unit: SetupUnit; index: number }> {
    if (!this.draft) return [];
    return this.draft[sideKey]
      .map((unit, index) => ({ unit, index }))
      .filter(({ unit }) => sideKey === "enemy_units" || this.draft?.mode !== "MONSTER_CHASER" || Number(unit.party_no) === this.editorParty);
  }

  moveDraftUnit = (sideKey: SetupSide, index: number, row: number, depth: number): void => {
    const focused = this.draft?.[sideKey][index];
    if (!focused || !this.draft) return;
    const source = { row: focused.row, depth: focused.depth };
    const occupiedIndex = this.draft[sideKey].findIndex((unit, candidate) => candidate !== index
      && unit.party_no === focused.party_no && unit.row === row && unit.depth === depth);
    focused.row = row;
    focused.depth = depth;
    if (occupiedIndex >= 0) {
      const occupied = this.draft[sideKey][occupiedIndex];
      if (occupied) {
        occupied.row = source.row;
        occupied.depth = source.depth;
        this.announce(t("formation.swap", { name: this.entity(focused.character_id)?.name ?? focused.character_id, other: this.entity(occupied.character_id)?.name ?? occupied.character_id }));
      }
    }
    this.editorFocus = { sideKey, index };
  };

  usedCostumeIds(sideKey: SetupSide, ignoredIndex = -1): Set<string> {
    return new SvelteSet((this.draft?.[sideKey] ?? [])
      .filter((_unit, index) => index !== ignoredIndex)
      .flatMap((unit) => unit.costumes.filter((item) => item.enabled !== false).map((item) => item.costume_id)));
  }

  defaultCostumes(character: CharacterDefinition, single: boolean, excluded: Set<string>, profile?: CharacterProfile): SetupUnit["costumes"] {
    const unavailable = new SvelteSet([...excluded, ...(single ? this.draft?.golden_colosseum?.banned_costume_ids ?? [] : [])]);
    const firstAvailable = character.costumes.findIndex((item) => !unavailable.has(item.id));
    const fixed = new SvelteMap((profile?.costumes ?? []).map((item) => [item.costume_id, item] as const));
    return character.costumes.map((costume, index) => ({
      costume_id: costume.id,
      enhancement: Number(fixed.get(costume.id)?.enhancement ?? costume.max_enhancement),
      burst_level: Number(fixed.get(costume.id)?.burst_level ?? costume.max_burst_level),
      potential_mask: Number(fixed.get(costume.id)?.potential_mask ?? costume.max_potential_mask),
      permanent_potential_enabled: true,
      enabled: single ? index === firstAvailable : true,
    }));
  }

  replaceDraftUnit(sideKey: SetupSide, index: number, unit: SetupUnit): void {
    if (!this.draft?.[sideKey][index]) return;
    this.draft[sideKey][index] = unit;
    this.editorFocus = { sideKey, index };
  }

  replaceDraftCharacter(sideKey: SetupSide, index: number, characterId: string): void {
    if (!this.draft) return;
    const unit = this.draft[sideKey][index];
    const character = this.character(characterId);
    if (!unit || !character) return;
    const player = sideKey === "player_units";
    const profile = player ? this.profileFor(characterId) : undefined;
    this.replaceDraftUnit(sideKey, index, {
      ...clone(unit),
      character_id: characterId,
      costumes: this.defaultCostumes(character, this.draft.mode === "GOLDEN_COLOSSEUM", this.usedCostumeIds(sideKey, index), profile),
      costume_link_target: null,
      equipment: player ? clone(profile?.equipment ?? {}) : {},
      build_settings: {
        ...clone(this.catalog?.build_settings_default ?? unit.build_settings),
        awakening_enabled: player ? Boolean(profile?.awakening_enabled) : (this.catalog?.build_settings_default.awakening_enabled ?? true),
      },
    });
  }

  removeDraftUnit(sideKey: SetupSide, index: number): void {
    if (!this.draft) return;
    this.draft[sideKey].splice(index, 1);
    this.editorFocus = { sideKey, index: Math.max(0, index - 1) };
    if (this.advancedEditor?.sideKey === sideKey && this.advancedEditor.index === index) this.advancedEditor = null;
  }

  openPicker(side: Side, party: number): void {
    if (!this.draft) return;
    const sideKey: SetupSide = side === "PLAYER" ? "player_units" : "enemy_units";
    const count = this.draft[sideKey].filter((unit) => unit.party_no === party).length;
    if (count >= this.draft.grid.deployment_limit) {
      this.showError(t("party.limit", { number: party, limit: this.draft.grid.deployment_limit }));
      return;
    }
    this.pickerTarget = { side, party };
    this.returnDialog = "formation";
    this.dialog = "picker";
  }

  addCharacter(side: Side, party: number, characterId: string): void {
    if (!this.draft || !this.catalog) return;
    const sideKey: SetupSide = side === "PLAYER" ? "player_units" : "enemy_units";
    const inParty = this.draft[sideKey].filter((unit) => unit.party_no === party);
    if (inParty.length >= this.draft.grid.deployment_limit) throw new Error(t("party.limit", { number: party, limit: this.draft.grid.deployment_limit }));
    const occupied = new SvelteSet(inParty.map((unit) => cellKey(unit.row, unit.depth)));
    const cell = Array.from({ length: this.draft.grid.rows * this.draft.grid.depths }, (_, index) => ({
      row: Math.floor(index / this.draft!.grid.depths), depth: index % this.draft!.grid.depths,
    })).find((candidate) => !this.draft!.grid.blocked.some(([row, depth]) => row === candidate.row && depth === candidate.depth)
      && !occupied.has(cellKey(candidate.row, candidate.depth)));
    const character = this.character(characterId);
    if (!cell) throw new Error(t("error.noFormationCell"));
    if (!character) throw new Error(t("error.unknownCharacter"));
    const usedCharacters = new SvelteSet(inParty.map((unit) => unit.character_id));
    if (this.draft.mode !== "GOLDEN_COLOSSEUM" && usedCharacters.has(character.id)) throw new Error(t("error.duplicateCharacter"));
    const excluded = this.usedCostumeIds(sideKey);
    const banned = new SvelteSet(this.draft.golden_colosseum?.banned_costume_ids ?? []);
    if (this.draft.mode === "GOLDEN_COLOSSEUM" && character.costumes.every((item) => excluded.has(item.id) || banned.has(item.id))) throw new Error(t("error.duplicateCostume"));
    const profile = side === "PLAYER" ? this.profileFor(character.id) : undefined;
    this.draft[sideKey].push({
      character_id: character.id,
      row: cell.row,
      depth: cell.depth,
      party_no: party,
      costumes: this.defaultCostumes(character, this.draft.mode === "GOLDEN_COLOSSEUM", excluded, profile),
      costume_link_target: null,
      equipment: side === "PLAYER" ? clone(profile?.equipment ?? {}) : {},
      build_settings: {
        ...clone(this.catalog.build_settings_default),
        awakening_enabled: side === "PLAYER" ? Boolean(profile?.awakening_enabled) : this.catalog.build_settings_default.awakening_enabled,
      },
    });
    this.editorFocus = { sideKey, index: this.draft[sideKey].length - 1 };
  }

  cleanUnit(unit: SetupUnit): SetupUnit {
    return {
      character_id: unit.character_id,
      row: Number(unit.row),
      depth: Number(unit.depth),
      party_no: Number(unit.party_no || 1),
      costumes: unit.costumes.filter((item) => item.enabled !== false).map((item) => ({
        costume_id: item.costume_id,
        enhancement: Number(item.enhancement),
        burst_level: Number(item.burst_level),
        potential_mask: Number(item.potential_mask),
        permanent_potential_enabled: true,
      })),
      costume_link_target: this.draft?.mode === "GOLDEN_COLOSSEUM" ? null : unit.costume_link_target,
      equipment: this.draft?.mode === "GOLDEN_COLOSSEUM" ? {} : clone(unit.equipment),
      build_settings: clone(unit.build_settings),
    };
  }

  startRequest(): BattleSetup {
    if (!this.draft) throw new Error("battle setup is unavailable");
    if (!Number.isInteger(this.setupSeed)
      || !Number.isInteger(this.monsterLevel) || this.monsterLevel < 1 || this.monsterLevel > 25
      || !Number.isInteger(this.mctsSimulations) || this.mctsSimulations < 1 || this.mctsSimulations > 2048) {
      throw new Error(t("error.invalidSetupNumber"));
    }
    return {
      ...clone(this.draft),
      player_units: this.draft.player_units.map((unit) => this.cleanUnit(unit)),
      enemy_units: this.draft.enemy_units.map((unit) => this.cleanUnit(unit)),
      monster_level: this.monsterLevel,
      seed: this.setupSeed,
      mcts_simulations: this.mctsSimulations,
    };
  }

  startBattle = async (): Promise<void> => {
    try {
      const started = await this.withBusy(t("status.preparingBattle"), () => battleApi.start(this.startRequest()));
      this.loadDraft(started.setup);
      this.setupSeed = started.seed;
      this.mctsSimulations = started.mcts.simulations;
      this.applySnapshot(started);
      this.close("formation");
    } catch { /* surfaced by withBusy */ }
  };

  saveSetup = async (): Promise<void> => {
    const name = this.savedSetupName.trim();
    if (!name) {
      this.showError(t("saved.nameRequired"));
      return;
    }
    try {
      const result = await this.withBusy(t("status.savingSetup"), () => battleApi.saveSetup(name, this.startRequest()));
      if (this.snapshot) this.snapshot = { ...this.snapshot, saved_setups: result.saved_setups };
      this.selectedSavedSetup = result.saved.name;
      this.savedSetupStatus = t("saved.saved", { name: result.saved.name, path: result.saved.scenario });
    } catch { /* surfaced by withBusy */ }
  };

  loadSetup = async (): Promise<void> => {
    const name = this.selectedSavedSetup || this.savedSetupName.trim();
    if (!name) {
      this.showError(t("saved.nameRequired"));
      return;
    }
    try {
      const loaded = await this.withBusy(t("status.loadingSetup"), () => battleApi.loadSetup(name));
      this.loadDraft(loaded.setup);
      this.setupSeed = loaded.seed;
      this.mctsSimulations = loaded.mcts.simulations;
      this.savedSetupName = name;
      this.savedSetupStatus = t("saved.loaded", { name });
      this.applySnapshot(loaded);
    } catch { /* surfaced by withBusy */ }
  };

  openProfiles(preferred?: string): void {
    this.profileDrafts = new SvelteMap();
    this.selectedProfileId = preferred ?? this.selectedProfileId ?? this.catalog?.characters[0]?.id ?? null;
    this.profileSearch = "";
    this.profileElementFilter = "ALL";
  }

  editableProfile(characterId: string): CharacterProfile {
    const existing = this.profileDrafts.get(characterId);
    if (existing) return existing;
    const profile = clone(this.profileFor(characterId));
    const next = new SvelteMap(this.profileDrafts);
    next.set(characterId, profile);
    this.profileDrafts = next;
    return profile;
  }

  profileDirty(characterId: string): boolean {
    const draft = this.profileDrafts.get(characterId);
    return draft !== undefined && JSON.stringify(draft) !== JSON.stringify(this.profileFor(characterId));
  }

  mutateProfile(characterId: string, mutate: (profile: CharacterProfile) => void): void {
    const profile = clone(this.editableProfile(characterId));
    mutate(profile);
    const next = new SvelteMap(this.profileDrafts);
    next.set(characterId, profile);
    this.profileDrafts = next;
  }

  saveProfile = async (characterId: string): Promise<void> => {
    try {
      const profile = this.editableProfile(characterId);
      const payload: Omit<CharacterProfile, "is_default"> = {
        character_id: profile.character_id,
        awakening_enabled: profile.awakening_enabled,
        costumes: clone(profile.costumes),
        equipment: clone(profile.equipment),
      };
      this.profiles = await this.withBusy(t("status.savingProfile"), () => battleApi.saveProfile(payload));
      const next = new SvelteMap(this.profileDrafts);
      next.delete(characterId);
      this.profileDrafts = next;
      if (this.draft) this.draft.player_units = this.draft.player_units.map((unit) => this.applyProfile(unit));
      this.tip = t("profiles.saved", { name: this.character(characterId)?.name ?? characterId });
    } catch { /* surfaced by withBusy */ }
  };

  resetProfile = async (characterId: string): Promise<void> => {
    try {
      this.profiles = await this.withBusy(t("status.resettingProfile"), () => battleApi.resetProfile(characterId));
      const next = new SvelteMap(this.profileDrafts);
      next.delete(characterId);
      this.profileDrafts = next;
      if (this.draft) this.draft.player_units = this.draft.player_units.map((unit) => this.applyProfile(unit));
      this.tip = t("profiles.resetDone", { name: this.character(characterId)?.name ?? characterId });
    } catch { /* surfaced by withBusy */ }
  };
}
