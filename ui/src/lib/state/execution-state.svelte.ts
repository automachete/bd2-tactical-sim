import type { BattleApi } from "../api";
import { t } from "../i18n";
import type { BattleSnapshot } from "../types";
import type { FeedbackPort, SessionReader } from "./contracts";
import type { PlanningState } from "./planning-state.svelte";
import type { PlaybackState } from "./playback-state.svelte";

type ExecutionEvents = {
  acceptSnapshot: (snapshot: BattleSnapshot) => void;
  getResetSeed: () => number;
};

export class ExecutionState {
  autoTurnEnabled = $state(false);

  private autoTimer: number | undefined;
  private dialogBlocked = false;
  private disposed = false;

  constructor(
    private readonly api: BattleApi,
    private readonly session: SessionReader,
    private readonly planning: PlanningState,
    private readonly playback: PlaybackState,
    private readonly feedback: FeedbackPort,
    private readonly events: ExecutionEvents,
  ) {}

  executePlan = async (): Promise<void> => {
    const snapshot = this.session.snapshot;
    if (this.disposed || this.feedback.busy || this.playback.executing || !snapshot || snapshot.state.terminal) return;
    this.cancelAutoTurn();
    const before = snapshot;
    try {
      const result = await this.feedback.withBusy(
        this.session.mode === "GOLDEN_COLOSSEUM"
          ? t("status.goldenActing")
          : this.session.mode === "MONSTER_CHASER"
            ? t("status.monsterActing")
            : t("status.enemyThinking"),
        () => this.session.mode === "GOLDEN_COLOSSEUM"
          ? this.api.aiStep()
          : this.api.step(
              this.planning.actionIndices(),
              this.planning.plannedOrder,
              this.planning.executableFormation(),
            ),
      );
      if (this.disposed) return;
      this.planning.clearPreview();
      if (await this.playback.playEvents(before, result, this.planning.plannedFormation)) {
        this.events.acceptSnapshot(result);
      }
    } catch {
      this.playback.cancelPlayback();
      this.scheduleAutoTurn();
    }
  };

  async aiStep(beforePlayback?: () => void): Promise<boolean> {
    const before = this.session.snapshot;
    if (!before || this.disposed) return false;
    try {
      const result = await this.feedback.withBusy(t("status.playerThinking"), () => this.api.aiStep());
      if (this.disposed) return false;
      beforePlayback?.();
      this.planning.clearPreview();
      if (await this.playback.playEvents(before, result, this.planning.plannedFormation)) {
        this.events.acceptSnapshot(result);
        return true;
      }
    } catch {
      this.playback.cancelPlayback();
    }
    return false;
  }

  resetBattle = async (): Promise<boolean> => {
    this.playback.cancelPlayback();
    try {
      const result = await this.feedback.withBusy(t("status.resetting"), () => this.api.reset(this.events.getResetSeed()));
      if (this.disposed) return false;
      this.events.acceptSnapshot(result);
      return true;
    } catch {
      return false;
    }
  };

  rollbackBattle = async (): Promise<boolean> => {
    this.playback.cancelPlayback();
    try {
      const result = await this.feedback.withBusy(t("status.rollingBack"), () => this.api.rollback());
      if (this.disposed) return false;
      this.events.acceptSnapshot(result);
      return true;
    } catch {
      return false;
    }
  };

  toggleAutoTurn = (): void => {
    if (this.session.snapshot?.state.terminal) {
      this.autoTurnEnabled = false;
      this.cancelAutoTurn();
      return;
    }
    this.autoTurnEnabled = !this.autoTurnEnabled;
    if (this.autoTurnEnabled) this.scheduleAutoTurn();
    else this.cancelAutoTurn();
  };

  cycleSpeed = (): void => {
    this.playback.cycleSpeed();
    this.scheduleAutoTurn();
  };

  setDialogBlocked(blocked: boolean): void {
    this.dialogBlocked = blocked;
    if (blocked) this.cancelAutoTurn();
    else this.scheduleAutoTurn();
  }

  onSnapshotApplied(snapshot: BattleSnapshot): void {
    if (snapshot.state.terminal) {
      this.autoTurnEnabled = false;
      this.cancelAutoTurn();
    } else {
      this.scheduleAutoTurn();
    }
  }

  scheduleAutoTurn(): void {
    this.cancelAutoTurn();
    const snapshot = this.session.snapshot;
    if (this.disposed || !this.autoTurnEnabled || this.feedback.busy || this.playback.executing
      || snapshot?.state.terminal || this.dialogBlocked) return;
    if (!this.session.capabilities.automaticBattle && snapshot?.state.active_side !== "PLAYER") return;
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = undefined;
      void this.executePlan();
    }, Math.max(180, 850 / this.playback.speed));
  }

  cancelAutoTurn(): void {
    if (this.autoTimer !== undefined) window.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAutoTurn();
  }
}
