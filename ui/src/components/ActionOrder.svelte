<script lang="ts">
  import { flushSync } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { reorder } from "../lib/battle-ui-model";
  import type { BattleState } from "../lib/battle-state.svelte";
  import { t } from "../lib/i18n";
  import { commandPresentation, elementClass, formatNumber } from "../lib/presentation";
  import Avatar from "./Avatar.svelte";

  let { model }: { model: BattleState } = $props();

  let dragId = $state<number | null>(null);
  let dropId = $state<number | null>(null);
  let dropAfter = $state(false);
  let dropAtEnd = $state(false);
  let pointer = $state<{ unitId: number; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  let suppressClick = $state(false);
  const cards = new SvelteMap<number, HTMLElement>();

  const register = (node: HTMLElement, unitId: number): { destroy: () => void } => {
    cards.set(unitId, node);
    return { destroy: () => cards.delete(unitId) };
  };

  const cardAt = (x: number, y: number): { unitId: number; after: boolean } | null => {
    for (const [unitId, node] of cards) {
      const rect = node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { unitId, after: y > rect.top + rect.height / 2 };
      }
    }
    return null;
  };

  const pointerDown = (event: PointerEvent, unitId: number): void => {
    if (event.pointerType === "mouse" || event.button !== 0 || !model.capabilities.manualPlayer) return;
    pointer = { unitId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const pointerMove = (event: PointerEvent): void => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (!pointer.active && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 7) pointer.active = true;
    if (!pointer.active) return;
    const target = cardAt(event.clientX, event.clientY);
    dropId = target?.unitId ?? null;
    dropAfter = target?.after ?? false;
  };

  const pointerUp = (event: PointerEvent): void => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const current = pointer;
    const target = current.active ? cardAt(event.clientX, event.clientY) : null;
    pointer = null;
    dropId = null;
    if (current.active) {
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    }
    if (target && target.unitId !== current.unitId) model.moveOrder(current.unitId, target.unitId, target.after);
  };

  const keyboardMove = (event: KeyboardEvent, unitId: number): void => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = reorder(model.plannedOrder, unitId, event.key === "ArrowUp" ? -1 : 1);
    if (next.some((value, index) => value !== model.plannedOrder[index])) {
      model.plannedOrder = next;
      model.requestPreview();
      window.setTimeout(() => cards.get(unitId)?.focus(), 0);
    }
  };
</script>

<section class="order-panel" aria-labelledby="order-heading">
  <div class="panel-heading">
    <span><small>{t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.actionCaption" : "order.caption")}</small><b id="order-heading">{t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.actionOrder" : "order.title")}</b></span>
    <span class="drag-hint">{t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.orderFixed" : "order.dragHint")}</span>
  </div>
  <div
    class="ally-order"
    class:drop-at-end={dropAtEnd}
    id="ally-rail"
    role="list"
    aria-label={model.capabilities.automaticBattle ? t("golden.pendingAria", { side: t(`battle.side.${model.snapshot?.state.active_side ?? "PLAYER"}`) }) : t("order.listAria")}
    data-testid="ally-order"
    ondragover={(event) => {
      if (dragId === null || event.target !== event.currentTarget) return;
      event.preventDefault();
      dropAtEnd = true;
    }}
    ondragleave={(event) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dropAtEnd = false;
    }}
    ondrop={(event) => {
      if (event.target !== event.currentTarget || dragId === null) return;
      event.preventDefault();
      const moving = dragId;
      dragId = null;
      dropAtEnd = false;
      const finalTarget = model.plannedOrder.findLast((id) => id !== moving);
      if (finalTarget !== undefined) model.moveOrder(moving, finalTarget, true);
    }}
  >
    {#each model.plannedOrder as unitId, index (unitId)}
      {@const unit = model.units[String(unitId)]}
      {#if unit}
        {@const character = model.entity(unit.character_id)}
        {@const legal = model.legalFor(unit.id)}
        {@const actionable = Boolean(legal?.commands.length)}
        {@const command = legal?.commands[model.selectedCommandIndex(unit.id)]}
        {@const meta = model.catalog ? commandPresentation(model.catalog, unit, command) : null}
        <button
          use:register={unit.id}
          type="button"
          draggable={actionable && model.capabilities.manualPlayer}
          disabled={!actionable}
          class={`order-card ${elementClass(character?.element)} ${model.selectedUnitId === unit.id ? "selected" : ""} ${actionable ? "" : "inactive"}`}
          class:dragging={dragId === unit.id || pointer?.unitId === unit.id && pointer.active}
          class:drop-before={dropId === unit.id && !dropAfter}
          class:drop-after={dropId === unit.id && dropAfter}
          data-unit-id={unit.id}
          data-testid={`order-unit-${unit.id}`}
          aria-label={model.capabilities.automaticBattle
            ? t("golden.pendingCardAria", { order: index + 1, name: character?.name ?? unit.character_id, action: actionable ? meta?.name ?? t("golden.awaitingAction") : t("golden.awaitingAction") })
            : t("order.cardAria", { order: index + 1, name: character?.name ?? unit.character_id, action: meta?.name ?? t("action.cannotAct") })}
          onclick={(event) => { if (suppressClick) event.preventDefault(); else flushSync(() => { model.selectUnit(unit.id); }); }}
          ondragstart={(event) => {
            if (!model.capabilities.manualPlayer) { event.preventDefault(); return; }
            dragId = unit.id;
            event.dataTransfer?.setData("text/plain", String(unit.id));
          }}
          ondragover={(event) => {
            if (dragId === null) return;
            event.preventDefault();
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            dropId = unit.id;
            dropAfter = event.clientY > rect.top + rect.height / 2;
          }}
          ondragleave={() => { if (dropId === unit.id) dropId = null; }}
          ondrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const moving = dragId;
            dragId = null;
            if (moving !== null) model.moveOrder(moving, unit.id, dropAfter);
            dropId = null;
          }}
          ondragend={() => { dragId = null; dropId = null; dropAtEnd = false; }}
          onpointerdown={(event) => pointerDown(event, unit.id)}
          onpointermove={pointerMove}
          onpointerup={pointerUp}
          onpointercancel={() => { pointer = null; dropId = null; }}
          onkeydown={(event) => keyboardMove(event, unit.id)}
        >
          <span class="order-number">{index + 1}</span>
          <Avatar {character} className="small-emblem" />
          <span class="order-copy">
            <b>{character?.name ?? unit.character_id}</b>
            <small>{model.mode === "GOLDEN_COLOSSEUM" ? model.costume(unit.costume_loadout.find((item) => item.enabled !== false)?.costume_id ?? "")?.name ?? "" : meta?.name ?? ""} · HP {formatNumber(unit.hp)}</small>
          </span>
          <span class="reserved-mark">{model.selectedCommandIndex(unit.id) > 0 ? "◆" : ""}</span>
        </button>
      {/if}
    {/each}
  </div>
</section>
