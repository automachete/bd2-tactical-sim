import { SvelteMap, SvelteSet } from "svelte/reactivity";

import type { BattleApi } from "../api";
import {
  actionIndices,
  autoReserve,
  cellKey,
  moveFormation,
  plannedBurstSpCost,
  plannedSpCost,
  reorder,
  selectCommand,
  serializeFormation,
  spBreakdown,
} from "../battle-ui-model";
import type { SpBreakdown } from "../battle-ui-model";
import { t } from "../i18n";
import type {
  BattleCommand,
  BattleSnapshot,
  BattleUnit,
  Formation,
  PreviewResult,
  Side,
} from "../types";
import type { CatalogReader, FeedbackPort, PlaybackReader, SessionReader } from "./contracts";
import { snapshotClone } from "./snapshot-clone.svelte";

export class PlanningState {
  selectedUnitId = $state<number | null>(null);
  plannedOrder = $state<number[]>([]);
  plannedCommands = $state<Map<number, number>>(new SvelteMap());
  plannedBurstLevels = $state<Map<string, number>>(new SvelteMap());
  plannedFormation = $state<Formation>({});
  preview = $state<PreviewResult | null>(null);
  previewPending = $state(false);
  autoReserveEnabled = $state(false);

  private previewTimer: number | undefined;
  private previewController: AbortController | null = null;
  private previewGeneration = 0;
  private disposed = false;

  constructor(
    private readonly api: BattleApi,
    private readonly catalog: CatalogReader,
    private readonly session: SessionReader,
    private readonly playback: PlaybackReader,
    private readonly feedback: FeedbackPort,
  ) {}

  get selectedUnit(): BattleUnit | null {
    return this.selectedUnitId === null ? null : this.playback.units[String(this.selectedUnitId)] ?? null;
  }

  get selectedCommand(): BattleCommand | undefined {
    const unitId = this.selectedUnitId;
    return unitId === null ? undefined : this.session.legalFor(unitId)?.commands[this.selectedCommandIndex(unitId)];
  }

  get previewActionSkipped(): boolean {
    return this.preview !== null && (
      this.preview.resolved_command === null
      || this.preview.actor_events.some((event) => event.kind.type === "ACTION_SKIPPED")
    );
  }

  get actionableOrder(): number[] {
    return this.plannedOrder.filter((unitId) => this.session.legalFor(unitId) !== undefined);
  }

  get reservedSp(): number {
    if (!this.session.snapshot || !this.catalog.catalog) return 0;
    return plannedSpCost(
      this.actionableOrder,
      this.plannedCommands,
      (id) => this.session.legalFor(Number(id)),
      (id) => this.catalog.costume(id),
    );
  }

  get reservedBurstSp(): number {
    return plannedBurstSpCost(this.actionableOrder, this.plannedCommands, (id) => this.session.legalFor(Number(id)));
  }

  get sp(): SpBreakdown {
    const current = this.playback.executing
      ? this.playback.playbackSp ?? 0
      : this.session.currentPlayerTeam?.sp ?? 0;
    return spBreakdown({
      current,
      reserved: this.reservedSp,
      burst: this.reservedBurstSp,
      cap: this.session.snapshot?.state.rules.sp_cap ?? 20,
    });
  }

  get previewCells(): Set<string> {
    return new SvelteSet(
      (this.preview?.affected_cells ?? []).map((cell) => cellKey(cell.row, cell.depth)),
    );
  }

  get previewTargetIds(): Set<number> {
    return new SvelteSet(this.preview?.affected_unit_ids ?? []);
  }

  get selectedDamage(): number {
    return this.preview?.total_damage ?? 0;
  }

  selectedCommandIndex(unitId: number): number {
    return this.plannedCommands.get(Number(unitId)) ?? 0;
  }

  effectivePosition(unit: BattleUnit): { row: number; depth: number } {
    return this.plannedFormation[String(unit.id)] ?? unit.position;
  }

  applySnapshot(data: BattleSnapshot): void {
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
        .filter((unit) => unit.alive && unit.side === "PLAYER"
          && Number(unit.party_no || 1) === (data.state.monster_chaser?.current_party ?? 1))
        .map((unit) => [String(unit.id), snapshotClone(unit.position)]),
    );
    this.selectedUnitId = this.plannedOrder.find((id) => (this.session.legalFor(id)?.commands.length ?? 0) > 0) ?? null;
    if (this.autoReserveEnabled && !golden && this.session.currentPlayerTeam) this.reserveAutomatically();
    this.updateTip();
    this.requestPreview();
  }

  selectUnit = (unitId: number): void => {
    if (this.playback.executing || !this.session.legalFor(unitId)) return;
    this.selectedUnitId = Number(unitId);
    this.requestPreview();
  };

  selectAction = (unitId: number, index: number): void => {
    const team = this.session.currentPlayerTeam;
    if (this.playback.executing || !team) return;
    const result = selectCommand({
      order: this.actionableOrder,
      selections: this.plannedCommands,
      legalById: (id) => this.session.legalFor(Number(id)),
      costumeLookup: (id) => this.catalog.costume(id),
      sp: team.sp,
    }, unitId, index);
    if (!result.accepted) {
      this.feedback.showError(t(result.reason === "INSUFFICIENT_SP" ? "error.insufficientSp" : "error.maskedAction"));
      return;
    }
    const selected = this.session.legalFor(unitId)?.commands[index];
    if (selected?.type === "USE_COSTUME" && selected.costume_id) {
      const next = new SvelteMap(this.plannedBurstLevels);
      next.set(`${unitId}:${selected.costume_id}`, Number(selected.burst_level ?? 0));
      this.plannedBurstLevels = next;
    }
    this.plannedCommands = new SvelteMap(result.selections);
    this.requestPreview();
  };

  selectBurstLevel(key: string, level: number): void {
    const levels = new SvelteMap(this.plannedBurstLevels);
    levels.set(key, level);
    this.plannedBurstLevels = levels;
  }

  moveOrder = (movingId: number, targetId: number, after = false): void => {
    if (movingId === targetId || !this.plannedOrder.includes(movingId) || !this.plannedOrder.includes(targetId)) return;
    const next = this.plannedOrder.filter((id) => id !== movingId);
    next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, movingId);
    this.plannedOrder = next;
    const unit = this.session.snapshot?.state.units[String(movingId)];
    if (unit) this.feedback.announce(t("order.moved", {
      name: this.catalog.entity(unit.character_id)?.name ?? unit.character_id,
      order: next.indexOf(movingId) + 1,
    }));
    this.requestPreview();
  };

  moveOrderBy = (unitId: number, direction: number): boolean => {
    const next = reorder(this.plannedOrder, unitId, direction);
    if (!next.some((value, index) => value !== this.plannedOrder[index])) return false;
    this.plannedOrder = next;
    this.requestPreview();
    return true;
  };

  moveBattleUnit = (unitId: number, row: number, depth: number): boolean => {
    const snapshot = this.session.snapshot;
    const unit = snapshot?.state.units[String(unitId)];
    if (this.playback.executing || !snapshot || !unit) return false;
    if (!this.session.capabilities.formation || snapshot.state.active_side !== "PLAYER" || snapshot.state.terminal) {
      this.feedback.showError(t("error.formationLocked"));
      return false;
    }
    if (!unit.alive || Number(unit.party_no || 1) !== this.playback.activeParty) {
      this.feedback.showError(t("error.unitNotMovable"));
      return false;
    }
    try {
      const result = moveFormation(this.plannedFormation, unitId, row, depth, {
        rows: snapshot.state.rules.grid.rows,
        depths: snapshot.state.rules.grid.depths,
      });
      this.plannedFormation = result.formation;
      this.selectedUnitId = unitId;
      const name = this.catalog.entity(unit.character_id)?.name ?? unit.character_id;
      if (result.swappedUnitId) {
        const other = snapshot.state.units[result.swappedUnitId];
        const otherName = other ? (this.catalog.entity(other.character_id)?.name ?? other.character_id) : result.swappedUnitId;
        this.feedback.setTip(t("formation.swapPending", { name, other: otherName }));
        this.feedback.announce(t("formation.swap", { name, other: otherName }));
      } else if (result.moved) {
        this.feedback.setTip(t("formation.movePending", { name, row: row + 1, depth: depth + 1 }));
        this.feedback.announce(t("formation.move", { name, row: row + 1, depth: depth + 1 }));
      }
      this.requestPreview();
      return true;
    } catch (error) {
      this.feedback.showError(error);
      return false;
    }
  };

  toggleAutoReserve = (): void => {
    this.autoReserveEnabled = !this.autoReserveEnabled;
    if (this.autoReserveEnabled && this.session.currentPlayerTeam) this.reserveAutomatically();
    this.requestPreview();
  };

  actionIndices(): number[] {
    return actionIndices(this.plannedOrder, this.plannedCommands);
  }

  executableFormation(): Formation {
    return this.session.capabilities.formation
      ? serializeFormation(this.plannedFormation, this.playback.playerUnits.filter((unit) => unit.alive).map((unit) => unit.id))
      : {};
  }

  clearPreview(): void {
    this.previewGeneration += 1;
    if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.previewController?.abort();
    this.previewController = null;
    this.preview = null;
    this.previewPending = false;
  }

  requestPreview(): void {
    this.clearPreview();
    if (this.disposed) return;
    const generation = this.previewGeneration;
    const unit = this.selectedUnit;
    const command = this.selectedCommand;
    if (!unit || !command || this.playback.executing) return;
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = undefined;
      if (generation !== this.previewGeneration || this.selectedUnitId !== unit.id || this.disposed) return;
      const controller = new AbortController();
      this.previewController = controller;
      this.previewPending = true;
      const formation = this.session.capabilities.formation
        ? serializeFormation(this.plannedFormation, this.playback.playerUnits.map((item) => item.id))
        : {};
      void this.api.preview({
        unit_id: unit.id,
        action_index: this.selectedCommandIndex(unit.id),
        order: this.plannedOrder,
        formation,
        actions: this.actionIndices(),
      }, controller.signal).then((preview) => {
        if (generation === this.previewGeneration && this.selectedUnitId === unit.id && !this.disposed) this.preview = preview;
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")
          && generation === this.previewGeneration && !this.disposed) this.feedback.showError(error);
      }).finally(() => {
        if (this.previewController === controller) this.previewController = null;
        if (generation === this.previewGeneration && !this.disposed) this.previewPending = false;
      });
    }, 120);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPreview();
  }

  private reserveAutomatically(): void {
    const team = this.session.currentPlayerTeam;
    if (!team) return;
    this.plannedCommands = new SvelteMap(autoReserve({
      order: this.actionableOrder,
      selections: this.plannedCommands,
      legalById: (id) => this.session.legalFor(Number(id)),
      costumeLookup: (id) => this.catalog.costume(id),
      sp: team.sp,
    }));
  }

  private updateTip(): void {
    const state = this.session.snapshot?.state;
    if (!state) return;
    if (this.session.mode === "MONSTER_CHASER" && state.monster_chaser) {
      this.feedback.setTip(t("tip.monster", {
        party: this.playback.activeParty,
        current: state.monster_chaser.current_level,
        selected: state.monster_chaser.selected_level,
      }));
    } else if (this.session.mode === "GOLDEN_COLOSSEUM" && state.golden_colosseum) {
      this.feedback.setTip(t("tip.golden", {
        turn: state.golden_colosseum.all_turn,
        initiative: t("golden.initiative", { side: t(`battle.side.${state.golden_colosseum.initiative}`) }),
      }));
    } else {
      this.feedback.setTip(t(this.session.capabilities.formation ? "tip.editable" : "tip.locked"));
    }
  }
}
