<script lang="ts">
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";
  import type { SessionState } from "../../lib/state/session-state.svelte";

  let { dialogs, session }: { dialogs: DialogState; session: SessionState } = $props();
</script>

{#if dialogs.dialog === "log"}
  <dialog use:modal class="sim-dialog log-dialog" id="log-dialog" onclose={() => dialogs.close("log")}>
    <section class="dialog-frame compact-dialog">
      <header class="dialog-title"><div><small>{t("log.caption")}</small><h1><span>{t("log.title")}</span> <span id="event-count">{session.snapshot?.state.event_log.length ?? 0}</span></h1></div><button class="dialog-close" type="button" aria-label={t("log.closeAria")} onclick={() => dialogs.close("log")}>×</button></header>
      <ol class="event-list" id="events">{#each session.battleLog() as event, index (`${index}:${event}`)}<li>{event}</li>{/each}</ol>
    </section>
  </dialog>
{/if}
