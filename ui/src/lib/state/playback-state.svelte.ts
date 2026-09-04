import { SvelteMap, SvelteSet } from "svelte/reactivity";

import { t } from "../i18n";
import { eventCell, eventNumber, eventString, eventUnitIds } from "../playback-model";
import { formatNumber } from "../presentation";
import type {
  BattleEvent,
  BattleSnapshot,
  BattleUnit,
  MonsterChaserState,
  Side,
} from "../types";
import type { CatalogReader, SessionReader } from "./contracts";
import { snapshotClone } from "./snapshot-clone.svelte";

export type Cue = { title: string; detail: string; turn: string };
export type FloatingCue = { id: number; unitId: number; text: string; className: string };
export type PlaybackTargetCell = { side: Side; row: number; depth: number };

export class PlaybackState {
  speed = $state(1);
  executing = $state(false);
  paused = $state(false);
  cue = $state<Cue>({ title: "", detail: "", turn: "" });
  floating = $state<FloatingCue[]>([]);
  playbackUnits = $state<Record<string, BattleUnit>>({});
  playbackCreated = $state<Set<number>>(new SvelteSet());
  playbackTargetId = $state<number | null>(null);
  playbackTargetCell = $state<PlaybackTargetCell | null>(null);
  playbackActorId = $state<number | null>(null);
  playbackMonster = $state<MonsterChaserState | null>(null);
  playbackParty = $state<number | null>(null);
  playbackSp = $state<number | null>(null);
  playbackCanRollback = $state(false);

  private generation = 0;
  private floatingSequence = 0;
  private sleepCancellations = new SvelteMap<number, () => void>();
  private floatingTimers = new SvelteSet<number>();
  private disposed = false;

  constructor(
    private readonly session: SessionReader,
    private readonly catalog: CatalogReader,
  ) {}

  get units(): Record<string, BattleUnit> {
    return this.executing ? this.playbackUnits : (this.session.snapshot?.state.units ?? {});
  }

  get activeParty(): number {
    return this.executing
      ? this.playbackParty ?? 1
      : this.session.snapshot?.state.monster_chaser?.current_party ?? 1;
  }

  get monsterState(): MonsterChaserState | null {
    return this.executing ? this.playbackMonster : this.session.snapshot?.state.monster_chaser ?? null;
  }

  get canRollback(): boolean {
    return this.executing ? this.playbackCanRollback : Boolean(this.session.snapshot?.can_rollback);
  }

  get playerUnits(): BattleUnit[] {
    return Object.values(this.units).filter((unit) => (
      unit.side === "PLAYER" && Number(unit.party_no || 1) === this.activeParty
    ));
  }

  get enemyUnits(): BattleUnit[] {
    return Object.values(this.units).filter((unit) => unit.side === "ENEMY");
  }

  cycleSpeed(): void {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 3 : 1;
  }

  setPaused(paused: boolean): void {
    this.paused = paused && this.executing;
  }

  async playEvents(
    before: BattleSnapshot,
    result: BattleSnapshot,
    plannedFormation: Readonly<Record<string, { row: number; depth: number }>>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const generation = ++this.generation;
    this.executing = true;
    this.paused = false;
    this.playbackUnits = snapshotClone(before.state.units);
    for (const [unitId, position] of Object.entries(plannedFormation)) {
      const unit = this.playbackUnits[unitId];
      if (unit) unit.position = snapshotClone(position);
    }
    this.playbackCreated = new SvelteSet();
    this.playbackMonster = snapshotClone(before.state.monster_chaser);
    this.playbackParty = before.state.monster_chaser?.current_party ?? null;
    this.playbackSp = before.state.teams.find((team) => team.side === "PLAYER")?.sp ?? null;
    this.playbackCanRollback = result.can_rollback;
    const lastSequence = Math.max(-1, ...before.state.event_log.map((event) => event.sequence));
    const events = result.state.event_log.filter((event) => event.sequence > lastSequence);
    for (const event of events) {
      if (!await this.playEvent(event, result, generation)) return false;
    }
    if (generation !== this.generation || this.disposed) return false;
    this.finishPlayback();
    return true;
  }

  cancelPlayback(): void {
    this.generation += 1;
    this.cancelSleepTimers();
    this.finishPlayback();
    this.playbackMonster = null;
    this.playbackParty = null;
    this.playbackSp = null;
    this.playbackCanRollback = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPlayback();
  }

  private async playEvent(event: BattleEvent, result: BattleSnapshot, generation: number): Promise<boolean> {
    const turn = event.turn === undefined ? "" : t("battle.turn", { turn: event.turn });
    const actorId = eventNumber(event, "actor_id");
    const targetId = eventNumber(event, "target_id") || eventNumber(event, "unit_id");
    const unitName = (unitId: number): string => {
      const unit = result.state.units[String(unitId)] ?? this.playbackUnits[String(unitId)];
      return unit ? (this.catalog.entity(unit.character_id)?.name ?? unit.character_id) : `#${unitId}`;
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
        const cell = eventCell(event, "cell");
        if (actor && cell) {
          this.playbackTargetId = null;
          this.playbackTargetCell = { side: actor.side === "PLAYER" ? "ENEMY" : "PLAYER", ...cell };
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
          const visibleSummon = snapshotClone(summoned);
          visibleSummon.alive = true;
          visibleSummon.hp = visibleSummon.base_stats.max_hp;
          const position = eventCell(event, "position");
          if (position) visibleSummon.position = position;
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
        const position = eventCell(event, "to");
        if (target && position) target.position = position;
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
      case "MONSTER_PARTY_ACTIVATED":
        for (const id of eventUnitIds(event, "unit_ids")) {
          const unit = result.state.units[String(id)];
          if (unit) this.playbackUnits[String(id)] = snapshotClone(unit);
        }
        this.playbackParty = eventNumber(event, "party_no");
        this.cue = { title: t("battle.partyActivated", { party: eventNumber(event, "party_no") }), detail: t("battle.partyActivatedDetail"), turn };
        return this.animationSleep(420, generation);
      case "MONSTER_LEVEL_ADVANCED":
        if (this.playbackMonster) this.playbackMonster = { ...this.playbackMonster, current_level: eventNumber(event, "to_level") };
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
    const timer = window.setTimeout(() => {
      this.floatingTimers.delete(timer);
      if (!this.disposed) this.floating = this.floating.filter((item) => item.id !== cue.id);
    }, 900);
    this.floatingTimers.add(timer);
  }

  private async animationSleep(milliseconds: number, generation: number): Promise<boolean> {
    let remaining = milliseconds;
    let previous = performance.now();
    while (remaining > 0) {
      await this.sleep(20);
      if (generation !== this.generation || this.disposed) return false;
      const now = performance.now();
      if (!this.paused) remaining -= (now - previous) * this.speed;
      previous = now;
    }
    return generation === this.generation && !this.disposed;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        this.sleepCancellations.delete(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, milliseconds);
      this.sleepCancellations.set(timer, () => {
        window.clearTimeout(timer);
        finish();
      });
    });
  }

  private cancelSleepTimers(): void {
    const cancellations = [...this.sleepCancellations.values()];
    this.sleepCancellations.clear();
    for (const cancel of cancellations) cancel();
  }

  private finishPlayback(): void {
    for (const timer of this.floatingTimers) window.clearTimeout(timer);
    this.floatingTimers.clear();
    this.executing = false;
    this.paused = false;
    this.cue = { title: "", detail: "", turn: "" };
    this.floating = [];
    this.playbackActorId = null;
    this.playbackTargetId = null;
    this.playbackTargetCell = null;
  }
}
