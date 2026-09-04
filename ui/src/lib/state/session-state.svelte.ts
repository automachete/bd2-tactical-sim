import { modeCapabilities } from "../battle-ui-model";
import { humanEvent } from "../presentation";
import type {
  BattleMode,
  BattleSnapshot,
  BattleTeam,
  LegalActions,
  ModeCapabilities,
  SavedSetup,
} from "../types";
import type { CatalogReader } from "./contracts";

export class SessionState {
  snapshot = $state<BattleSnapshot | null>(null);

  constructor(private readonly catalog: CatalogReader) {}

  get mode(): BattleMode {
    return this.snapshot?.state.rules.mode ?? "NORMAL";
  }

  get capabilities(): ModeCapabilities {
    return modeCapabilities(this.mode, this.snapshot?.state.rules.allow_formation_change ?? true);
  }

  get currentPlayerTeam(): BattleTeam | null {
    return this.snapshot?.state.teams.find((team) => team.side === "PLAYER") ?? null;
  }

  get savedSetups(): SavedSetup[] {
    return this.snapshot?.saved_setups ?? [];
  }

  setSnapshot(snapshot: BattleSnapshot): void {
    this.snapshot = snapshot;
  }

  updateSavedSetups(savedSetups: SavedSetup[]): void {
    if (this.snapshot) this.snapshot = { ...this.snapshot, saved_setups: savedSetups };
  }

  legalFor(unitId: number): LegalActions | undefined {
    return this.snapshot?.legal.find((entry) => Number(entry.unit_id) === Number(unitId));
  }

  battleLog(): string[] {
    return [...(this.snapshot?.state.event_log ?? [])].reverse().map((event) => humanEvent(event, (unitId) => {
      const unit = this.snapshot?.state.units[String(unitId)];
      return unit ? (this.catalog.entity(unit.character_id)?.name ?? unit.character_id) : `#${unitId}`;
    }));
  }
}
