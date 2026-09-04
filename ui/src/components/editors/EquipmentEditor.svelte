<script lang="ts">
  import { t } from "../../lib/i18n";
  import type { Catalog, Equipment, EquipmentDefinition, EquipmentLoadout, EquipmentSlot, StatModifiers } from "../../lib/types";

  let { catalog, characterId, equipment, onchange }: {
    catalog: Catalog;
    characterId: string;
    equipment: Equipment;
    onchange: (equipment: Equipment) => void;
  } = $props();

  const slots: EquipmentSlot[] = ["WEAPON", "ARMOR", "HELMET", "JEWELRY", "GLOVES"];
  const definitionFor = (loadout: EquipmentLoadout | undefined): EquipmentDefinition | undefined => catalog.equipment.find((item) => item.id === loadout?.equipment_id);
  const update = (mutate: (value: Equipment) => void): void => {
    const next = structuredClone($state.snapshot(equipment));
    mutate(next);
    onchange(next);
  };
  const selectItem = (slot: EquipmentSlot, id: string): void => update((next) => {
    if (!id) {
      delete next[slot];
      return;
    }
    const definition = catalog.equipment.find((item) => item.id === id);
    const substat = definition?.allowed_substats[0]?.key;
    if (!definition || !substat) return;
    next[slot] = {
      equipment_id: definition.id,
      refinement_score: 18,
      primary_stat: definition.primary_stat_options[0]?.key ?? null,
      secondary_stat: definition.secondary_stat_options[0]?.key ?? null,
      substats: [substat, substat, substat],
    };
  });
  const addModifiers = (target: StatModifiers, modifiers: StatModifiers | undefined): void => {
    if (!modifiers) return;
    for (const [key, amount] of Object.entries(modifiers)) target[key] = (target[key] ?? 0) + amount;
  };
  const bonus = (loadout: EquipmentLoadout | undefined): StatModifiers => {
    const definition = definitionFor(loadout);
    if (!loadout || !definition) return {};
    const score = String(loadout.refinement_score);
    const total = { ...(definition.modifiers_by_refinement_score[score] ?? {}) };
    if (loadout.primary_stat) addModifiers(total, definition.primary_modifiers_by_refinement_score[score]?.[loadout.primary_stat]);
    if (loadout.secondary_stat) addModifiers(total, definition.secondary_modifiers_by_refinement_score[score]?.[loadout.secondary_stat]);
    for (const key of loadout.substats) addModifiers(total, definition.allowed_substats.find((item) => item.key === key)?.modifiers);
    return total;
  };
  const formatBonus = (modifiers: StatModifiers): string => Object.entries(modifiers)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${t(`equipment.modifier.${key.replace(/_(?:flat|bp)$/, "").replaceAll("_", "")}`)} +${key.endsWith("_bp") ? value / 100 : value}${key.endsWith("_bp") ? "%" : ""}`)
    .join(" · ") || t("equipment.noBonus");
  let total = $derived.by(() => {
    const result: StatModifiers = {};
    for (const loadout of Object.values(equipment)) addModifiers(result, bonus(loadout));
    return result;
  });
</script>

<section class="equipment-editor">
  <header><b>{t("equipment.title")}</b><small>{t("equipment.scope")}</small></header>
  <div class="equipment-column-headings">{#each ["equipment.slotHeading", "equipment.itemHeading", "equipment.refinementScore", "equipment.mainAbilities", "equipment.subAbilities"] as key (key)}<span>{t(key)}</span>{/each}</div>
  {#each slots as slot (slot)}
    {@const loadout = equipment[slot]}
    {@const definition = definitionFor(loadout)}
    <div class="equipment-slot-row" data-slot={slot} data-testid={`equipment-slot-${slot}`}>
      <b>{t(`equipment.slot.${slot}`)}</b>
      <select data-testid={`equipment-item-${slot}`} aria-label={`${t(`equipment.slot.${slot}`)} ${t("equipment.itemHeading")}`} value={definition?.id ?? ""} onchange={(event) => selectItem(slot, event.currentTarget.value)}>
        <option value="">{t("equipment.unequipped")}</option>
        {#each catalog.equipment.filter((item) => item.slot === slot && (item.kind !== "EXCLUSIVE" || item.owner_character_id === characterId)) as item (item.id)}
          <option value={item.id}>{item.name} · {t(item.kind === "EXCLUSIVE" ? "equipment.exclusive" : "equipment.craftedLegendary")}</option>
        {/each}
      </select>
      <select data-testid={`equipment-score-${slot}`} disabled={!definition} aria-label={`${t(`equipment.slot.${slot}`)} ${t("equipment.refinementScore")}`} value={loadout?.refinement_score ?? 18} onchange={(event) => update((next) => { const item = next[slot]; if (item) item.refinement_score = Number(event.currentTarget.value); })}>
        {#each [18, 19, 20, 21, 22, 23, 24] as score (score)}<option value={score}>{score}</option>{/each}
      </select>
      <div class="equipment-main-abilities">
        {#if definition?.primary_stat_options.length}
          <label>{t("equipment.primaryAbility")}<select data-testid={`equipment-primary-${slot}`} value={loadout?.primary_stat ?? ""} onchange={(event) => update((next) => { const item = next[slot]; if (item) item.primary_stat = event.currentTarget.value; })}>{#each definition.primary_stat_options as option (option.key)}<option value={option.key}>{option.label}</option>{/each}</select></label>
        {/if}
        {#if definition?.secondary_stat_options.length}
          <label>{t("equipment.secondaryAbility")}<select data-testid={`equipment-secondary-${slot}`} value={loadout?.secondary_stat ?? ""} onchange={(event) => update((next) => { const item = next[slot]; if (item) item.secondary_stat = event.currentTarget.value; })}>{#each definition.secondary_stat_options as option (option.key)}<option value={option.key}>{option.label}</option>{/each}</select></label>
        {/if}
      </div>
      <div class="equipment-substats">
        {#each [0, 1, 2] as index (index)}
          <select data-testid={`equipment-substat-${slot}-${index}`} disabled={!definition} aria-label={`${t(`equipment.slot.${slot}`)} ${t("equipment.substat", { number: index + 1 })}`} value={loadout?.substats[index] ?? ""} onchange={(event) => update((next) => { const item = next[slot]; if (item) item.substats[index] = event.currentTarget.value; })}>
            {#each definition?.allowed_substats ?? [] as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
          </select>
        {/each}
      </div>
      <small class="equipment-bonus">{definition ? formatBonus(bonus(loadout)) : t("equipment.emptySlot")}</small>
    </div>
  {/each}
  <p class="equipment-total"><b>{t("equipment.total")}</b><span>{formatBonus(total)}</span></p>
</section>
