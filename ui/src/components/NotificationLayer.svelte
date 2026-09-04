<script lang="ts">
  import type { BattleState } from "../lib/battle-state.svelte";

  let { model }: { model: BattleState } = $props();
</script>

<div class="toast" class:hidden={!model.error} id="toast" role="alert">{model.error}</div>
<div class="busy" class:hidden={!model.busy} id="busy" role="status" aria-live="assertive"><span></span><b id="busy-label">{model.busyLabel}</b></div>
<div class="sr-only" id="drag-announcer" aria-live="assertive">{model.announcement}</div>
