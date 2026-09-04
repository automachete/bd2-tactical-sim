<script lang="ts">
  import { t } from "../../lib/i18n";
  import type { BuildSettings } from "../../lib/types";

  let {
    settings,
    fixedAwakening = false,
    onchange,
  }: {
    settings: BuildSettings;
    fixedAwakening?: boolean;
    onchange: (settings: BuildSettings) => void;
  } = $props();

  type CollectionKey = keyof BuildSettings["collection"];
  type ExternalKey = keyof BuildSettings["external_buffs"];
  type FilterKey = keyof BuildSettings["calculator"]["gear_filters"];

  const update = (mutate: (value: BuildSettings) => void): void => {
    const next = structuredClone($state.snapshot(settings));
    mutate(next);
    onchange(next);
  };
  const integer = (event: Event, previous: number, minimum: number, maximum: number | null, apply: (value: number) => void): void => {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < minimum || maximum !== null && value > maximum) {
      input.value = String(previous);
      return;
    }
    apply(value);
  };
  const collectionFields: Array<[CollectionKey, number, string]> = [
    ["max_hp_bp", 8000, "build.collectionHp"],
    ["attack_bp", 8000, "build.collectionAttack"],
    ["magic_bp", 8000, "build.collectionMagic"],
    ["crit_rate_bp", 5000, "build.collectionCrit"],
  ];
  const externalFields: Array<[ExternalKey, number, string, boolean]> = [
    ["attack_bonus_bp", -999999, "build.externalAttack", true],
    ["crit_rate_bp", -999999, "build.externalCrit", true],
    ["crit_damage_bp", -999999, "build.externalCritDamage", true],
    ["property_damage_bp", -999999, "build.externalProperty", true],
    ["shield_percent_bp", 0, "build.externalShieldPercent", true],
    ["shield_flat", 0, "build.externalShieldFlat", false],
  ];
  const filterFields: Array<[FilterKey, string]> = [
    ["exclusive", "build.filterExclusive"], ["ur4", "build.filterUr4"],
    ["ur3", "build.filterUr3"], ["monster", "build.filterMonster"],
  ];
</script>

<details class="build-settings-editor">
  <summary><b>{t("build.title")}</b><small>{t("build.defaultHint")}</small></summary>
  <section class="build-settings-group">
    <h4>{t("build.progression")}</h4>
    <div class="build-settings-grid">
      <label class="build-setting-row"><span>{t("build.engraving")}</span><input type="checkbox" checked={settings.engraving_enabled} data-testid="build-engraving" onchange={(event) => update((value) => { value.engraving_enabled = event.currentTarget.checked; })} /></label>
      <label class="build-setting-row"><span>{t("build.awakening")}</span><input type="checkbox" checked={settings.awakening_enabled} disabled={fixedAwakening} data-testid="build-awakening" onchange={(event) => update((value) => { value.awakening_enabled = event.currentTarget.checked; })} /></label>
    </div>
  </section>
  <section class="build-settings-group">
    <h4>{t("build.collection")}</h4>
    <div class="build-settings-grid">
      {#each collectionFields as [key, maximum, label] (key)}
        <label class="build-setting-row"><span>{t(label)}</span><input type="number" step="1" min="0" max={maximum} value={settings.collection[key]} data-testid={`build-collection-${key}`} onchange={(event) => integer(event, settings.collection[key], 0, maximum, (result) => update((value) => { value.collection[key] = result; }))} /><small>{t("build.basisPointUnit")}</small></label>
      {/each}
    </div>
  </section>
  <section class="build-settings-group">
    <h4>{t("build.external")}</h4>
    <div class="build-settings-grid">
      {#each externalFields as [key, minimum, label, basisPoints] (key)}
        <label class="build-setting-row"><span>{t(label)}</span><input type="number" step="1" min={minimum} value={settings.external_buffs[key]} data-testid={`build-external-${key}`} onchange={(event) => integer(event, settings.external_buffs[key], minimum, null, (result) => update((value) => { value.external_buffs[key] = result; }))} />{#if basisPoints}<small>{t("build.basisPointUnit")}</small>{/if}</label>
      {/each}
    </div>
  </section>
  <section class="build-settings-group">
    <h4>{t("build.calculator")}</h4>
    <div class="build-settings-grid">
      <label class="build-setting-row"><span>{t("build.damageType")}</span><select value={settings.calculator.damage_type} data-testid="build-damage-type" onchange={(event) => update((value) => { value.calculator.damage_type = event.currentTarget.value; })}>{#each ["NORMAL", "FIXED", "HP_SHIELD", "HP"] as option (option)}<option value={option}>{t(`build.damageType.${option}`)}</option>{/each}</select></label>
      <label class="build-setting-row"><span>{t("build.elementalAdvantage")}</span><input type="checkbox" checked={settings.calculator.elemental_advantage} data-testid="build-elemental-advantage" onchange={(event) => update((value) => { value.calculator.elemental_advantage = event.currentTarget.checked; })} /></label>
      <label class="build-setting-row"><span>{t("build.defenseType")}</span><select value={settings.calculator.defense_type} data-testid="build-defense-type" onchange={(event) => update((value) => { value.calculator.defense_type = event.currentTarget.value; })}>{#each ["NONE", "DEFENSE", "MAGIC_RESIST"] as option (option)}<option value={option}>{t(`build.defenseType.${option}`)}</option>{/each}</select></label>
      <label class="build-setting-row"><span>{t("build.targetHp")}</span><input type="number" step="1" min="0" value={settings.calculator.target_condition.min_hp} data-testid="build-target-hp" onchange={(event) => integer(event, settings.calculator.target_condition.min_hp, 0, null, (result) => update((value) => { value.calculator.target_condition.min_hp = result; }))} /></label>
      <label class="build-setting-row"><span>{t("build.targetDefense")}</span><input type="number" step="1" min="0" max="9000" value={settings.calculator.target_condition.min_defense_bp} data-testid="build-target-defense" onchange={(event) => integer(event, settings.calculator.target_condition.min_defense_bp, 0, 9000, (result) => update((value) => { value.calculator.target_condition.min_defense_bp = result; }))} /><small>{t("build.basisPointUnit")}</small></label>
      <label class="build-setting-row"><span>{t("build.targetMagicResist")}</span><input type="number" step="1" min="0" max="9000" value={settings.calculator.target_condition.min_magic_resist_bp} data-testid="build-target-magic-resist" onchange={(event) => integer(event, settings.calculator.target_condition.min_magic_resist_bp, 0, 9000, (result) => update((value) => { value.calculator.target_condition.min_magic_resist_bp = result; }))} /><small>{t("build.basisPointUnit")}</small></label>
      <label class="build-setting-row"><span>{t("build.optionCount")}</span><input type="number" step="1" min="1" max="15" value={settings.calculator.option_count} data-testid="build-option-count" onchange={(event) => integer(event, settings.calculator.option_count, 1, 15, (result) => update((value) => { value.calculator.option_count = result; }))} /></label>
      <label class="build-setting-row"><span>{t("build.worldBuff")}</span><input type="checkbox" checked={settings.calculator.world_buff_enabled} data-testid="build-world-buff" onchange={(event) => update((value) => { value.calculator.world_buff_enabled = event.currentTarget.checked; })} /></label>
      {#each filterFields as [key, label] (key)}
        <label class="build-setting-row"><span>{t(label)}</span><input type="checkbox" checked={settings.calculator.gear_filters[key]} data-testid={`build-filter-${key}`} onchange={(event) => update((value) => { value.calculator.gear_filters[key] = event.currentTarget.checked; })} /></label>
      {/each}
    </div>
  </section>
</details>
