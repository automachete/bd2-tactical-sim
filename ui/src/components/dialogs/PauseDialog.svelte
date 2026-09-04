<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";

  let { model }: { model: BattleState } = $props();
</script>

{#if model.dialog === "pause"}
  <dialog use:modal class="sim-dialog pause-dialog" id="pause-dialog" data-testid="pause-dialog" onclose={() => model.close("pause")}>
    <section class="dialog-frame compact-dialog">
      <header class="dialog-title"><div><small>{t("pause.caption")}</small><h1>{t("pause.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("pause.closeAria")} onclick={() => model.close("pause")}>×</button></header>
      <div class="menu-list">
        <button id="resume" type="button" onclick={model.resume}><b>{t("pause.resume")}</b><small>{t("pause.resumeHelp")}</small></button>
        <button id="rollback" type="button" data-testid="rollback" disabled={!model.canRollback} onclick={model.rollbackBattle}><b>{t("pause.rollback")}</b><small>{t("pause.rollbackHelp")}</small></button>
        <button id="ai-step" class:hidden={["MONSTER_CHASER", "GOLDEN_COLOSSEUM"].includes(model.mode)} type="button" onclick={model.aiStep}><b>{t("pause.ai")}</b><small>{t("pause.aiHelp")}</small></button>
        <button id="reset" type="button" onclick={model.resetBattle}><b>{t("pause.reset")}</b><small>{t("pause.resetHelp")}</small></button>
        <button id="pause-formation" type="button" onclick={() => { model.cancelPlayback(); model.close("pause"); model.open("formation"); }}><b>{t("pause.preparation")}</b><small>{t("pause.preparationHelp")}</small></button>
      </div>
      <p class="ai-report" id="pause-ai-report">{model.snapshot?.last_ai ? t(model.snapshot.last_ai.controller === "MCTS" ? "ai.mctsReport" : model.snapshot.last_ai.controller === "COLOSSEUM_AUTO" ? "ai.goldenReport" : "ai.ruleReport", { simulations: model.snapshot.last_ai.simulations ?? 0, candidates: model.snapshot.last_ai.candidates ?? 0, value: Number(model.snapshot.last_ai.root_value ?? 0).toFixed(3) }) : t("ai.idle")}</p>
    </section>
  </dialog>
{/if}
