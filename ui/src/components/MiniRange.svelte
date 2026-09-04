<script lang="ts">
  import { cellKey, knockbackPreviewCells, rangePreviewCells } from "../lib/battle-ui-model";
  import type { Cell } from "../lib/types";

  let {
    range,
    rows,
    depths,
    knockbackDirection,
    knockbackOffset,
  }: {
    range: Cell[];
    rows: number;
    depths: number;
    knockbackDirection: string | undefined;
    knockbackOffset: Cell | undefined;
  } = $props();

  let hits = $derived(rangePreviewCells(range, rows, depths));
  let knockback = $derived(knockbackDirection && knockbackOffset
    ? knockbackPreviewCells(knockbackDirection, knockbackOffset)
    : null);
</script>

{#if knockback}
  <span class="knockback-value"><b>{knockback.arrow}</b><em>{knockback.distance}</em></span>
  <span class="knockback-grid" data-knockback-row={knockback.row} data-knockback-depth={knockback.depth}>
    {#each Array.from({ length: 9 }, (_, index) => index) as index (index)}
      {@const row = Math.floor(index / 3)}
      {@const depth = index % 3}
      <i
        data-row={row}
        data-depth={depth}
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
