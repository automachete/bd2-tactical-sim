<script lang="ts">
  import { t } from "../../lib/i18n";
  import type { CharacterDefinition, SetupUnit } from "../../lib/types";

  let {
    character,
    unit,
    fixedReadOnly = false,
    golden = false,
    bannedCostumeIds = new Set<string>(),
    onchange,
  }: {
    character: CharacterDefinition;
    unit: SetupUnit;
    fixedReadOnly?: boolean;
    golden?: boolean;
    bannedCostumeIds?: Set<string>;
    onchange: (unit: SetupUnit) => void;
  } = $props();

  const update = (mutate: (next: SetupUnit) => void): void => {
    const next = structuredClone($state.snapshot(unit));
    mutate(next);
    onchange(next);
  };
  const enabledCount = (): number => unit.costumes.filter((item) => item.enabled !== false).length;
</script>

<div class="advanced-costumes">
  <div class="costume-line costume-line-heading">
    <span>{t("loadout.equipped")}</span><span>{t("loadout.costume")}</span><span>{t("loadout.enhancement")}</span><span>{t("loadout.burst")}</span><span>{t("loadout.goddessTears")}</span>
  </div>
  {#each unit.costumes as loadout, loadoutIndex (loadout.costume_id)}
    {@const definition = character.costumes.find((item) => item.id === loadout.costume_id)}
    {#if definition}
      {@const banned = golden && bannedCostumeIds.has(definition.id)}
      {@const enabled = loadout.enabled !== false}
      <div class="costume-line">
        <input
          type="checkbox"
          title={t("loadout.equipped")}
          checked={enabled}
          disabled={banned || enabled && enabledCount() <= 1}
          onchange={(event) => update((next) => {
            const item = next.costumes[loadoutIndex];
            if (!item) return;
            item.enabled = event.currentTarget.checked;
            if (!item.enabled && next.costume_link_target === item.costume_id) next.costume_link_target = null;
          })}
        />
        <span><b>{definition.name}</b>{#if banned}<small>{t("golden.bannedCostume")}</small>{/if}</span>
        <select data-testid={`costume-enhancement-${definition.id}`} aria-label={`${definition.name} ${t("loadout.enhancement")}`} value={loadout.enhancement} disabled={fixedReadOnly || banned} onchange={(event) => update((next) => { const item = next.costumes[loadoutIndex]; if (item) item.enhancement = Number(event.currentTarget.value); })}>
          {#each Array.from({ length: definition.max_enhancement + 1 }, (_, index) => index) as value (value)}<option {value}>{value}</option>{/each}
        </select>
        <select data-testid={`costume-burst-${definition.id}`} aria-label={`${definition.name} ${t("loadout.burst")}`} value={loadout.burst_level} disabled={fixedReadOnly || banned} onchange={(event) => update((next) => { const item = next.costumes[loadoutIndex]; if (item) item.burst_level = Number(event.currentTarget.value); })}>
          {#each Array.from({ length: definition.max_burst_level + 1 }, (_, index) => index) as value (value)}<option {value}>{value}</option>{/each}
        </select>
        <span class="goddess-tear-toggles" role="group" aria-label={t("loadout.goddessTearsFor", { name: definition.name })}>
          {#each definition.goddess_tear_nodes as node (node.index)}
            <label>
              <input
                type="checkbox"
                checked={Boolean(loadout.potential_mask & node.bit)}
                disabled={fixedReadOnly || banned || !node.available}
                data-testid={`goddess-tear-${definition.id}-${node.index}`}
                aria-label={t("loadout.goddessTearNode", { number: node.index })}
                onchange={(event) => update((next) => {
                  const item = next.costumes[loadoutIndex];
                  if (!item) return;
                  item.potential_mask = event.currentTarget.checked ? item.potential_mask | node.bit : item.potential_mask & ~node.bit;
                })}
              />
              <span>{node.index}</span>
            </label>
          {/each}
        </span>
      </div>
    {/if}
  {/each}
  {#if !golden}
    <label class="inline-setting">
      {t("loadout.costumeLink")}
      <select value={unit.costume_link_target ?? ""} onchange={(event) => update((next) => { next.costume_link_target = event.currentTarget.value || null; })}>
        <option value="">{t("loadout.linkNone")}</option>
        {#each character.costumes as costume (costume.id)}
          {@const loadout = unit.costumes.find((item) => item.costume_id === costume.id)}
          <option value={costume.id} disabled={loadout?.enabled === false}>{costume.name}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>
