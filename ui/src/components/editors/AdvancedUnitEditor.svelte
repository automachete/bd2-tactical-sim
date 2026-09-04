<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import type { BuildSettings, Equipment, SetupUnit } from "../../lib/types";
  import BuildSettingsEditor from "./BuildSettingsEditor.svelte";
  import CostumeEditor from "./CostumeEditor.svelte";
  import EquipmentEditor from "./EquipmentEditor.svelte";

  let { model }: { model: BattleState } = $props();

  let editor = $derived(model.advancedEditor);
  let unit = $derived(editor ? model.draft?.[editor.sideKey][editor.index] : undefined);
  let character = $derived(unit ? model.character(unit.character_id) : undefined);
  let golden = $derived(model.draft?.mode === "GOLDEN_COLOSSEUM");
  let player = $derived(editor?.sideKey === "player_units");
  let used = $derived(editor ? model.usedCostumeIds(editor.sideKey, editor.index) : new Set<string>());
  let banned = $derived(new Set(model.draft?.golden_colosseum?.banned_costume_ids ?? []));

  const duplicate = (characterId: string): boolean => {
    if (!editor || !unit || !model.draft) return true;
    const candidate = model.character(characterId);
    if (!candidate) return true;
    if (golden) return candidate.costumes.every((costume) => used.has(costume.id) || banned.has(costume.id));
    return model.draft[editor.sideKey].some((other, index) => index !== editor.index && other.party_no === unit.party_no && other.character_id === characterId);
  };
  const updateUnit = (next: SetupUnit): void => { if (editor) model.replaceDraftUnit(editor.sideKey, editor.index, next); };
  const updateBuild = (settings: BuildSettings): void => {
    if (!unit) return;
    updateUnit({ ...structuredClone($state.snapshot(unit)), build_settings: settings });
  };
  const updateEquipment = (equipment: Equipment): void => {
    if (!unit) return;
    updateUnit({ ...structuredClone($state.snapshot(unit)), equipment });
  };
</script>

{#if editor && unit && character && model.catalog}
  <section class="advanced-popover" aria-label={t("loadout.title")}>
    <div class="advanced-top">
      <select value={unit.character_id} aria-label={t("loadout.title")} onchange={(event) => model.replaceDraftCharacter(editor.sideKey, editor.index, event.currentTarget.value)}>
        {#each model.catalog.characters as option (option.id)}
          <option value={option.id} disabled={duplicate(option.id)}>{option.name} · {t(`element.${option.element}`)} / {t(`attack.${option.attack_type}`)}</option>
        {/each}
      </select>
      <button class="secondary-button" type="button" onclick={() => { model.advancedEditor = null; }}>{t("loadout.done")}</button>
    </div>
    <CostumeEditor {character} {unit} fixedReadOnly={player} {golden} bannedCostumeIds={banned} onchange={updateUnit} />
    {#if player}
      <section class="profile-owned-notice">
        <p>{t("profiles.formationOwned")}</p>
        <button type="button" class="secondary-button" data-testid="open-profile-from-formation" onclick={() => { model.selectedProfileId = unit.character_id; model.advancedEditor = null; model.open("profiles"); }}>{t("profiles.openFromFormation")}</button>
      </section>
      <BuildSettingsEditor settings={unit.build_settings} fixedAwakening={true} onchange={updateBuild} />
    {:else if !golden}
      <BuildSettingsEditor settings={unit.build_settings} onchange={updateBuild} />
      <EquipmentEditor catalog={model.catalog} characterId={unit.character_id} equipment={unit.equipment} onchange={updateEquipment} />
    {/if}
  </section>
{/if}
