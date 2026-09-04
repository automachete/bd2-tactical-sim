<script lang="ts">
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import { effectLabel, elementClass, formatNumber } from "../../lib/presentation";
  import type { CatalogState } from "../../lib/state/catalog-state.svelte";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";
  import type { PlaybackState } from "../../lib/state/playback-state.svelte";
  import Avatar from "../Avatar.svelte";

  let { catalog, dialogs, playback }: { catalog: CatalogState; dialogs: DialogState; playback: PlaybackState } = $props();
  let unit = $derived(dialogs.inspectedUnitId === null ? undefined : playback.units[String(dialogs.inspectedUnitId)]);
  let character = $derived(unit ? catalog.entity(unit.character_id) : undefined);
</script>

{#if dialogs.dialog === "inspect" && unit}
  <dialog use:modal class="sim-dialog inspect-dialog" id="inspect-dialog" onclose={() => dialogs.close("inspect")}>
    <section class="dialog-frame compact-dialog">
      <button class="dialog-close floating-close" type="button" aria-label={t("inspect.closeAria")} onclick={() => dialogs.close("inspect")}>×</button>
      <div id="inspect-content">
        <div class="inspect-head">
          <Avatar {character} className={`unit-emblem ${elementClass(character?.element)}`} />
          <div><small>{t(`battle.side.${unit.side}`)} · #{unit.id}</small><h2>{character?.name ?? unit.character_id}</h2><span>{t("inspect.position", { row: unit.position.row + 1, depth: unit.position.depth + 1 })}</span></div>
        </div>
        <div class="inspect-stats">
          <span>HP <b>{formatNumber(unit.hp)} / {formatNumber(unit.base_stats.max_hp)}</b></span>
          <span>{t(unit.base_stats.attack ? "inspect.attack" : "inspect.magic")} <b>{formatNumber(unit.base_stats.attack || unit.base_stats.magic)}</b></span>
          <span>{t("inspect.defense")} <b>{unit.base_stats.defense_bp / 100}%</b></span>
          <span>{t("inspect.magicResist")} <b>{unit.base_stats.magic_resist_bp / 100}%</b></span>
        </div>
        <div class="inspect-effects">{t("inspect.effects", { effects: unit.effects.length ? unit.effects.map(effectLabel).join(" / ") : t("inspect.noEffects") })}</div>
      </div>
    </section>
  </dialog>
{/if}
