import { SvelteSet } from "svelte/reactivity";

import { t } from "../i18n";

export class FeedbackState {
  busy = $state(false);
  busyLabel = $state(t("status.busy"));
  error = $state("");
  tip = $state(t("board.initialTip"));
  announcement = $state("");

  private errorTimer: number | undefined;
  private announcementTimers = new SvelteSet<number>();
  private disposed = false;

  async withBusy<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (!this.disposed) {
      this.busy = true;
      this.busyLabel = label;
    }
    try {
      return await operation();
    } catch (error) {
      this.showError(error);
      throw error;
    } finally {
      if (!this.disposed) this.busy = false;
    }
  }

  showError = (error: unknown): void => {
    if (this.disposed) return;
    this.error = error instanceof Error ? error.message : String(error);
    this.announce(this.error);
    if (this.errorTimer !== undefined) window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.errorTimer = undefined;
      if (!this.disposed) this.error = "";
    }, 5000);
  };

  announce = (message: string): void => {
    if (this.disposed) return;
    this.announcement = "";
    const timer = window.setTimeout(() => {
      this.announcementTimers.delete(timer);
      if (!this.disposed) this.announcement = message;
    }, 0);
    this.announcementTimers.add(timer);
  };

  setTip(message: string): void {
    if (!this.disposed) this.tip = message;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.errorTimer !== undefined) window.clearTimeout(this.errorTimer);
    this.errorTimer = undefined;
    for (const timer of this.announcementTimers) window.clearTimeout(timer);
    this.announcementTimers.clear();
    this.busy = false;
  }
}
