<script lang="ts">
  import type { BattleState } from "../lib/battle-state.svelte";
  import { t } from "../lib/i18n";
  import { elementClass, formatNumber } from "../lib/presentation";
  import Avatar from "./Avatar.svelte";

  let { model }: { model: BattleState } = $props();

  let monster = $derived(model.monsterState);
  let monsterTotal = $derived(monster?.level_hp_segments.reduce((sum, value) => sum + value, 0) ?? 0);
  let monsterPercent = $derived(monster ? Math.max(0, 100 * monster.battle_hp_remaining / Math.max(1, monsterTotal)) : 0);
  let controller = $derived(model.snapshot?.enemy_controller === "RULE_BASED"
    ? t("controller.rule")
    : model.snapshot?.enemy_controller === "COLOSSEUM_AUTO" ? t("controller.golden") : t("controller.mcts"));
  let aiReport = $derived.by(() => {
    const report = model.snapshot?.last_ai;
    if (!report) return t("ai.idle");
    if (report.controller === "MCTS") return t("ai.mctsReport", {
      simulations: report.simulations ?? 0,
      candidates: report.candidates ?? 0,
      value: Number(report.root_value ?? 0).toFixed(3),
    });
    return report.controller === "COLOSSEUM_AUTO" ? t("ai.goldenReport") : t("ai.ruleReport");
  });
</script>

<aside class="opponent-panel" aria-labelledby="opponent-heading">
  <div class="panel-heading">
    <span><small>{t("opponent.caption")}</small><b id="opponent-heading">{t("opponent.title")}</b></span>
    <span id="controller-label">{controller}</span>
  </div>
  <div class="enemy-list" id="enemy-rail" class:hidden={Boolean(monster)}>
    {#each model.enemyUnits.filter((unit) => !monster || unit.can_act) as unit (unit.id)}
      {@const character = model.entity(unit.character_id)}
      {@const hp = Math.max(0, 100 * unit.hp / Math.max(1, unit.base_stats.max_hp))}
      <button
        type="button"
        class={`enemy-card ${elementClass(character?.element)}`}
        data-unit-id={unit.id}
        data-testid={`enemy-unit-${unit.id}`}
        onclick={() => { model.inspectedUnitId = unit.id; model.open("inspect"); }}
      >
        <Avatar {character} />
        <span>
          <b>{character?.name ?? unit.character_id}</b>
          <small>HP {formatNumber(unit.hp)} · {unit.position.row + 1}-{unit.position.depth + 1}</small>
          <span class="hp-track"><i style:width={`${hp}%`}></i></span>
        </span>
      </button>
    {/each}
  </div>
  <section class="fiend-panel" class:hidden={!monster} id="fiend-zone">
    {#if monster}
      <div class="boss-summary"><span class="boss-emblem" aria-hidden="true">{t("fiend.emblem")}</span><div><small id="fiend-level">{t("fiend.level", { current: monster.current_level, selected: monster.selected_level })}</small><b>{t("fiend.title")}</b></div><strong id="fiend-percent">{monsterPercent.toFixed(1)}%</strong></div>
      <div class="hp-track boss-hp"><i id="fiend-hp-bar" style:width={`${monsterPercent}%`}></i></div>
      <span class="fiend-hp-text" id="fiend-hp-text">{formatNumber(monster.battle_hp_remaining)} / {formatNumber(monsterTotal)}</span>
      <div class="forecast-title"><b>{t("fiend.forecast")}</b><span>{t("fiend.ruleBased")}</span></div>
      <ol class="forecast-list" id="forecast-list">
        {#each model.catalog?.monster_skills ?? [] as skill, index (`${skill.name}:${index}`)}
          <li><span>{index + 1}</span><div><b>{skill.name}</b><small>{skill.condition || t("fiend.sequence")} · {skill.operation_summary}</small></div></li>
        {/each}
      </ol>
    {/if}
  </section>
  <p class="ai-report" id="ai-report">{aiReport}</p>
</aside>
