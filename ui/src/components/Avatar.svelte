<script lang="ts">
  import { elementClass, initials, portraitPath } from "../lib/presentation";
  import type { CharacterDefinition, EntityDefinition } from "../lib/types";

  let {
    character,
    className = "token-emblem",
    id,
  }: {
    character: CharacterDefinition | EntityDefinition | undefined;
    className?: string;
    id?: string;
  } = $props();

  let source = $derived(portraitPath(character));
</script>

<span
  {id}
  class={`${className} ${elementClass(character?.element)}`}
  data-character-id={character?.id ?? ""}
  aria-hidden="true"
>
  {#if source}
    <img
      class="character-portrait"
      src={source}
      alt=""
      width="64"
      height="64"
      decoding="async"
      draggable="false"
    />
  {:else}
    {initials(character)}
  {/if}
</span>
