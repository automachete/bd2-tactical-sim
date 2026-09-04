<script lang="ts">
  import { CURRENT_SP_CAP } from "../lib/battle-ui-model";
  import { t } from "../lib/i18n";
  import type { DialogState } from "../lib/state/dialog-state.svelte";
  import type { ExecutionState } from "../lib/state/execution-state.svelte";
  import type { FeedbackState } from "../lib/state/feedback-state.svelte";
  import type { PlanningState } from "../lib/state/planning-state.svelte";
  import type { PlaybackState } from "../lib/state/playback-state.svelte";
  import type { SessionState } from "../lib/state/session-state.svelte";

  let { dialogs, execution, feedback, fullscreenTarget, planning, playback, session }: {
    dialogs: DialogState;
    execution: ExecutionState;
    feedback: FeedbackState;
    fullscreenTarget: HTMLElement | null;
    planning: PlanningState;
    playback: PlaybackState;
    session: SessionState;
  } = $props();

  let bypassed = $derived(session.mode === "GOLDEN_COLOSSEUM");
  let breakdown = $derived(planning.sp);
  let disabled = $derived(Boolean(session.snapshot?.state.terminal)
    || feedback.busy
    || playback.executing
    || (!bypassed && session.snapshot?.state.active_side !== "PLAYER")
    || (!bypassed && breakdown.remaining < 0)
    || planning.plannedOrder.length === 0);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (!document.fullscreenElement) await fullscreenTarget?.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      feedback.showError(error);
    }
  };
</script>

<footer class="battle-footer">
  <div class="footer-tools">
    <button class="hud-button" id="open-formation" type="button" onclick={() => dialogs.open("formation")}><span>▦</span><span>{t("footer.preparation")}</span></button>
    <button class="hud-button" id="open-character-profiles" type="button" data-testid="open-character-profiles" onclick={() => dialogs.openProfiles()}><span>◇</span><span>{t("footer.characterProfiles")}</span></button>
    <button class="hud-button" id="screen-toggle" type="button" onclick={toggleFullscreen}><span>□</span><span>{t("footer.fullscreen")}</span></button>
  </div>
  <section
    class="sp-panel"
    class:sp-bypassed={bypassed}
    class:has-consumption={!bypassed && breakdown.consumed > 0}
    class:has-burst={!bypassed && breakdown.burst > 0}
    aria-label={t("footer.spAria")}
    aria-live="polite"
    aria-atomic="true"
  >
    <div class="sp-readout"><span class="sp-total"><small>{t("footer.skillPoint")}</small><strong id="sp-text">{bypassed ? "∞" : `${breakdown.remaining} / ${breakdown.cap}`}</strong></span></div>
    <span class="sr-only" id="sp-status">{bypassed ? t("golden.autoHelp") : t("footer.spStatus", { remaining: breakdown.remaining, consumed: breakdown.consumed, burst: breakdown.burst })}</span>
    <div class="sp-pips" id="sp-pips" aria-hidden="true">
      {#each Array.from({ length: CURRENT_SP_CAP }, (_, index) => index) as index (index)}
        <i
          class:filled={bypassed || index < breakdown.remaining}
          class:bypassed
          class:remaining={!bypassed && index < breakdown.remaining}
          class:spent={!bypassed && index >= breakdown.remaining && index < breakdown.remaining + breakdown.regularConsumed}
          class:burst={!bypassed && index >= breakdown.remaining + breakdown.regularConsumed && index < breakdown.current}
        ></i>
      {/each}
    </div>
  </section>
  <button class="battle-button" id="execute" type="button" data-testid="battle-start" {disabled} onclick={execution.executePlan}><span id="battle-turn">{t("battle.turn", { turn: session.snapshot?.state.game_turn ?? 1 })}</span><b>{t("footer.battle")}</b><i>{t("footer.start")}</i></button>
</footer>

{#if session.snapshot?.state.terminal && !playback.executing}
  <section class="terminal" id="terminal" role="alertdialog" aria-modal="true">
    <small>{t("battle.result")}</small>
    <strong id="terminal-outcome">{t(`battle.outcome.${session.snapshot.state.terminal.outcome}`)}</strong>
    <span id="terminal-reason">{t(`battle.reason.${session.snapshot.state.terminal.reason}`)}</span>
    <div class="terminal-actions">
      <button id="terminal-rollback" type="button" disabled={!playback.canRollback} onclick={execution.rollbackBattle}>{t("battle.previousTurn")}</button>
      <button id="terminal-log" class="secondary" type="button" data-testid="terminal-log" onclick={() => dialogs.open("log")}>{t("battle.viewLog")}</button>
      <button id="terminal-reset" type="button" onclick={execution.resetBattle}>{t("battle.retry")}</button>
    </div>
  </section>
{/if}
