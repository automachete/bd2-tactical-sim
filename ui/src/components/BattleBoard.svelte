<script lang="ts">
  import { onDestroy } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { cellKey, keyboardTarget, occupantAt } from "../lib/battle-ui-model";
  import { t } from "../lib/i18n";
  import { elementClass, formatNumber } from "../lib/presentation";
  import type { CatalogState } from "../lib/state/catalog-state.svelte";
  import type { DialogState } from "../lib/state/dialog-state.svelte";
  import type { FeedbackState } from "../lib/state/feedback-state.svelte";
  import type { PlanningState } from "../lib/state/planning-state.svelte";
  import type { PlaybackState } from "../lib/state/playback-state.svelte";
  import type { SessionState } from "../lib/state/session-state.svelte";
  import type { BattleUnit, Cell, Side } from "../lib/types";
  import Avatar from "./Avatar.svelte";

  let { catalog, dialogs, feedback, planning, playback, session }: {
    catalog: CatalogState;
    dialogs: DialogState;
    feedback: FeedbackState;
    planning: PlanningState;
    playback: PlaybackState;
    session: SessionState;
  } = $props();

  let dragId = $state<number | null>(null);
  let dropCell = $state<Cell | null>(null);
  let pointer = $state<{ unitId: number; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  let keyboard = $state<{ unitId: number; row: number; depth: number } | null>(null);
  const playerCells = new SvelteMap<string, HTMLElement>();
  let focusTimer: number | undefined;

  onDestroy(() => {
    if (focusTimer !== undefined) window.clearTimeout(focusTimer);
  });

  let grid = $derived(session.snapshot?.state.rules.grid ?? { rows: 3, depths: 4, deployment_limit: 5, blocked: [] });
  let playerDepths = $derived(Array.from({ length: grid.depths }, (_, index) => grid.depths - index - 1));
  let enemyDepths = $derived(Array.from({ length: grid.depths }, (_, index) => index));

  const cellList = (side: Side): Cell[] => {
    const depths = side === "PLAYER" ? playerDepths : enemyDepths;
    return Array.from({ length: grid.rows }, (_, row) => depths.map((depth) => ({ row, depth }))).flat();
  };
  const unitsFor = (side: Side): BattleUnit[] => (side === "PLAYER" ? playback.playerUnits : playback.enemyUnits).filter((unit) => unit.alive);
  const unitAt = (side: Side, row: number, depth: number): BattleUnit | undefined => unitsFor(side).find((unit) => {
    const position = side === "PLAYER" && !playback.executing ? planning.effectivePosition(unit) : unit.position;
    return position.row === row && position.depth === depth;
  });
  const blocked = (row: number, depth: number): boolean => grid.blocked.some(([blockedRow, blockedDepth]) => blockedRow === row && blockedDepth === depth);
  const registerPlayerCell = (node: HTMLElement, cell: Cell): { destroy: () => void } => {
    playerCells.set(cellKey(cell.row, cell.depth), node);
    return { destroy: () => playerCells.delete(cellKey(cell.row, cell.depth)) };
  };
  const cellAt = (x: number, y: number): Cell | null => {
    for (const [key, node] of playerCells) {
      const rect = node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const [row, depth] = key.split(",").map(Number);
        return row === undefined || depth === undefined ? null : { row, depth };
      }
    }
    return null;
  };
  const beginPointer = (event: PointerEvent, unit: BattleUnit): void => {
    if (!session.capabilities.formation || event.button !== 0) return;
    pointer = { unitId: unit.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const movePointer = (event: PointerEvent): void => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (!pointer.active && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 7) pointer.active = true;
    if (pointer.active) dropCell = cellAt(event.clientX, event.clientY);
  };
  const endPointer = (event: PointerEvent): void => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const current = pointer;
    const target = current.active ? cellAt(event.clientX, event.clientY) : null;
    pointer = null;
    dropCell = null;
    if (target) {
      event.preventDefault();
      planning.moveBattleUnit(current.unitId, target.row, target.depth);
    }
  };
  const beginKeyboard = (unit: BattleUnit): void => {
    if (!session.capabilities.formation) {
      feedback.showError(t("error.runtimeFormationLocked"));
      return;
    }
    const position = planning.effectivePosition(unit);
    keyboard = { unitId: unit.id, row: position.row, depth: position.depth };
    feedback.announce(t("formation.pickup", { name: catalog.entity(unit.character_id)?.name ?? unit.character_id }));
    if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      focusTimer = undefined;
      playerCells.get(cellKey(position.row, position.depth))?.focus();
    }, 0);
  };
  const keyboardMove = (event: KeyboardEvent): void => {
    if (!keyboard) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const target = keyboardTarget(keyboard, event.key, grid.rows, grid.depths);
      keyboard = { ...keyboard, ...target };
      playerCells.get(cellKey(target.row, target.depth))?.focus();
      feedback.announce(t("formation.keyboardTarget", { row: target.row + 1, depth: target.depth + 1 }));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const target = keyboard;
      keyboard = null;
      planning.moveBattleUnit(target.unitId, target.row, target.depth);
    } else if (event.key === "Escape") {
      event.preventDefault();
      keyboard = null;
      feedback.announce(t("formation.cancelled"));
    }
  };
  const forecastFor = (unitId: number) => planning.preview?.damage_by_target.find((item) => item.target_id === unitId);
</script>

<svelte:window onkeydown={keyboardMove} />

<div class="turn-banner">
  <span id="mode-label">{t(`mode.${session.mode}`)}</span>
  <strong id="turn-label">{t("battle.turn", { turn: session.snapshot?.state.game_turn ?? 1 })}</strong>
  <span id="team-label">{t("party.team", { number: playback.activeParty })}</span>
</div>

<div class="topdown-stage" data-testid="topdown-stage">
  {#each ["PLAYER", "ENEMY"] as side (side)}
    {@const typedSide = side as Side}
    <section class={`board-side ${typedSide === "PLAYER" ? "player-side" : "enemy-side"}`} aria-labelledby={`${typedSide.toLowerCase()}-board-heading`}>
      <div class="board-label">
        <b id={`${typedSide.toLowerCase()}-board-heading`}>{t(typedSide === "PLAYER" ? "board.ally" : "board.enemy")}</b>
        <span id={typedSide === "PLAYER" ? "formation-state" : undefined}>{typedSide === "PLAYER" ? t(session.capabilities.formation ? "board.formationEditable" : "board.formationLocked") : t("board.previewHint")}</span>
      </div>
      <div
        class={`battle-grid ${typedSide === "PLAYER" ? "player-grid" : "enemy-grid"}`}
        id={typedSide === "PLAYER" ? "player-field" : "enemy-field"}
        role="grid"
        aria-label={t(typedSide === "PLAYER" ? "board.playerDynamicAria" : "board.enemyDynamicAria", { rows: grid.rows, depths: grid.depths })}
        style:grid-template-columns={`repeat(${grid.depths}, minmax(0, 1fr))`}
        style:grid-template-rows={`repeat(${grid.rows}, minmax(0, 1fr))`}
      >
        {#each cellList(typedSide) as cell (`${typedSide}-${cell.row}-${cell.depth}`)}
          {@const unit = unitAt(typedSide, cell.row, cell.depth)}
          {@const isBlocked = blocked(cell.row, cell.depth)}
          {@const playbackCell = playback.playbackTargetCell}
          {@const playbackCellTarget = playback.executing && playbackCell?.side === typedSide && playbackCell.row === cell.row && playbackCell.depth === cell.depth}
          {@const previewed = planning.preview?.target_side === typedSide && planning.previewCells.has(cellKey(cell.row, cell.depth)) || playbackCellTarget}
          {@const anchored = planning.preview?.target_side === typedSide && planning.preview?.anchor?.row === cell.row && planning.preview.anchor.depth === cell.depth || playback.executing && unit?.id === playback.playbackTargetId || playbackCellTarget}
          {@const occupied = unit ? planning.previewTargetIds.has(unit.id) : false}
          <div
            use:registerPlayerCell={typedSide === "PLAYER" ? cell : { row: -1, depth: -1 }}
            tabindex="0"
            class="field-cell"
            class:locked={typedSide === "PLAYER" && !session.capabilities.formation}
            class:blocked={isBlocked}
            class:drop-valid={typedSide === "PLAYER" && dropCell?.row === cell.row && dropCell.depth === cell.depth && !occupantAt(planning.plannedFormation, cell.row, cell.depth, dragId ?? pointer?.unitId ?? null)}
            class:drop-swap={typedSide === "PLAYER" && dropCell?.row === cell.row && dropCell.depth === cell.depth && Boolean(occupantAt(planning.plannedFormation, cell.row, cell.depth, dragId ?? pointer?.unitId ?? null))}
            class:keyboard-target={typedSide === "PLAYER" && keyboard?.row === cell.row && keyboard.depth === cell.depth}
            class:target-preview={previewed}
            class:target-anchor={anchored}
            class:target-occupied={occupied}
            data-row={cell.row}
            data-depth={cell.depth}
            data-coordinate={`${cell.row + 1}-${cell.depth + 1}`}
            data-testid={`${typedSide.toLowerCase()}-cell-${cell.row}-${cell.depth}`}
            role="gridcell"
            aria-label={t("formation.cellAria", { side: t(`battle.side.${typedSide}`), row: cell.row + 1, depth: cell.depth + 1 })}
            aria-disabled={isBlocked ? "true" : undefined}
            ondragover={(event) => {
              if (typedSide !== "PLAYER" || dragId === null || !session.capabilities.formation) return;
              event.preventDefault();
              dropCell = cell;
            }}
            ondragleave={() => { if (dropCell?.row === cell.row && dropCell.depth === cell.depth) dropCell = null; }}
            ondrop={(event) => {
              if (typedSide !== "PLAYER") return;
              event.preventDefault();
              const moving = dragId ?? Number(event.dataTransfer?.getData("text/plain"));
              dragId = null;
              dropCell = null;
              if (Number.isFinite(moving)) planning.moveBattleUnit(moving, cell.row, cell.depth);
            }}
          >
            {#if unit}
              {@const character = catalog.entity(unit.character_id)}
              {@const hp = Math.max(0, 100 * unit.hp / Math.max(1, unit.base_stats.max_hp))}
              <button
                type="button"
                class={`battle-token ${elementClass(character?.element)} ${typedSide === "ENEMY" ? "enemy-token" : ""}`}
                class:selected={planning.selectedUnitId === unit.id}
                class:actor-focus={playback.playbackActorId === unit.id}
                class:targeted={playback.playbackTargetId === unit.id}
                class:pointer-dragging={pointer?.unitId === unit.id && pointer.active}
                class:playback-created={playback.playbackCreated.has(unit.id)}
                draggable={typedSide === "PLAYER" && session.capabilities.formation && unit.alive}
                data-unit-id={unit.id}
                data-testid={`${typedSide.toLowerCase()}-token-${unit.id}`}
                aria-label={t(typedSide === "PLAYER" ? "formation.playerTokenAria" : "formation.enemyTokenAria", { name: character?.name ?? unit.character_id, hp: unit.hp })}
                aria-grabbed={typedSide === "PLAYER" && (dragId === unit.id || pointer?.unitId === unit.id && pointer.active)}
                onclick={() => typedSide === "PLAYER" ? planning.selectUnit(unit.id) : dialogs.inspect(unit.id)}
                ondragstart={(event) => {
                  if (typedSide !== "PLAYER" || !session.capabilities.formation) { event.preventDefault(); feedback.showError(t("error.formationLocked")); return; }
                  dragId = unit.id;
                  event.dataTransfer?.setData("text/plain", String(unit.id));
                }}
                ondragend={() => { dragId = null; dropCell = null; }}
                onkeydown={(event) => { if (typedSide === "PLAYER" && event.key === " ") { event.preventDefault(); event.stopPropagation(); beginKeyboard(unit); } }}
                onpointerdown={(event) => { if (typedSide === "PLAYER") beginPointer(event, unit); }}
                onpointermove={movePointer}
                onpointerup={endPointer}
                onpointercancel={() => { pointer = null; dropCell = null; }}
              >
                <Avatar {character} />
                <span class="token-copy"><b>{character?.name ?? unit.character_id}</b><small>{session.mode === "GOLDEN_COLOSSEUM" ? `${catalog.costume(unit.costume_loadout.find((item) => item.enabled !== false)?.costume_id ?? "")?.name ?? ""} · ` : ""}HP {formatNumber(unit.hp)}</small></span>
                <span class="mini-hp"><i style:width={`${hp}%`}></i></span>
              </button>
              {@const forecast = forecastFor(unit.id)}
              {#if forecast}
                <span
                  class="damage-preview"
                  class:critical={forecast.critical_hits > 0}
                  data-testid={`predicted-damage-${unit.id}`}
                  aria-label={t("selection.predictedDamageTarget", { name: character?.name ?? unit.character_id, damage: formatNumber(forecast.amount) })}
                >{forecast.evaded_hits > 0 && forecast.amount === 0 ? t("battle.evaded") : formatNumber(forecast.amount)}</span>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </section>
    {#if typedSide === "PLAYER"}
      <div class="frontline" aria-hidden="true"><span>{t("board.front")}</span><b>{t("board.versus")}</b><span>{t("board.front")}</span></div>
    {/if}
  {/each}
  <svg class="target-line hidden" id="target-line" aria-hidden="true"><line x1="0" y1="0" x2="0" y2="0"></line></svg>
  <div class="battle-cue" class:hidden={!playback.cue.title && !playback.cue.detail} id="battle-cue" role="status" aria-live="assertive"><small id="cue-turn">{playback.cue.turn}</small><strong id="cue-title">{playback.cue.title}</strong><span id="cue-detail">{playback.cue.detail}</span></div>
  <div class="floating-layer" id="floating-layer" aria-hidden="true">
    {#each playback.floating as item (item.id)}
      <span class={`floating-number ${item.className}`}>{item.text}</span>
    {/each}
  </div>
</div>

<div class="interaction-message" id="tip-banner" role="status" aria-live="polite">{feedback.tip}</div>
