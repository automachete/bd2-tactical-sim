import type { BattleApi } from "../api";
import { t } from "../i18n";
import {
  addSetupCharacter,
  applyProfileToUnit,
  createStartRequest,
  defaultCostumes,
  moveSetupUnit,
  normalizeSetupDraft,
  partyUnits,
  usedCostumeIds,
} from "../setup-model";
import type { PartyUnit } from "../setup-model";
import type {
  BattleMode,
  BattleSetup,
  BattleSnapshot,
  GoldenBlessingLoadout,
  GoldenSideBlessings,
  SavedSetup,
  SetupSide,
  SetupUnit,
  Side,
} from "../types";
import type { CatalogReader, FeedbackPort, ProfileReader } from "./contracts";
import { snapshotClone } from "./snapshot-clone.svelte";

export type EditorFocus = { sideKey: SetupSide; index: number };

type SetupEvents = {
  acceptSnapshot: (snapshot: BattleSnapshot) => void;
  updateSavedSetups: (savedSetups: SavedSetup[]) => void;
};

export class SetupState {
  draft = $state<BattleSetup | null>(null);
  editorParty = $state(1);
  editorFocus = $state<EditorFocus>({ sideKey: "player_units", index: 0 });
  advancedEditor = $state<EditorFocus | null>(null);
  setupSeed = $state(42);
  monsterLevel = $state(6);
  mctsSimulations = $state(48);
  savedSetupName = $state("");
  selectedSavedSetup = $state("");
  savedSetupStatus = $state("");

  private disposed = false;

  constructor(
    private readonly api: BattleApi,
    private readonly catalog: CatalogReader,
    private readonly profiles: ProfileReader,
    private readonly feedback: FeedbackPort,
    private readonly events: SetupEvents,
  ) {}

  get mode(): BattleMode {
    return this.draft?.mode ?? "NORMAL";
  }

  initialize(preset: BattleSetup, snapshot: BattleSnapshot): void {
    this.setupSeed = snapshot.seed;
    this.mctsSimulations = snapshot.mcts.simulations;
    this.monsterLevel = snapshot.setup.monster_level ?? 6;
    this.loadDraft(preset);
  }

  loadDraft(preset: BattleSetup): void {
    const catalog = this.catalog.catalog;
    if (!catalog) return;
    this.draft = normalizeSetupDraft(
      snapshotClone(preset),
      snapshotClone(catalog),
      (characterId) => snapshotClone(this.profiles.profileFor(characterId)),
    );
    this.editorParty = 1;
    this.editorFocus = { sideKey: "player_units", index: 0 };
    this.monsterLevel = this.draft.monster_level ?? 6;
    this.advancedEditor = null;
  }

  loadPreset = (mode: BattleMode): void => {
    const preset = this.catalog.catalog?.presets[mode];
    if (preset) this.loadDraft(preset);
  };

  selectEditorParty(party: number): void {
    this.editorParty = party;
    this.editorFocus = { sideKey: "player_units", index: this.partyUnits("player_units")[0]?.index ?? 0 };
  }

  focusUnit(sideKey: SetupSide, index: number): void {
    this.editorFocus = { sideKey, index };
  }

  openAdvancedEditor(sideKey: SetupSide, index: number): void {
    this.advancedEditor = { sideKey, index };
  }

  closeAdvancedEditor(): void {
    this.advancedEditor = null;
  }

  mutateGoldenLoadout(
    sideIndex: number,
    initiative: keyof GoldenSideBlessings,
    mutate: (loadout: GoldenBlessingLoadout) => void,
  ): void {
    if (!this.draft?.golden_colosseum) return;
    const next = snapshotClone(this.draft);
    const loadout = next.golden_colosseum?.side_blessings[sideIndex]?.[initiative];
    if (!loadout) return;
    mutate(loadout);
    this.draft = next;
  }

  refreshPlayerProfiles(): void {
    const catalog = this.catalog.catalog;
    if (!this.draft || !catalog) return;
    this.draft = {
      ...this.draft,
      player_units: this.draft.player_units.map((unit) => {
        const character = this.catalog.character(unit.character_id);
        if (!character) throw new Error(`catalog character is missing for ${unit.character_id}`);
        return applyProfileToUnit(
          snapshotClone(unit),
          snapshotClone(character),
          snapshotClone(this.profiles.profileFor(unit.character_id)),
          snapshotClone(catalog.build_settings_default),
        );
      }),
    };
  }

  partyUnits(sideKey: SetupSide): PartyUnit[] {
    return partyUnits(this.draft, sideKey, this.editorParty);
  }

  moveDraftUnit = (sideKey: SetupSide, index: number, row: number, depth: number): void => {
    const focused = this.draft?.[sideKey][index];
    if (!focused || !this.draft) return;
    const result = moveSetupUnit(snapshotClone(this.draft), sideKey, index, row, depth);
    this.draft = result.draft;
    if (result.swapped) {
      this.feedback.announce(t("formation.swap", {
        name: this.catalog.entity(focused.character_id)?.name ?? focused.character_id,
        other: this.catalog.entity(result.swapped.character_id)?.name ?? result.swapped.character_id,
      }));
    }
    this.editorFocus = { sideKey, index };
  };

  usedCostumeIds(sideKey: SetupSide, ignoredIndex = -1): Set<string> {
    return usedCostumeIds(this.draft, sideKey, ignoredIndex);
  }

  replaceDraftUnit(sideKey: SetupSide, index: number, unit: SetupUnit): void {
    if (!this.draft?.[sideKey][index]) return;
    const next = snapshotClone(this.draft);
    next[sideKey][index] = snapshotClone(unit);
    this.draft = next;
    this.editorFocus = { sideKey, index };
  }

  replaceDraftCharacter(sideKey: SetupSide, index: number, characterId: string): void {
    if (!this.draft) return;
    const unit = this.draft[sideKey][index];
    const character = this.catalog.character(characterId);
    const catalog = this.catalog.catalog;
    if (!unit || !character || !catalog) return;
    const player = sideKey === "player_units";
    const profile = player ? this.profiles.profileFor(characterId) : undefined;
    this.replaceDraftUnit(sideKey, index, {
      ...snapshotClone(unit),
      character_id: characterId,
      costumes: defaultCostumes(
        snapshotClone(this.draft),
        snapshotClone(character),
        this.draft.mode === "GOLDEN_COLOSSEUM",
        this.usedCostumeIds(sideKey, index),
        profile ? snapshotClone(profile) : undefined,
      ),
      costume_link_target: null,
      equipment: player ? snapshotClone(profile?.equipment ?? {}) : {},
      build_settings: {
        ...snapshotClone(catalog.build_settings_default ?? unit.build_settings),
        awakening_enabled: player ? Boolean(profile?.awakening_enabled) : catalog.build_settings_default.awakening_enabled,
      },
    });
  }

  removeDraftUnit(sideKey: SetupSide, index: number): void {
    if (!this.draft) return;
    const next = snapshotClone(this.draft);
    next[sideKey].splice(index, 1);
    this.draft = next;
    this.editorFocus = { sideKey, index: Math.max(0, index - 1) };
    if (this.advancedEditor?.sideKey === sideKey && this.advancedEditor.index === index) this.advancedEditor = null;
  }

  canOpenPicker(side: Side, party: number): boolean {
    if (!this.draft) return false;
    const sideKey: SetupSide = side === "PLAYER" ? "player_units" : "enemy_units";
    const count = this.draft[sideKey].filter((unit) => unit.party_no === party).length;
    if (count >= this.draft.grid.deployment_limit) {
      this.feedback.showError(t("party.limit", { number: party, limit: this.draft.grid.deployment_limit }));
      return false;
    }
    return true;
  }

  addCharacter(side: Side, party: number, characterId: string): void {
    const catalog = this.catalog.catalog;
    if (!this.draft || !catalog) return;
    const sideKey: SetupSide = side === "PLAYER" ? "player_units" : "enemy_units";
    const result = addSetupCharacter(
      snapshotClone(this.draft),
      snapshotClone(catalog),
      side,
      party,
      characterId,
      side === "PLAYER" && this.catalog.character(characterId)
        ? snapshotClone(this.profiles.profileFor(characterId))
        : undefined,
      {
        partyLimit: t("party.limit", { number: party, limit: this.draft.grid.deployment_limit }),
        noFormationCell: t("error.noFormationCell"),
        unknownCharacter: t("error.unknownCharacter"),
        duplicateCharacter: t("error.duplicateCharacter"),
        duplicateCostume: t("error.duplicateCostume"),
      },
    );
    this.draft = result.draft;
    this.editorFocus = { sideKey, index: result.index };
  }

  startRequest(): BattleSetup {
    if (!this.draft) throw new Error("battle setup is unavailable");
    return createStartRequest(
      snapshotClone(this.draft),
      this.setupSeed,
      this.monsterLevel,
      this.mctsSimulations,
      t("error.invalidSetupNumber"),
    );
  }

  startBattle = async (): Promise<boolean> => {
    try {
      const started = await this.feedback.withBusy(t("status.preparingBattle"), () => this.api.start(this.startRequest()));
      if (this.disposed) return false;
      this.loadDraft(started.setup);
      this.setupSeed = started.seed;
      this.mctsSimulations = started.mcts.simulations;
      this.events.acceptSnapshot(started);
      return true;
    } catch {
      return false;
    }
  };

  saveSetup = async (): Promise<void> => {
    const name = this.savedSetupName.trim();
    if (!name) {
      this.feedback.showError(t("saved.nameRequired"));
      return;
    }
    try {
      const result = await this.feedback.withBusy(t("status.savingSetup"), () => this.api.saveSetup(name, this.startRequest()));
      if (this.disposed) return;
      this.events.updateSavedSetups(result.saved_setups);
      this.selectedSavedSetup = result.saved.name;
      this.savedSetupStatus = t("saved.saved", { name: result.saved.name, path: result.saved.scenario });
    } catch { /* surfaced by FeedbackState */ }
  };

  loadSetup = async (): Promise<void> => {
    const name = this.selectedSavedSetup || this.savedSetupName.trim();
    if (!name) {
      this.feedback.showError(t("saved.nameRequired"));
      return;
    }
    try {
      const loaded = await this.feedback.withBusy(t("status.loadingSetup"), () => this.api.loadSetup(name));
      if (this.disposed) return;
      this.loadDraft(loaded.setup);
      this.setupSeed = loaded.seed;
      this.mctsSimulations = loaded.mcts.simulations;
      this.savedSetupName = name;
      this.savedSetupStatus = t("saved.loaded", { name });
      this.events.acceptSnapshot(loaded);
    } catch { /* surfaced by FeedbackState */ }
  };

  dispose(): void {
    this.disposed = true;
  }

}
