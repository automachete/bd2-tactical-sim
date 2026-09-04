import type { Side } from "../types";
import type { ExecutionState } from "./execution-state.svelte";
import type { PlaybackState } from "./playback-state.svelte";
import type { ProfileState } from "./profile-state.svelte";
import type { SetupState } from "./setup-state.svelte";

export type DialogName = "formation" | "profiles" | "picker" | "pause" | "log" | "help" | "inspect";
export type PickerTarget = { side: Side; party: number };

export class DialogState {
  dialog = $state<DialogName | null>(null);
  returnDialog = $state<DialogName | null>(null);
  inspectedUnitId = $state<number | null>(null);
  pickerTarget = $state<PickerTarget | null>(null);

  private disposed = false;

  constructor(
    private readonly execution: ExecutionState,
    private readonly playback: PlaybackState,
    private readonly profiles: ProfileState,
    private readonly setup: SetupState,
  ) {}

  open(name: DialogName): void {
    if (this.disposed) return;
    if (name === "pause") this.playback.setPaused(this.playback.executing);
    if (name === "profiles") this.profiles.openProfiles();
    this.dialog = name;
    this.execution.setDialogBlocked(true);
  }

  close(name: DialogName): void {
    if (this.disposed) return;
    if (this.dialog === name) {
      this.dialog = this.returnDialog;
      this.returnDialog = null;
    }
    if (name === "picker") this.pickerTarget = null;
    if (name === "profiles") this.profiles.discardDrafts();
    if (name === "pause") this.playback.setPaused(false);
    this.execution.setDialogBlocked(this.dialog !== null);
  }

  openProfiles(preferred?: string, returnDialog: DialogName | null = null): void {
    if (this.disposed) return;
    this.returnDialog = returnDialog;
    this.profiles.openProfiles(preferred);
    this.dialog = "profiles";
    this.execution.setDialogBlocked(true);
  }

  openPicker(side: Side, party: number): void {
    if (this.disposed || !this.setup.canOpenPicker(side, party)) return;
    this.pickerTarget = { side, party };
    this.returnDialog = "formation";
    this.dialog = "picker";
    this.execution.setDialogBlocked(true);
  }

  inspect(unitId: number): void {
    this.inspectedUnitId = unitId;
    this.open("inspect");
  }

  resume = (): void => {
    this.close("pause");
    this.playback.setPaused(false);
  };

  openFormationFromPause(): void {
    this.playback.cancelPlayback();
    this.close("pause");
    this.open("formation");
  }

  startBattle = async (): Promise<void> => {
    if (await this.setup.startBattle()) this.close("formation");
  };

  aiStep = async (): Promise<void> => {
    await this.execution.aiStep(() => this.close("pause"));
  };

  resetBattle = async (): Promise<void> => {
    if (await this.execution.resetBattle()) this.close("pause");
  };

  rollbackBattle = async (): Promise<void> => {
    if (await this.execution.rollbackBattle()) this.close("pause");
  };

  dispose(): void {
    this.disposed = true;
    this.dialog = null;
    this.returnDialog = null;
    this.pickerTarget = null;
    this.execution.setDialogBlocked(true);
  }
}
