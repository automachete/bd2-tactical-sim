<script lang="ts">
  import { cellKey, knockbackPreviewCells, rangePreviewCells } from "../lib/battle-ui-model";
  import type { Cell } from "../lib/types";

  let {
    range,
    rows,
    depths,
    knockbackDirection,
  }: {
    range: Cell[];
    rows: number;
    depths: number;
    knockbackDirection: string | undefined;
  } = $props();

  let hits = $derived(rangePreviewCells(range, rows, depths));
  let knockback = $derived(knockbackDirection ? knockbackPreviewCells(knockbackDirection) : null);
</script>

{#if knockback}
  <span class="knockback-value"><b>{knockback.arrow}</b><em>{knockback.distance}</em></span>
  <span class="knockback-grid">
    {#each Array.from({ length: 9 }, (_, index) => index) as index (index)}
      {@const row = Math.floor(index / 3)}
      {@const depth = index % 3}
      <i
        class:origin={row === knockback.origin.row && depth === knockback.origin.depth}
        class:destination={row === knockback.destination.row && depth === knockback.destination.depth}
      >{row === knockback.destination.row && depth === knockback.destination.depth ? knockback.arrow : ""}</i>
    {/each}
  </span>
{:else}
  {#each Array.from({ length: rows * depths }, (_, index) => index) as index (index)}
    {@const row = Math.floor(index / depths)}
    {@const depth = index % depths}
    <i class:hit={hits.has(cellKey(row, depth))}></i>
  {/each}
{/if}
