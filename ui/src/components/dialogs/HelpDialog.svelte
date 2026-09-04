<script lang="ts">
  import { t } from "../../lib/i18n";
  import { modal } from "../../lib/modal";
  import type { DialogState } from "../../lib/state/dialog-state.svelte";

  let { dialogs }: { dialogs: DialogState } = $props();
  const steps = ["formation", "reserve", "order", "keyboard", "execute"];
</script>

{#if dialogs.dialog === "help"}
  <dialog use:modal class="sim-dialog help-dialog" id="help-dialog" onclose={() => dialogs.close("help")}>
    <section class="dialog-frame compact-dialog">
      <header class="dialog-title"><div><small>{t("help.caption")}</small><h1>{t("help.title")}</h1></div><button class="dialog-close" type="button" aria-label={t("help.closeAria")} onclick={() => dialogs.close("help")}>×</button></header>
      <div class="help-flow">
        {#each steps as step, index (step)}<span>{index + 1}</span><p><b>{t(`help.${step}Title`)}</b><span>{t(`help.${step}Body`)}</span></p>{/each}
      </div>
    </section>
  </dialog>
{/if}
