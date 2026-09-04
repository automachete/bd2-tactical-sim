import { createBattleApi } from "../api";
import type { BattleApi } from "../api";
import { t } from "../i18n";
import type { BattleSnapshot } from "../types";
import { CatalogState } from "./catalog-state.svelte";
import { DialogState } from "./dialog-state.svelte";
import { ExecutionState } from "./execution-state.svelte";
import { FeedbackState } from "./feedback-state.svelte";
import { PlanningState } from "./planning-state.svelte";
import { PlaybackState } from "./playback-state.svelte";
import { ProfileState } from "./profile-state.svelte";
import { SessionState } from "./session-state.svelte";
import { SetupState } from "./setup-state.svelte";

export class BattleAppState {
  readonly catalog: CatalogState;
  readonly session: SessionState;
  readonly feedback: FeedbackState;
  readonly profiles: ProfileState;
  readonly setup: SetupState;
  readonly playback: PlaybackState;
  readonly planning: PlanningState;
  readonly execution: ExecutionState;
  readonly dialogs: DialogState;

  private disposed = false;

  constructor(private readonly api: BattleApi = createBattleApi()) {
    this.catalog = new CatalogState();
    this.feedback = new FeedbackState();
    this.session = new SessionState(this.catalog);
    this.profiles = new ProfileState(
      this.api,
      this.catalog,
      this.feedback,
      () => this.setup.refreshPlayerProfiles(),
    );
    this.setup = new SetupState(this.api, this.catalog, this.profiles, this.feedback, {
      acceptSnapshot: (snapshot) => this.acceptSnapshot(snapshot),
      updateSavedSetups: (savedSetups) => this.session.updateSavedSetups(savedSetups),
    });
    this.playback = new PlaybackState(this.session, this.catalog);
    this.planning = new PlanningState(this.api, this.catalog, this.session, this.playback, this.feedback);
    this.execution = new ExecutionState(this.api, this.session, this.planning, this.playback, this.feedback, {
      acceptSnapshot: (snapshot) => this.acceptSnapshot(snapshot),
      getResetSeed: () => this.setup.setupSeed,
    });
    this.dialogs = new DialogState(this.execution, this.playback, this.profiles, this.setup);
  }

  get ready(): boolean {
    return this.catalog.catalog !== null
      && this.profiles.profiles !== null
      && this.session.snapshot !== null
      && this.setup.draft !== null;
  }

  async initialize(): Promise<void> {
    await this.feedback.withBusy(t("status.loadingData"), async () => {
      const [catalog, profiles, snapshot] = await Promise.all([
        this.api.catalog(),
        this.api.profiles(),
        this.api.state(),
      ]);
      if (this.disposed) return;
      this.catalog.setCatalog(catalog);
      this.profiles.setProfiles(profiles);
      this.setup.initialize(snapshot.setup ?? catalog.presets[snapshot.state.rules.mode], snapshot);
      this.acceptSnapshot(snapshot);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dialogs.dispose();
    this.execution.dispose();
    this.planning.dispose();
    this.playback.dispose();
    this.setup.dispose();
    this.profiles.dispose();
    this.feedback.dispose();
  }

  private acceptSnapshot(snapshot: BattleSnapshot): void {
    if (this.disposed) return;
    this.session.setSnapshot(snapshot);
    this.planning.applySnapshot(snapshot);
    this.execution.onSnapshotApplied(snapshot);
  }
}
