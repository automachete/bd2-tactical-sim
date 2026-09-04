<script lang="ts">
  import type { FeedbackState } from "../lib/state/feedback-state.svelte";

  let { feedback }: { feedback: FeedbackState } = $props();
</script>

<div class="toast" class:hidden={!feedback.error} id="toast" role="alert">{feedback.error}</div>
<div class="busy" class:hidden={!feedback.busy} id="busy" role="status" aria-live="assertive"><span></span><b id="busy-label">{feedback.busyLabel}</b></div>
<div class="sr-only" id="drag-announcer" aria-live="assertive">{feedback.announcement}</div>
