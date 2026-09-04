<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import { elementClass } from "../../lib/presentation";
  import type { SetupSide } from "../../lib/types";
  import Avatar from "../Avatar.svelte";

  let { model }: { model: BattleState } = $props();
  let search = $state("");
  let input = $state<HTMLInputElement>();

  let target = $derived(model.pickerTarget);
  let sideKey = $derived<SetupSide>(target?.side === "ENEMY" ? "enemy_units" : "player_units");
  let usedCharacters = $derived(new Set((model.draft?.[sideKey] ?? []).filter((unit) => unit.party_no === target?.party).map((unit) => unit.character_id)));
  let query = $derived(search.trim().toLocaleLowerCase("ja-JP"));
  let characters = $derived((model.catalog?.characters ?? []).filter((character) => `${character.name} ${character.id}`.toLocaleLowerCase("ja-JP").includes(query)));
  let usedCostumes = $derived(model.usedCostumeIds(sideKey));
  let banned = $derived(new Set(model.draft?.golden_colosseum?.banned_costume_ids ?? []));

  const disabled = (characterId: string): boolean => {
    const character = model.character(characterId);
    if (!character) return true;
    return model.draft?.mode === "GOLDEN_COLOSSEUM"
      ? character.costumes.every((costume) => usedCostumes.has(costume.id) || banned.has(costume.id))
      : usedCharacters.has(characterId);
  };
  const choose = (characterId: string): void => {
    if (!target) return;
    try {
      model.addCharacter(target.side, target.party, characterId);
      model.close("picker");
    } catch (error) {
      model.showError(error);
    }
  };
  $effect(() => {
    if (model.dialog === "picker") window.setTimeout(() => input?.focus(), 0);
  });
</script>

{#if model.dialog === "picker" && target}
  <dialog use:modal class="sim-dialog character-picker" id="character-picker" data-testid="character-picker" onclose={() => model.close("picker")}>
    <section class="dialog-frame picker-frame">
      <header class="dialog-title"><div><small id="character-picker-side">{target.side === "PLAYER" ? t("party.ally") : t("party.enemy")} · {t("party.team", { number: target.party })}</small><h1>{t("picker.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("picker.closeAria")} onclick={() => model.close("picker")}>×</button></header>
      <label class="character-search"><span>{t("picker.search")}</span><input bind:this={input} bind:value={search} id="character-search" type="search" autocomplete="off" /></label>
      <div class="character-options" id="character-options" role="list">
        {#each characters as character (character.id)}
          {@const unavailable = disabled(character.id)}
          <button
            type="button"
            class={`character-option ${elementClass(character.element)}`}
            disabled={unavailable}
            data-character-id={character.id}
            data-testid={`character-option-${character.id}`}
            onclick={() => choose(character.id)}
          >
            <Avatar {character} />
            <span><b>{character.name}</b><small>{t(`element.${character.element}`)} · {t(`attack.${character.attack_type}`)} · {t("unit.levelRarity")}</small></span>
            <em>{t(unavailable ? "party.alreadyAdded" : "party.add")}</em>
          </button>
        {/each}
      </div>
    </section>
  </dialog>
{/if}
