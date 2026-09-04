<script lang="ts">
  import { cellKey } from "../../lib/battle-ui-model";
  import { t } from "../../lib/i18n";
  import { elementClass } from "../../lib/presentation";
  import type { CatalogState } from "../../lib/state/catalog-state.svelte";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";
  import type { SetupState } from "../../lib/state/setup-state.svelte";
  import type { Cell, SetupSide, Side } from "../../lib/types";
  import Avatar from "../Avatar.svelte";

  let { catalog, dialogs, setup, sideKey }: {
    catalog: CatalogState;
    dialogs: DialogState;
    setup: SetupState;
    sideKey: SetupSide;
  } = $props();

  let drag = $state<{ sideKey: SetupSide; index: number } | null>(null);
  let dropCell = $state<Cell | null>(null);
  let entries = $derived(setup.partyUnits(sideKey));
  let grid = $derived(setup.draft?.grid ?? { rows: 3, depths: 4, deployment_limit: 5, blocked: [] });
  let side = $derived<Side>(sideKey === "player_units" ? "PLAYER" : "ENEMY");

  const cells = (): Cell[] => Array.from({ length: grid.rows * grid.depths }, (_, index) => ({ row: Math.floor(index / grid.depths), depth: index % grid.depths }));
  const occupiedAt = (row: number, depth: number, ignored = -1) => entries.find(({ unit, index }) => index !== ignored && unit.row === row && unit.depth === depth);
  const blocked = (row: number, depth: number): boolean => grid.blocked.some(([blockedRow, blockedDepth]) => blockedRow === row && blockedDepth === depth);
  const move = (row: number, depth: number): void => {
    const active = drag ?? setup.editorFocus;
    if (active.sideKey === sideKey) setup.moveDraftUnit(sideKey, active.index, row, depth);
    drag = null;
    dropCell = null;
  };
</script>

<section class="formation-side" id={sideKey === "enemy_units" ? "enemy-editor" : undefined} aria-labelledby={`${side.toLowerCase()}-formation-heading`}>
  <div class="formation-heading">
    <b id={`${side.toLowerCase()}-formation-heading`}>{sideKey === "player_units" ? t("preparation.player") : setup.mode === "GOLDEN_COLOSSEUM" ? t("controller.golden") : t("preparation.enemyMcts")}</b>
    <button class="secondary-button" data-add-side={side} type="button" onclick={() => dialogs.openPicker(side, side === "PLAYER" && setup.draft?.mode === "MONSTER_CHASER" ? setup.editorParty : 1)}>{t("preparation.addUnit")}</button>
  </div>
  <div
    class={`formation-board ${sideKey === "player_units" ? "player-editor-board" : "enemy-editor-board"}`}
    id={sideKey === "player_units" ? "player-formation" : "enemy-formation"}
    role="grid"
    aria-label={t(sideKey === "player_units" ? "preparation.playerBoardDynamicAria" : "preparation.enemyBoardDynamicAria", { rows: grid.rows, depths: grid.depths })}
    style:grid-template-columns={`repeat(${grid.depths}, minmax(0, 1fr))`}
    style:grid-template-rows={`repeat(${grid.rows}, minmax(0, 1fr))`}
  >
    {#each cells() as cell (`${cell.row}-${cell.depth}`)}
      {@const entry = occupiedAt(cell.row, cell.depth)}
      {@const isBlocked = blocked(cell.row, cell.depth)}
      <div
        tabindex="0"
        class="formation-cell"
        class:blocked={isBlocked}
        class:drop-valid={dropCell?.row === cell.row && dropCell.depth === cell.depth && !occupiedAt(cell.row, cell.depth, drag?.index)}
        class:drop-swap={dropCell?.row === cell.row && dropCell.depth === cell.depth && Boolean(occupiedAt(cell.row, cell.depth, drag?.index))}
        data-row={cell.row}
        data-depth={cell.depth}
        data-coordinate={`${cell.row + 1}-${cell.depth + 1}`}
        data-testid={`${sideKey === "player_units" ? "player" : "enemy"}-formation-cell-${cell.row}-${cell.depth}`}
        role="gridcell"
        aria-disabled={isBlocked ? "true" : undefined}
        onclick={() => { if (!entry && !isBlocked) move(cell.row, cell.depth); }}
        onkeydown={(event) => { if (!entry && !isBlocked && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); move(cell.row, cell.depth); } }}
        ondragover={(event) => { if (drag?.sideKey === sideKey && !isBlocked) { event.preventDefault(); dropCell = cell; } }}
        ondragleave={() => { if (dropCell && cellKey(dropCell.row, dropCell.depth) === cellKey(cell.row, cell.depth)) dropCell = null; }}
        ondrop={(event) => { event.preventDefault(); if (!isBlocked) move(cell.row, cell.depth); }}
      >
        {#if entry}
          {@const character = catalog.character(entry.unit.character_id)}
          <span
            class={`formation-token ${elementClass(character?.element)}`}
            class:selected={setup.editorFocus.sideKey === sideKey && setup.editorFocus.index === entry.index}
            data-character-id={entry.unit.character_id}
            data-editor-side={sideKey}
            data-editor-index={entry.index}
            tabindex="0"
            role="button"
            draggable="true"
            aria-label={t("formation.moveAria", { name: character?.name ?? entry.unit.character_id })}
            aria-grabbed={drag?.sideKey === sideKey && drag.index === entry.index}
            onclick={(event) => { event.stopPropagation(); setup.focusUnit(sideKey, entry.index); }}
            onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setup.focusUnit(sideKey, entry.index); } }}
            ondragstart={(event) => { drag = { sideKey, index: entry.index }; setup.focusUnit(sideKey, entry.index); event.dataTransfer?.setData("text/plain", `${sideKey}:${entry.index}`); }}
            ondragend={() => { drag = null; dropCell = null; }}
          >
            <Avatar {character} />
            <span class="token-copy"><b>{character?.name ?? entry.unit.character_id}</b><small>{setup.mode === "GOLDEN_COLOSSEUM" ? catalog.costume(entry.unit.costumes.find((item) => item.enabled !== false)?.costume_id ?? "")?.name ?? "" : t(`element.${character?.element ?? "NONE"}`)}</small></span>
          </span>
        {/if}
      </div>
    {/each}
  </div>
  <div class="formation-roster" id={sideKey === "player_units" ? "player-roster" : "enemy-roster"} aria-label={t(sideKey === "player_units" ? "preparation.playerRosterAria" : "preparation.enemyRosterAria")}>
    {#each entries as entry (entry.index)}
      {@const character = catalog.character(entry.unit.character_id)}
      <article
        draggable="true"
        aria-grabbed={drag?.sideKey === sideKey && drag.index === entry.index}
        aria-label={t("formation.rosterAria", { name: character?.name ?? entry.unit.character_id })}
        class={`roster-chip ${elementClass(character?.element)}`}
        class:selected={setup.editorFocus.sideKey === sideKey && setup.editorFocus.index === entry.index}
        data-testid={`${sideKey}-roster-${entry.index}`}
        data-editor-side={sideKey}
        data-editor-index={entry.index}
        ondragstart={(event) => { drag = { sideKey, index: entry.index }; setup.focusUnit(sideKey, entry.index); event.dataTransfer?.setData("text/plain", `${sideKey}:${entry.index}`); }}
        ondragend={() => { drag = null; dropCell = null; }}
      >
        <Avatar {character} />
        <span><b>{character?.name ?? entry.unit.character_id}</b>{#if setup.mode === "GOLDEN_COLOSSEUM"}<small>{catalog.costume(entry.unit.costumes.find((item) => item.enabled !== false)?.costume_id ?? "")?.name ?? ""}</small>{/if}</span>
        <button type="button" class="roster-advanced" aria-label={t("formation.detailsAria", { name: character?.name ?? entry.unit.character_id })} onclick={(event) => { event.stopPropagation(); setup.openAdvancedEditor(sideKey, entry.index); }}>⚙</button>
        <button type="button" class="remove-unit" aria-label={t("formation.removeAria", { name: character?.name ?? entry.unit.character_id })} onclick={(event) => { event.stopPropagation(); setup.removeDraftUnit(sideKey, entry.index); }}>×</button>
      </article>
    {/each}
  </div>
</section>
