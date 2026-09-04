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
  import { t } from "./lib/i18n";
  import { elementClass } from "./lib/presentation";
  import { BattleAppState } from "./lib/state/app-state.svelte";

  const app = new BattleAppState();
  let shell = $state<HTMLElement | null>(null);
  let activeElement = $derived(elementClass(app.planning.selectedUnit ? app.catalog.entity(app.planning.selectedUnit.character_id)?.element : undefined));
  let modeClass = $derived(app.session.mode === "MIRROR_WAR" ? "mirror" : app.session.mode === "MONSTER_CHASER" ? "monster" : app.session.mode === "GOLDEN_COLOSSEUM" ? "golden" : "normal");

  onMount(() => {
    void app.initialize();
    return () => app.dispose();
  });
</script>

<svelte:head><title>{t("app.title")}</title></svelte:head>

<main
  bind:this={shell}
  class={`simulator-shell ${modeClass}`}
  class:executing={app.playback.executing}
  id="game-shell"
  data-testid="simulator-shell"
  data-mode={app.session.mode}
  data-active-element={activeElement}
  style:--speed-duration={`${Math.round(180 / app.playback.speed)}ms`}
  style:--playback-speed={app.playback.speed}
>
  <HeaderBar catalog={app.catalog} dialogs={app.dialogs} execution={app.execution} planning={app.planning} playback={app.playback} session={app.session} />
  <section class="battle-workspace">
    <aside class="reservation-workbench" aria-label={t(app.session.mode === "GOLDEN_COLOSSEUM" ? "golden.workbenchAria" : "reservation.workbenchAria")}>
      <ActionOrder catalog={app.catalog} planning={app.planning} playback={app.playback} session={app.session} />
      <CommandSelection catalog={app.catalog} feedback={app.feedback} planning={app.planning} session={app.session} />
    </aside>
    <section class="battle-center"><BattleBoard catalog={app.catalog} dialogs={app.dialogs} feedback={app.feedback} planning={app.planning} playback={app.playback} session={app.session} /></section>
    <EnemyInfo catalog={app.catalog} dialogs={app.dialogs} playback={app.playback} session={app.session} />
  </section>
  <FooterSp dialogs={app.dialogs} execution={app.execution} feedback={app.feedback} fullscreenTarget={shell} planning={app.planning} playback={app.playback} session={app.session} />
</main>

<PreparationDialog catalog={app.catalog} dialogs={app.dialogs} session={app.session} setup={app.setup} />
<CharacterProfilesDialog catalog={app.catalog} dialogs={app.dialogs} profiles={app.profiles} />
<CharacterPickerDialog catalog={app.catalog} dialogs={app.dialogs} feedback={app.feedback} setup={app.setup} />
<PauseDialog dialogs={app.dialogs} playback={app.playback} session={app.session} />
<LogDialog dialogs={app.dialogs} session={app.session} />
<HelpDialog dialogs={app.dialogs} />
<InspectDialog catalog={app.catalog} dialogs={app.dialogs} playback={app.playback} />
<NotificationLayer feedback={app.feedback} />
