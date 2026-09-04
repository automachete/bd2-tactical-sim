<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import type { BattleMode } from "../../lib/types";
  import AdvancedUnitEditor from "../editors/AdvancedUnitEditor.svelte";
  import FormationEditor from "../editors/FormationEditor.svelte";
  import GoldenSettings from "../editors/GoldenSettings.svelte";

  let { model }: { model: BattleState } = $props();
  const modes: BattleMode[] = ["NORMAL", "MIRROR_WAR", "MONSTER_CHASER", "GOLDEN_COLOSSEUM"];
  let visible = $derived(model.dialog === "formation" || model.returnDialog === "formation");
  let monster = $derived(model.draft?.mode === "MONSTER_CHASER");
  let golden = $derived(model.draft?.mode === "GOLDEN_COLOSSEUM");

  const close = (): void => {
    model.advancedEditor = null;
    model.close("formation");
  };
</script>

{#if visible && model.draft}
  <dialog use:modal class="sim-dialog formation-dialog" id="formation-dialog" data-testid="formation-dialog" onclose={close}>
    <form class="dialog-frame" onsubmit={(event) => event.preventDefault()}>
      <header class="dialog-title"><div><small>{t("preparation.caption")}</small><h1>{t("preparation.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("preparation.closeAria")} onclick={close}>×</button></header>
      <nav class="content-tabs" id="content-tabs" aria-label={t("preparation.contentAria")}>
        {#each modes as mode (mode)}<button data-mode={mode} type="button" class:active={model.draft.mode === mode} onclick={() => model.loadPreset(mode)}>{t(`mode.${mode}`)}</button>{/each}
      </nav>
      <div class="formation-toolbar">
        <label><span>{t("preparation.seed")}</span><input id="setup-seed" bind:value={model.setupSeed} type="number" step="1" required /></label>
        <label class="mcts-option" class:hidden={monster || golden}><span>{t("preparation.mcts")}</span><input id="mcts-simulations" bind:value={model.mctsSimulations} type="number" min="1" max="2048" step="1" required /></label>
        <label class="monster-option" class:hidden={!monster}><span>{t("preparation.monsterLevel")}</span><input id="monster-level" bind:value={model.monsterLevel} type="number" min="1" max="25" step="1" required /></label>
        <span class="ruleset" id="ruleset">{model.catalog?.ruleset_id ?? "—"}</span>
        <button class="secondary-button" id="restore-preset" type="button" onclick={() => model.loadPreset(model.draft!.mode)}>{t("preparation.restore")}</button>
      </div>
      <div class="saved-setup-toolbar" aria-label={t("saved.aria")}>
        <label><span>{t("saved.name")}</span><input id="saved-setup-name" bind:value={model.savedSetupName} type="text" maxlength="80" autocomplete="off" /></label>
        <label><span>{t("saved.list")}</span><select id="saved-setup-list" bind:value={model.selectedSavedSetup} onchange={() => { if (model.selectedSavedSetup) model.savedSetupName = model.selectedSavedSetup; }}><option value="">{t("saved.none")}</option>{#each model.savedSetups as item (item.name)}<option value={item.name}>{item.name}</option>{/each}</select></label>
        <button class="secondary-button" id="save-setup" type="button" data-testid="save-setup" onclick={model.saveSetup}>{t("saved.save")}</button>
        <button class="secondary-button" id="load-setup" type="button" data-testid="load-setup" onclick={model.loadSetup}>{t("saved.load")}</button>
        <small id="saved-setup-path" aria-live="polite">{model.savedSetupStatus}</small>
      </div>
      <p class="mode-help" id="mode-help">{t(monster ? "modeHelp.monster" : golden ? "modeHelp.golden" : "modeHelp.standard")}</p>
      {#if golden}<GoldenSettings {model} />{/if}
      <div class="party-switch" class:hidden={!monster} id="party-switch">
        {#each [1, 2] as party (party)}<button data-party={party} type="button" class:active={model.editorParty === party} onclick={() => { model.editorParty = party; model.editorFocus = { sideKey: "player_units", index: model.partyUnits("player_units")[0]?.index ?? 0 }; }}>{t("party.team", { number: party })}</button>{/each}
      </div>
      <div class="formation-content">
        <FormationEditor {model} sideKey="player_units" />
        <div class="formation-vs" aria-hidden="true">{t("board.versus")}</div>
        {#if monster}
          <section class="monster-card" id="monster-info"><span class="boss-emblem large" aria-hidden="true">{t("fiend.emblem")}</span><small>{t("preparation.ruleBoss")}</small><h2>{t("preparation.monsterChaser")}</h2><p>{t("preparation.monsterHelp")}</p></section>
        {:else}
          <FormationEditor {model} sideKey="enemy_units" />
        {/if}
      </div>
      <footer class="dialog-actions"><button class="start-button" id="start-battle" type="button" data-testid="start-battle" onclick={model.startBattle}><span>{t("preparation.start")}</span> <span>›</span></button></footer>
    </form>
    <AdvancedUnitEditor {model} />
  </dialog>
{/if}
