<script lang="ts">
  import { onMount } from "svelte";

  import ActionOrder from "./components/ActionOrder.svelte";
  import BattleBoard from "./components/BattleBoard.svelte";
  import CommandSelection from "./components/CommandSelection.svelte";
  import EnemyInfo from "./components/EnemyInfo.svelte";
  import FooterSp from "./components/FooterSp.svelte";
  import HeaderBar from "./components/HeaderBar.svelte";
  import NotificationLayer from "./components/NotificationLayer.svelte";
  import CharacterPickerDialog from "./components/dialogs/CharacterPickerDialog.svelte";
  import CharacterProfilesDialog from "./components/dialogs/CharacterProfilesDialog.svelte";
  import HelpDialog from "./components/dialogs/HelpDialog.svelte";
  import InspectDialog from "./components/dialogs/InspectDialog.svelte";
  import LogDialog from "./components/dialogs/LogDialog.svelte";
  import PauseDialog from "./components/dialogs/PauseDialog.svelte";
  import PreparationDialog from "./components/dialogs/PreparationDialog.svelte";
  import { BattleState } from "./lib/battle-state.svelte";
  import { t } from "./lib/i18n";
  import { elementClass } from "./lib/presentation";

  const model = new BattleState();
  let shell = $state<HTMLElement | null>(null);
  let activeElement = $derived(elementClass(model.selectedUnit ? model.entity(model.selectedUnit.character_id)?.element : undefined));
  let modeClass = $derived(model.mode === "MIRROR_WAR" ? "mirror" : model.mode === "MONSTER_CHASER" ? "monster" : model.mode === "GOLDEN_COLOSSEUM" ? "golden" : "normal");

  onMount(() => { void model.initialize(); });
</script>

<svelte:head><title>{t("app.title")}</title></svelte:head>

<main
  bind:this={shell}
  class={`simulator-shell ${modeClass}`}
  class:executing={model.executing}
  id="game-shell"
  data-testid="simulator-shell"
  data-mode={model.mode}
  data-active-element={activeElement}
  style:--speed-duration={`${Math.round(180 / model.speed)}ms`}
  style:--playback-speed={model.speed}
>
  <HeaderBar {model} />
  <section class="battle-workspace">
    <aside class="reservation-workbench" aria-label={t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.workbenchAria" : "reservation.workbenchAria")}>
      <ActionOrder {model} />
      <CommandSelection {model} />
    </aside>
    <section class="battle-center"><BattleBoard {model} /></section>
    <EnemyInfo {model} />
  </section>
  <FooterSp {model} fullscreenTarget={shell} />
</main>

<PreparationDialog {model} />
<CharacterProfilesDialog {model} />
<CharacterPickerDialog {model} />
<PauseDialog {model} />
<LogDialog {model} />
<HelpDialog {model} />
<InspectDialog {model} />
<NotificationLayer {model} />
