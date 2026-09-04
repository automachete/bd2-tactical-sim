<script lang="ts">
  import type { BattleState } from "../../lib/battle-state.svelte";
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";

  let { model }: { model: BattleState } = $props();
</script>

{#if model.dialog === "log"}
  <dialog use:modal class="sim-dialog log-dialog" id="log-dialog" onclose={() => model.close("log")}>
    <section class="dialog-frame compact-dialog">
      <header class="dialog-title"><div><small>{t("log.caption")}</small><h1><span>{t("log.title")}</span> <span id="event-count">{model.snapshot?.state.event_log.length ?? 0}</span></h1></div><button class="dialog-close" type="button" aria-label={t("log.closeAria")} onclick={() => model.close("log")}>×</button></header>
      <ol class="event-list" id="events">{#each model.battleLog() as event, index (`${index}:${event}`)}<li>{event}</li>{/each}</ol>
    </section>
  </dialog>
{/if}
