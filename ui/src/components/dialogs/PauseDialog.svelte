<script lang="ts">
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";
  import type { PlaybackState } from "../../lib/state/playback-state.svelte";
  import type { SessionState } from "../../lib/state/session-state.svelte";

  let { dialogs, playback, session }: { dialogs: DialogState; playback: PlaybackState; session: SessionState } = $props();
</script>

{#if dialogs.dialog === "pause"}
  <dialog use:modal class="sim-dialog pause-dialog" id="pause-dialog" data-testid="pause-dialog" onclose={() => dialogs.close("pause")}>
    <section class="dialog-frame compact-dialog">
      <header class="dialog-title"><div><small>{t("pause.caption")}</small><h1>{t("pause.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("pause.closeAria")} onclick={() => dialogs.close("pause")}>×</button></header>
      <div class="menu-list">
        <button id="resume" type="button" onclick={dialogs.resume}><b>{t("pause.resume")}</b><small>{t("pause.resumeHelp")}</small></button>
        <button id="rollback" type="button" data-testid="rollback" disabled={!playback.canRollback} onclick={dialogs.rollbackBattle}><b>{t("pause.rollback")}</b><small>{t("pause.rollbackHelp")}</small></button>
        <button id="ai-step" class:hidden={["MONSTER_CHASER", "GOLDEN_COLOSSEUM"].includes(session.mode)} type="button" onclick={dialogs.aiStep}><b>{t("pause.ai")}</b><small>{t("pause.aiHelp")}</small></button>
        <button id="reset" type="button" onclick={dialogs.resetBattle}><b>{t("pause.reset")}</b><small>{t("pause.resetHelp")}</small></button>
        <button id="pause-formation" type="button" onclick={() => dialogs.openFormationFromPause()}><b>{t("pause.preparation")}</b><small>{t("pause.preparationHelp")}</small></button>
      </div>
      <p class="ai-report" id="pause-ai-report">{session.snapshot?.last_ai ? t(session.snapshot.last_ai.controller === "MCTS" ? "ai.mctsReport" : session.snapshot.last_ai.controller === "COLOSSEUM_AUTO" ? "ai.goldenReport" : "ai.ruleReport", { simulations: session.snapshot.last_ai.simulations ?? 0, candidates: session.snapshot.last_ai.candidates ?? 0, value: Number(session.snapshot.last_ai.root_value ?? 0).toFixed(3) }) : t("ai.idle")}</p>
    </section>
  </dialog>
{/if}
