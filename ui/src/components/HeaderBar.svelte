<script lang="ts">
  import { cellKey, rangePreviewCells } from "../lib/battle-ui-model";
  import type { BattleState } from "../lib/battle-state.svelte";
  import { t } from "../lib/i18n";
  import { commandPresentation, elementClass } from "../lib/presentation";
  import Avatar from "./Avatar.svelte";

  let { model }: { model: BattleState } = $props();

  let unit = $derived(model.selectedUnit);
  let character = $derived(unit ? model.entity(unit.character_id) : undefined);
  let command = $derived(model.selectedCommand);
  let meta = $derived(unit && model.catalog ? commandPresentation(model.catalog, unit, command) : null);
  let loadout = $derived(command?.costume_id ? unit?.costume_loadout.find((item) => item.costume_id === command?.costume_id) : undefined);
  let grid = $derived(model.snapshot?.state.rules.grid ?? { rows: 3, depths: 4 });
  let range = $derived(rangePreviewCells(meta?.range ?? [], grid.rows, grid.depths));

</script>

<header class="battle-header">
  <section class="selected-summary" id="selected-summary" aria-live="polite">
    {#if character}
      <Avatar id="selected-emblem" {character} className={`unit-emblem ${elementClass(character.element)}`} />
    {:else}
      <span class="unit-emblem neutral" id="selected-emblem" aria-hidden="true">—</span>
    {/if}
    <div class="selected-copy">
      <div class="eyebrow">
        <span id="selected-element">{character ? t(`element.${character.element ?? "NONE"}`) : "—"}</span>
        <span id="selected-upgrade">{loadout ? `+${loadout.enhancement}${Number(command?.burst_level ?? 0) ? ` · B${Number(command?.burst_level)}` : ""}` : ""}</span>
      </div>
      <strong id="selected-name">{character?.name ?? t("selection.none")}</strong>
    </div>
    <div class="selected-skill-detail">
      <strong id="selected-skill-name">{meta?.name ?? t("selection.hint")}</strong>
      <p id="selected-skill-summary" lang="ja">{meta?.description_ja || meta?.operation_summary || ""}</p>
    </div>
    <div class="selected-numbers">
      <span>SP <b id="selected-sp">{model.mode === "GOLDEN_COLOSSEUM" ? "∞" : meta?.sp_cost ?? 0}</b></span>
      <span>CT <b id="selected-cooldown">{command?.costume_id ? unit?.cooldowns[command.costume_id] ?? 0 : 0}</b></span>
      <span class="selected-damage" title={model.preview ? t("selection.predictedDamageTitle", { damage: model.selectedDamage, absorbed: model.preview.damage_by_target.reduce((sum, item) => sum + item.absorbed, 0) }) : undefined}>
        <small>{t("selection.predictedDamage")}</small><b id="selected-damage">{model.preview ? model.selectedDamage.toLocaleString("ja-JP") : "—"}</b>
      </span>
      <em id="reserved-badge">{unit ? (model.mode === "GOLDEN_COLOSSEUM" ? t("golden.nextActionBadge", { order: model.plannedOrder.indexOf(unit.id) + 1 }) : t("order.badge", { order: model.plannedOrder.indexOf(unit.id) + 1 })) : t("selection.unreserved")}</em>
    </div>
    <div
      class="range-preview"
      id="range-preview"
      aria-label={t("selection.rangeDynamicAria", { rows: grid.rows, depths: grid.depths })}
      style:grid-template-columns={`repeat(${grid.depths}, 1fr)`}
      style:grid-template-rows={`repeat(${grid.rows}, 1fr)`}
    >
      {#each Array.from({ length: grid.rows * grid.depths }, (_, index) => index) as index (index)}
        {@const row = Math.floor(index / grid.depths)}
        {@const depth = index % grid.depths}
        <i class:hit={range.has(cellKey(row, depth))}></i>
      {/each}
    </div>
  </section>

  <nav class="system-controls" aria-label={t("controls.assistAria")}>
    <button id="auto-reserve" class="control-button" type="button" aria-pressed={model.autoReserveEnabled} data-testid="auto-reserve" class:hidden={model.mode === "GOLDEN_COLOSSEUM"} onclick={model.toggleAutoReserve}><span>✦</span><span>{t("controls.autoReserve")}</span></button>
    <button id="auto-turn" class="control-button" type="button" aria-pressed={model.autoTurnEnabled} data-testid="auto-turn" onclick={model.toggleAutoTurn}><span>▶</span><span>{t("controls.autoTurn")}</span></button>
    <button id="speed" class="square-control" type="button" aria-label={t("controls.speedAria", { speed: model.speed })} data-testid="speed" onclick={model.cycleSpeed}>×{model.speed}</button>
    <button id="open-log" class="square-control" type="button" aria-label={t("controls.logAria")} onclick={() => model.open("log")}>☷</button>
    <button id="open-help" class="square-control" type="button" aria-label={t("controls.helpAria")} onclick={() => model.open("help")}>?</button>
    <button id="open-pause" class="square-control" type="button" aria-label={t("controls.pauseAria")} data-testid="pause" onclick={() => model.open("pause")}>Ⅱ</button>
  </nav>
</header>
