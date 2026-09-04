<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { burstOptionsForCostume, commandCost } from "../lib/battle-ui-model";
  import type { BurstOption } from "../lib/battle-ui-model";
  import type { BattleState } from "../lib/battle-state.svelte";
  import { t } from "../lib/i18n";
  import { commandPresentation, costumeById } from "../lib/presentation";
  import type { BattleCommand } from "../lib/types";
  import MiniRange from "./MiniRange.svelte";

  let { model }: { model: BattleState } = $props();

  type CommandOption = {
    command: BattleCommand;
    index: number | null;
    available: boolean;
    variants: BurstOption<BattleCommand>[];
    key: string | null;
  };

  let unit = $derived(model.selectedUnit);
  let entry = $derived(unit ? model.legalFor(unit.id) : undefined);
  let selected = $derived(model.selectedCommand);
  let grid = $derived(model.snapshot?.state.rules.grid ?? { rows: 3, depths: 4 });
  let options = $derived.by<CommandOption[]>(() => {
    if (!unit || !entry) return [];
    const choices: CommandOption[] = entry.commands
      .map((command, index) => ({ command, index, available: true, variants: [], key: null }))
      .filter(({ command }) => command.type !== "USE_COSTUME");
    for (const loadout of unit.costume_loadout ?? []) {
      const variants = burstOptionsForCostume(entry.commands, entry.unavailable_commands, loadout.costume_id);
      if (!variants.length) continue;
      const key = `${unit.id}:${loadout.costume_id}`;
      const selectedLevel = selected?.type === "USE_COSTUME" && selected.costume_id === loadout.costume_id
        ? Number(selected.burst_level ?? 0)
        : model.plannedBurstLevels.get(key) ?? 0;
      const chosen = variants.find((option) => option.level === selectedLevel) ?? variants[0];
      if (chosen) choices.push({ ...chosen, variants, key });
    }
    return choices;
  });

  const chooseBurst = (option: CommandOption, direction: number): void => {
    if (!unit || !option.key) return;
    const currentLevel = Number(option.command.burst_level ?? 0);
    const position = option.variants.findIndex((variant) => variant.level === currentLevel);
    const target = option.variants[position + direction];
    if (!target) return;
    if (!target.available || target.index === null) {
      model.showError(t(target.command.unavailable_reason === "INSUFFICIENT_SP" ? "error.insufficientSp" : "error.maskedAction"));
      return;
    }
    const levels = new SvelteMap(model.plannedBurstLevels);
    levels.set(option.key, target.level);
    model.plannedBurstLevels = levels;
    model.selectAction(unit.id, target.index);
  };
</script>

<section class="command-panel" id="action-dock" aria-labelledby="command-heading">
  <div class="command-heading">
    <span>
      <small id="reservation-unit-name">{unit ? model.entity(unit.character_id)?.name ?? unit.character_id : t("selection.none")}</small>
      <b id="command-heading">{t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.nextAction" : "reservation.title")}</b>
    </span>
    <span class="reservation-sp">
      <small>{t(model.mode === "GOLDEN_COLOSSEUM" ? "golden.infiniteSp" : "reservation.remainingSp")}</small>
      <b id="reservation-sp">{model.mode === "GOLDEN_COLOSSEUM" ? "∞" : model.currentPlayerTeam ? model.currentPlayerTeam.sp - model.reservedSp : "—"}</b>
    </span>
  </div>
  <div class="costume-strip" id="costume-strip" role="listbox" aria-label={t("reservation.optionsAria")}>
    {#if model.capabilities.automaticBattle}
      <p class="automatic-action-note">{t("golden.noManualAction")}</p>
    {:else if unit && entry && model.catalog}
      {#each options as option, displayIndex (`${option.command.type}:${option.command.costume_id ?? ""}:${option.command.burst_level ?? 0}`)}
        {@const command = option.command}
        {@const meta = commandPresentation(model.catalog, unit, command)}
        {@const costume = command.costume_id ? costumeById(model.catalog, command.costume_id) : undefined}
        {@const cooldown = costume ? Number(command.cooldown_remaining ?? unit.cooldowns[costume.id] ?? 0) : 0}
        {@const isSelected = option.available && model.selectedCommandIndex(unit.id) === option.index}
        {@const currentCommand = model.selectedCommand}
        {@const prospectiveCost = option.available ? model.reservedSp - commandCost(currentCommand, (id) => model.costume(id)) + commandCost(command, (id) => model.costume(id)) : Number.POSITIVE_INFINITY}
        {@const isUnaffordable = command.unavailable_reason === "INSUFFICIENT_SP" || option.available && !isSelected && prospectiveCost > (model.currentPlayerTeam?.sp ?? 0)}
        {@const isOnCooldown = command.unavailable_reason === "COOLDOWN"}
        {@const burstLevel = Number(command.burst_level ?? 0)}
        {@const burstPosition = option.variants.findIndex((variant) => variant.level === burstLevel)}
        <div class="command-option" class:burst-capable={option.variants.length > 1}>
          <button
            type="button"
            class="command-card"
            class:default-command={option.index === 0}
            class:selected={isSelected}
            class:unaffordable={isUnaffordable}
            class:unavailable={!option.available}
            data-command-index={option.index ?? undefined}
            data-command-type={command.type}
            data-costume-id={command.costume_id}
            data-testid={option.available ? `command-${unit.id}-${displayIndex}` : `command-${unit.id}-unavailable-${command.costume_id ?? command.type}`}
            data-burst-level={burstLevel}
            disabled={!option.available || !model.capabilities.manualPlayer}
            role="option"
            aria-selected={isSelected}
            aria-label={t("action.cardAria", {
              name: meta.name,
              burst: option.variants.length > 1 ? (burstLevel > 0 ? t("action.burstAriaSuffix", { level: burstLevel }) : t("action.burstNoneAriaSuffix")) : "",
              sp: meta.sp_cost,
              cooldown: cooldown ? t("action.cooldownSuffix", { cooldown }) : "",
              state: isSelected ? t("action.reservedSuffix") : isOnCooldown ? t("action.cooldownUnavailableSuffix") : isUnaffordable ? t("action.unaffordableSuffix") : !option.available ? t("action.unavailableSuffix") : "",
            })}
            onclick={() => { if (option.index !== null) model.selectAction(unit.id, option.index); }}
          >
            <span class="command-glyph">{meta.glyph}</span>
            <span class="command-name">
              <b>{meta.name}</b>
              <small>{meta.selector ? t(`selector.${meta.selector}`) : t("action.primaryTarget")} · {meta.operation_summary}</small>
              <em class="command-prediction" hidden={!isSelected || !model.preview}>{isSelected && model.preview ? t("selection.predictedDamageInline", { damage: model.selectedDamage.toLocaleString("ja-JP") }) : ""}</em>
            </span>
            <span class="command-cost"><b>SP {model.mode === "GOLDEN_COLOSSEUM" ? "∞" : meta.sp_cost}</b>{#if cooldown && model.mode !== "GOLDEN_COLOSSEUM"}<small>CT {cooldown}</small>{/if}</span>
            <span
              class="command-range"
              class:knockback-range={command.type === "KNOCKBACK"}
              aria-hidden="true"
              style:grid-template-columns={command.type === "KNOCKBACK" ? undefined : `repeat(${grid.depths}, 8px)`}
              style:grid-template-rows={command.type === "KNOCKBACK" ? undefined : `repeat(${grid.rows}, 8px)`}
            >
              <MiniRange range={meta.range} rows={grid.rows} depths={grid.depths} knockbackDirection={meta.knockback_direction} />
            </span>
            <span class="command-state">{isSelected ? t("action.reserved") : isOnCooldown ? t("action.cooldownState", { cooldown }) : isUnaffordable ? t("action.unaffordable") : !option.available ? t("action.unavailable") : ""}</span>
          </button>
          {#if option.variants.length > 1 && isSelected}
            <span class="burst-stepper" role="group" aria-label={t("action.burstControlsAria", { name: meta.name })}>
              <button type="button" class="burst-arrow burst-down" disabled={burstPosition <= 0} aria-label={t("action.burstDecreaseAria", { name: meta.name })} onclick={(event) => { event.stopPropagation(); chooseBurst(option, -1); }}>‹</button>
              <b class="burst-level" class:active={burstLevel > 0}>{burstLevel > 0 ? t("action.burstLevel", { level: burstLevel }) : t("action.burstNone")}</b>
              <button type="button" class="burst-arrow burst-up" disabled={burstPosition < 0 || burstPosition >= option.variants.length - 1} aria-label={t("action.burstIncreaseAria", { name: meta.name })} onclick={(event) => { event.stopPropagation(); chooseBurst(option, 1); }}>›</button>
            </span>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>
