<script lang="ts">
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import { elementClass } from "../../lib/presentation";
  import type { CatalogState } from "../../lib/state/catalog-state.svelte";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";
  import type { ProfileState } from "../../lib/state/profile-state.svelte";
  import type { CharacterProfile, Equipment } from "../../lib/types";
  import Avatar from "../Avatar.svelte";
  import EquipmentEditor from "../editors/EquipmentEditor.svelte";

  let { catalog, dialogs, profiles }: {
    catalog: CatalogState;
    dialogs: DialogState;
    profiles: ProfileState;
  } = $props();

  const elements = ["ALL", "FIRE", "WATER", "WIND", "LIGHT", "DARK"] as const;
  let query = $derived(profiles.profileSearch.trim().toLocaleLowerCase("ja-JP"));
  let characters = $derived((catalog.catalog?.characters ?? []).filter((character) => (
    (profiles.profileElementFilter === "ALL" || profiles.profileElementFilter === character.element)
    && `${character.name} ${character.id}`.toLocaleLowerCase("ja-JP").includes(query)
  )));
  let character = $derived(profiles.selectedProfileId ? catalog.character(profiles.selectedProfileId) : undefined);
  let profile = $derived.by<CharacterProfile | null>(() => {
    if (!profiles.selectedProfileId) return null;
    return profiles.profileDrafts.get(profiles.selectedProfileId) ?? profiles.profileFor(profiles.selectedProfileId);
  });

  const change = (mutate: (profile: CharacterProfile) => void): void => {
    if (profiles.selectedProfileId) profiles.mutateProfile(profiles.selectedProfileId, mutate);
  };
  const changeEquipment = (equipment: Equipment): void => change((value) => { value.equipment = equipment; });
</script>

{#if dialogs.dialog === "profiles"}
  <dialog use:modal class="sim-dialog profile-dialog" id="character-profile-dialog" data-testid="character-profile-dialog" onclose={() => dialogs.close("profiles")}>
    <section class="dialog-frame profile-frame">
      <header class="dialog-title profile-title"><div><small>{t("profiles.caption")}</small><h1>{t("profiles.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("profiles.closeAria")} onclick={() => dialogs.close("profiles")}>×</button></header>
      <div class="profile-layout">
        <section class="profile-library" aria-labelledby="profile-library-heading">
          <header><div><h2 id="profile-library-heading">{t("profiles.libraryTitle")}</h2><p>{t("profiles.libraryHelp")}</p></div><strong id="profile-count">{characters.length} / {catalog.catalog?.characters.length ?? 0}</strong></header>
          <div class="profile-filters">
            <label class="profile-search"><span>{t("profiles.search")}</span><input id="profile-search" bind:value={profiles.profileSearch} type="search" autocomplete="off" placeholder={t("profiles.searchPlaceholder")} /></label>
            <div class="profile-element-filters" id="profile-element-filters" role="group" aria-label={t("profiles.elementFilterAria")}>
              {#each elements as element (element)}
                <button type="button" data-element={element} class:active={profiles.profileElementFilter === element} onclick={() => profiles.setElementFilter(element)}>{t(element === "ALL" ? "profiles.allElements" : `element.${element}`)}</button>
              {/each}
            </div>
          </div>
          <div class="profile-character-grid" id="profile-character-grid" role="list" aria-label={t("profiles.gridAria")}>
            {#if characters.length === 0}
              <p class="profile-empty">{t("profiles.noResult")}</p>
            {:else}
              {#each characters as option (option.id)}
                {@const stored = profiles.profileFor(option.id)}
                <div role="listitem" style:display="contents">
                <button
                  type="button"
                  class={`profile-character-card ${elementClass(option.element)}`}
                  class:selected={profiles.selectedProfileId === option.id}
                  data-character-id={option.id}
                  data-testid={`profile-card-${option.id}`}
                  aria-label={t("profiles.cardAria", { name: option.name })}
                  onclick={() => profiles.selectProfile(option.id)}
                >
                  <Avatar character={option} className="profile-avatar" />
                  <span class="profile-card-copy"><b>{option.name}</b><small>{t(`element.${option.element}`)} · {t(`attack.${option.attack_type}`)}</small></span>
                  <em class="profile-card-status">{profiles.profileDirty(option.id) ? t("profiles.unsaved") : stored.is_default ? t("profiles.defaultBadge") : t("profiles.customBadge")}</em>
                </button>
                </div>
              {/each}
            {/if}
          </div>
        </section>
        <aside class="profile-detail" id="profile-detail" aria-live="polite">
          {#if character && profile && catalog.catalog}
            <header class={`profile-detail-header ${elementClass(character.element)}`}>
              <Avatar {character} className="profile-detail-avatar" />
              <div><small>{t("profiles.savedScope")}</small><h2>{character.name}</h2><span>{t(`element.${character.element}`)} · {t(`attack.${character.attack_type}`)} · {t("unit.levelRarity")}</span></div>
              <em id="profile-dirty" class:hidden={!profiles.profileDirty(character.id)}>{t("profiles.unsaved")}</em>
            </header>
            <section class="profile-section profile-progression">
              <header><div><h3>{t("profiles.progression")}</h3><p>{t("profiles.awakeningHelp")}</p></div></header>
              <label class="profile-switch"><input type="checkbox" checked={profile.awakening_enabled} data-testid={`profile-awakening-${character.id}`} onchange={(event) => change((value) => { value.awakening_enabled = event.currentTarget.checked; })} /><span><b>{t("profiles.awakening")}</b><small>Lv.100</small></span></label>
            </section>
            <section class="profile-section profile-costumes">
              <header><div><h3>{t("profiles.costumes")}</h3><p>{t("profiles.costumeHelp")}</p></div></header>
              <div class="profile-costume-row profile-costume-headings">{#each ["loadout.costume", "loadout.enhancement", "loadout.burst", "loadout.goddessTears"] as key (key)}<span>{t(key)}</span>{/each}</div>
              {#each profile.costumes as loadout, loadoutIndex (loadout.costume_id)}
                {@const definition = character.costumes.find((costume) => costume.id === loadout.costume_id)}
                {#if definition}
                  <div class="profile-costume-row">
                    <span class="profile-costume-name"><b>{definition.name}</b><small>{definition.id}</small></span>
                    <select data-testid={`profile-enhancement-${definition.id}`} aria-label={`${definition.name} ${t("loadout.enhancement")}`} value={loadout.enhancement} onchange={(event) => change((value) => { const item = value.costumes[loadoutIndex]; if (item) item.enhancement = Number(event.currentTarget.value); })}>{#each Array.from({ length: definition.max_enhancement + 1 }, (_, index) => index) as value (value)}<option {value}>{value}</option>{/each}</select>
                    <select data-testid={`profile-burst-${definition.id}`} aria-label={`${definition.name} ${t("loadout.burst")}`} value={loadout.burst_level} onchange={(event) => change((value) => { const item = value.costumes[loadoutIndex]; if (item) item.burst_level = Number(event.currentTarget.value); })}>{#each Array.from({ length: definition.max_burst_level + 1 }, (_, index) => index) as value (value)}<option {value}>{value}</option>{/each}</select>
                    <span class="profile-tears goddess-tear-toggles" role="group" aria-label={t("loadout.goddessTearsFor", { name: definition.name })}>
                      {#each definition.goddess_tear_nodes as node (node.index)}
                        <label><input type="checkbox" checked={Boolean(loadout.potential_mask & node.bit)} disabled={!node.available} data-testid={`profile-tear-${definition.id}-${node.index}`} aria-label={t("loadout.goddessTearNode", { number: node.index })} onchange={(event) => change((value) => { const item = value.costumes[loadoutIndex]; if (item) item.potential_mask = event.currentTarget.checked ? item.potential_mask | node.bit : item.potential_mask & ~node.bit; })} /><span>{node.index}</span></label>
                      {/each}
                    </span>
                  </div>
                {/if}
              {/each}
            </section>
            <EquipmentEditor catalog={catalog.catalog} characterId={character.id} equipment={profile.equipment} onchange={changeEquipment} />
            <footer class="profile-actions">
              <button type="button" class="secondary-button" data-testid="reset-character-profile" onclick={() => profiles.resetProfile(character.id)}>{t("profiles.reset")}</button>
              <button type="button" class="start-button profile-save" data-testid="save-character-profile" onclick={() => profiles.saveProfile(character.id)}>{t("profiles.save")}</button>
            </footer>
          {/if}
        </aside>
      </div>
    </section>
  </dialog>
{/if}
