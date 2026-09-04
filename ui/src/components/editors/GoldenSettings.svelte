<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import type { GoldenBlessingLoadout, GoldenSideBlessings } from "../../lib/types";

  let { model }: { model: BattleState } = $props();
  const configurations: Array<[number, keyof GoldenSideBlessings, string, string]> = [
    [0, "going_first", "player-first", "golden.playerFirst"],
    [0, "going_second", "player-second", "golden.playerSecond"],
    [1, "going_first", "enemy-first", "golden.enemyFirst"],
    [1, "going_second", "enemy-second", "golden.enemySecond"],
  ];
  let config = $derived(model.draft?.golden_colosseum);
  let definitions = $derived((model.catalog?.blessings ?? []).filter((item) => !new Set(config?.banned_blessing_ids ?? []).has(item.id)));

  const change = (sideIndex: number, initiative: keyof GoldenSideBlessings, mutate: (loadout: GoldenBlessingLoadout) => void): void => {
    const loadout = model.draft?.golden_colosseum?.side_blessings[sideIndex]?.[initiative];
    if (loadout) mutate(loadout);
  };
  const spent = (loadout: GoldenBlessingLoadout): number => loadout.selected.reduce((sum, selected) => {
    const definition = model.catalog?.blessings.find((item) => item.id === selected.blessing_id);
    return sum + (definition?.levels.find((level) => level.level === selected.level)?.point_cost ?? 0);
  }, 0);
</script>

{#if config && model.draft}
  <section class="golden-settings" id="golden-settings" data-testid="golden-settings">
    <header>
      <div><small>{t("golden.caption")}</small><b id="golden-season">{config.season_label}</b></div>
      <span id="golden-rule-summary">{t("golden.summary", { rows: model.draft.grid.rows, depths: model.draft.grid.depths, members: model.draft.grid.deployment_limit, blocked: config.undeployable_grid_count, attempts: config.weekly_attempts, refills: config.refill_limit, rating: config.starting_rating, death: config.death_time_all_turn })}</span>
    </header>
    <div class="golden-loadouts" id="golden-loadouts">
      {#each configurations as [sideIndex, initiative, testId, labelKey] (testId)}
        {@const loadout = config.side_blessings[sideIndex]?.[initiative]}
        {#if loadout}
          {@const used = new Set(loadout.selected.map((item) => item.blessing_id))}
          {@const available = definitions.find((item) => !used.has(item.id))}
          {@const usedPoints = spent(loadout)}
          <section class="golden-loadout" data-testid={`golden-${testId}`}>
            <header><b>{t(labelKey)}</b><input type="number" min="3" max="15" value={loadout.point_limit} aria-label={`${t(labelKey)} ${t("golden.pointLimit")}`} onchange={(event) => change(sideIndex, initiative, (value) => { value.point_limit = Number(event.currentTarget.value); })} /></header>
            {#each loadout.selected as selection, selectionIndex (`${selection.blessing_id}:${selectionIndex}`)}
              {@const definition = definitions.find((item) => item.id === selection.blessing_id)}
              {#if definition}
                <div class="golden-blessing-row">
                  <select value={selection.blessing_id} title={definition.description_ja} onchange={(event) => change(sideIndex, initiative, (value) => { const selected = value.selected[selectionIndex]; const next = definitions.find((item) => item.id === event.currentTarget.value); if (selected && next?.levels[0]) { selected.blessing_id = next.id; selected.level = next.levels[0].level; } })}>
                    {#each definitions as option (option.id)}<option value={option.id} disabled={used.has(option.id) && option.id !== selection.blessing_id}>{option.name}</option>{/each}
                  </select>
                  <select value={selection.level} onchange={(event) => change(sideIndex, initiative, (value) => { const selected = value.selected[selectionIndex]; if (selected) selected.level = Number(event.currentTarget.value); })}>
                    {#each definition.levels as level (level.level)}<option value={level.level}>Lv.{level.level} · {level.point_cost}pt</option>{/each}
                  </select>
                  <button type="button" aria-label={t("golden.removeBlessing")} onclick={() => change(sideIndex, initiative, (value) => { value.selected.splice(selectionIndex, 1); })}>×</button>
                </div>
              {/if}
            {/each}
            <footer><strong class:over-budget={usedPoints > loadout.point_limit}>{t("golden.points", { spent: usedPoints, limit: loadout.point_limit })}</strong><button type="button" class="secondary-button" disabled={!available} onclick={() => change(sideIndex, initiative, (value) => { if (available?.levels[0]) value.selected.push({ blessing_id: available.id, level: available.levels[0].level }); })}>{t("golden.addBlessing")}</button></footer>
          </section>
        {/if}
      {/each}
    </div>
  </section>
{/if}
