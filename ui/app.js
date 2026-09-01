import {
  actionIndices,
  autoReserve as chooseAutoReserve,
  cellKey,
  commandCost,
  keyboardTarget,
  modeCapabilities,
  moveFormation,
  nextSpeed,
  normalizeFormation,
  occupantAt,
  plannedSpCost,
  playbackDelay,
  projectRangeCells,
  rangePreviewCells,
  reorder,
  selectCommand,
  serializeFormation,
} from "./battle-ui-model.mjs";
import { DEFAULT_LOCALE, applyTranslations, setLocale, t } from "./i18n.mjs";

setLocale(DEFAULT_LOCALE);
applyTranslations();

let snapshot = null;
let catalog = null;
let draft = null;
let selectedUnitId = null;
let plannedOrder = [];
let plannedCommands = new Map();
let plannedFormation = {};
let orderDragId = null;
let orderPointerDrag = null;
let suppressOrderClick = false;
let battleDragId = null;
let pointerDrag = null;
let keyboardDrag = null;
let editorParty = 1;
let editorFocus = { sideKey: "player_units", index: 0 };
let editorDrag = null;
let autoReserveEnabled = false;
let autoTurnEnabled = false;
let autoTurnTimer = null;
let speedValue = 1;
let requestInFlight = false;
let animationRunning = false;
let animationPaused = false;
let playbackGeneration = 0;
let playbackTurnText = "";
let previewGeneration = 0;
let previewTimer = null;
let previewController = null;
let characterPickerTarget = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const clone = value => structuredClone(value);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const characterById = id => catalog?.characters.find(character => character.id === id);
const entityById = id => characterById(id) || catalog?.entities?.find(entity => entity.id === id);
const costumeById = id => [
  ...(catalog?.characters?.flatMap(character => character.costumes) || []),
  ...(catalog?.system_costumes || []),
].find(costume => costume.id === id);
const equipmentById = id => catalog?.equipment?.find(item => item.id === id);
const equipmentSlots = ["WEAPON", "ARMOR", "HELMET", "JEWELRY", "GLOVES"];
const defaultBuildSettings = () => clone(catalog?.build_settings_default || {
  engraving_enabled: true,
  awakening_enabled: true,
  collection: { max_hp_bp: 8000, attack_bp: 8000, magic_bp: 8000, crit_rate_bp: 5000 },
  external_buffs: { attack_bonus_bp: 0, crit_rate_bp: 0, crit_damage_bp: 0, property_damage_bp: 0, shield_percent_bp: 0, shield_flat: 0 },
  calculator: {
    damage_type: "NORMAL",
    elemental_advantage: true,
    defense_type: "NONE",
    target_condition: { min_hp: 0, min_defense_bp: 0, min_magic_resist_bp: 0 },
    option_count: 15,
    gear_filters: { exclusive: true, ur4: true, ur3: true, monster: true },
    world_buff_enabled: false,
  },
});
const displayCharacter = id => entityById(id)?.name || id;
const formatNumber = value => Number(value || 0).toLocaleString("ja-JP");
const elementClass = element => String(element || "neutral").toLowerCase();
const initials = character => String(character?.name || character?.id || t("unit.fiend")).trim().slice(0, 2).toUpperCase();
const emblemMarkup = (character, className = "token-emblem") => `<span class="${className} ${elementClass(character?.element)}" aria-hidden="true">${escapeHtml(initials(character))}</span>`;

const announce = message => {
  $("#drag-announcer").textContent = "";
  window.setTimeout(() => { $("#drag-announcer").textContent = message; }, 0);
};

const setTip = message => { $("#tip-banner").textContent = message; };

const showError = error => {
  const message = error instanceof Error ? error.message : String(error);
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  announce(message);
  window.clearTimeout(showError.timer);
  showError.timer = window.setTimeout(() => toast.classList.add("hidden"), 5000);
};

const setBusy = (enabled, label = t("status.busy")) => {
  requestInFlight = enabled;
  $("#busy-label").textContent = label;
  $("#busy").classList.toggle("hidden", !enabled);
};

const api = async (path, body, label) => {
  setBusy(true, label || t("status.loading"));
  try {
    const response = await fetch(path, body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || response.statusText);
    return result;
  } finally {
    setBusy(false);
  }
};

const silentApi = async (path, body, signal = undefined) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
};

const openDialog = id => {
  window.clearTimeout(autoTurnTimer);
  const dialog = document.getElementById(id);
  if (!dialog.open) dialog.showModal();
};
const closeDialog = id => {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
  if (id === "formation-dialog") document.querySelector(".advanced-popover")?.remove();
};

const defaultCostumes = character => character.costumes.map(costume => ({
  costume_id: costume.id,
  enhancement: costume.max_enhancement,
  burst_level: costume.max_burst_level,
  potential_mask: costume.max_potential_mask,
  permanent_potential_enabled: true,
  enabled: true,
}));

const normalizeDraft = preset => {
  const value = clone(preset);
  for (const side of ["player_units", "enemy_units"]) {
    value[side] = value[side].map(unit => ({
      ...unit,
      equipment: clone(unit.equipment || {}),
      build_settings: clone(unit.build_settings || defaultBuildSettings()),
      costumes: unit.costumes.map(costume => ({ ...costume, enabled: costume.enabled !== false })),
    }));
  }
  return value;
};

const option = (value, label, selected = false) => {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
};

const numberSelect = (minimum, maximum, selected) => {
  const select = document.createElement("select");
  for (let value = minimum; value <= maximum; value += 1) select.append(option(value, value, value === Number(selected)));
  return select;
};

const loadDraft = preset => {
  draft = normalizeDraft(preset);
  editorParty = 1;
  editorFocus = { sideKey: "player_units", index: 0 };
  $("#monster-level").value = draft.monster_level || 6;
  $$("#content-tabs button").forEach(button => button.classList.toggle("active", button.dataset.mode === draft.mode));
  $$("#party-switch button").forEach(button => button.classList.toggle("active", Number(button.dataset.party) === 1));
  renderFormation();
};

const loadPreset = mode => loadDraft(catalog.presets[mode]);

const partyUnits = sideKey => draft[sideKey]
  .map((unit, index) => ({ unit, index }))
  .filter(entry => sideKey === "enemy_units" || draft.mode !== "MONSTER_CHASER" || Number(entry.unit.party_no) === editorParty);

const moveDraftUnit = (sideKey, index, row, depth) => {
  const focused = draft[sideKey]?.[index];
  if (!focused) return;
  const source = { row: Number(focused.row), depth: Number(focused.depth) };
  const party = Number(focused.party_no || 1);
  const occupiedIndex = draft[sideKey].findIndex((unit, candidateIndex) =>
    candidateIndex !== index &&
    Number(unit.party_no || 1) === party &&
    Number(unit.row) === Number(row) &&
    Number(unit.depth) === Number(depth));
  focused.row = Number(row);
  focused.depth = Number(depth);
  if (occupiedIndex >= 0) {
    draft[sideKey][occupiedIndex].row = source.row;
    draft[sideKey][occupiedIndex].depth = source.depth;
    announce(t("formation.swap", { name: displayCharacter(focused.character_id), other: displayCharacter(draft[sideKey][occupiedIndex].character_id) }));
  } else {
    announce(t("formation.move", { name: displayCharacter(focused.character_id), row: Number(row) + 1, depth: Number(depth) + 1 }));
  }
  editorFocus = { sideKey, index };
  renderFormation();
};

const clearEditorDrop = () => $$(".formation-cell").forEach(cell => cell.classList.remove("drop-valid", "drop-swap"));

const markEditorDrop = (cell, sideKey, row, depth) => {
  clearEditorDrop();
  if (!editorDrag || editorDrag.sideKey !== sideKey) return;
  const source = draft[sideKey][editorDrag.index];
  const occupied = draft[sideKey].some((unit, index) =>
    index !== editorDrag.index &&
    Number(unit.party_no || 1) === Number(source.party_no || 1) &&
    Number(unit.row) === Number(row) && Number(unit.depth) === Number(depth));
  cell.classList.add(occupied ? "drop-swap" : "drop-valid");
};

const wireEditorDrag = (node, sideKey, index) => {
  node.draggable = true;
  node.dataset.editorSide = sideKey;
  node.dataset.editorIndex = String(index);
  node.addEventListener("dragstart", event => {
    editorDrag = { sideKey, index };
    editorFocus = { sideKey, index };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${sideKey}:${index}`);
    node.setAttribute("aria-grabbed", "true");
  });
  node.addEventListener("dragend", () => {
    editorDrag = null;
    node.setAttribute("aria-grabbed", "false");
    clearEditorDrop();
  });
};

const renderFormationBoard = (selector, sideKey) => {
  const root = $(selector);
  root.innerHTML = "";
  const entries = partyUnits(sideKey);
  for (let row = 0; row < 3; row += 1) {
    for (let depth = 0; depth < 4; depth += 1) {
      const cell = document.createElement("div");
      cell.tabIndex = 0;
      cell.className = "formation-cell";
      cell.dataset.row = String(row);
      cell.dataset.depth = String(depth);
      cell.dataset.coordinate = `${row + 1}-${depth + 1}`;
      cell.dataset.testid = `${sideKey === "player_units" ? "player" : "enemy"}-formation-cell-${row}-${depth}`;
      cell.setAttribute("role", "gridcell");
      const entry = entries.find(item => Number(item.unit.row) === row && Number(item.unit.depth) === depth);
      if (entry) {
        const character = characterById(entry.unit.character_id);
        const token = document.createElement("span");
        token.className = `formation-token ${editorFocus.sideKey === sideKey && editorFocus.index === entry.index ? "selected" : ""}`;
        token.tabIndex = 0;
        token.setAttribute("role", "button");
        token.setAttribute("aria-label", t("formation.moveAria", { name: character?.name || entry.unit.character_id }));
        token.setAttribute("aria-grabbed", "false");
        token.innerHTML = `${emblemMarkup(character)}<span class="token-copy"><b>${escapeHtml(character?.name || entry.unit.character_id)}</b><small>${escapeHtml(t(`element.${character?.element || "NONE"}`))}</small></span>`;
        wireEditorDrag(token, sideKey, entry.index);
        token.addEventListener("click", event => {
          event.stopPropagation();
          editorFocus = { sideKey, index: entry.index };
          renderFormation();
        });
        token.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            editorFocus = { sideKey, index: entry.index };
            announce(t("formation.selectHint", { name: character?.name || entry.unit.character_id }));
          }
        });
        cell.append(token);
      } else {
        cell.addEventListener("click", () => {
          if (editorFocus.sideKey !== sideKey || !draft[sideKey][editorFocus.index]) {
            const first = entries[0];
            if (!first) return;
            editorFocus = { sideKey, index: first.index };
          }
          moveDraftUnit(sideKey, editorFocus.index, row, depth);
        });
      }
      cell.addEventListener("dragover", event => {
        if (!editorDrag || editorDrag.sideKey !== sideKey) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        markEditorDrop(cell, sideKey, row, depth);
      });
      cell.addEventListener("dragleave", event => { if (!cell.contains(event.relatedTarget)) clearEditorDrop(); });
      cell.addEventListener("drop", event => {
        event.preventDefault();
        const active = editorDrag;
        editorDrag = null;
        clearEditorDrop();
        if (active?.sideKey === sideKey) moveDraftUnit(sideKey, active.index, row, depth);
      });
      root.append(cell);
    }
  }
};

const renderFormationRoster = (selector, sideKey) => {
  const root = $(selector);
  root.innerHTML = "";
  partyUnits(sideKey).forEach(({ unit, index }) => {
    const character = characterById(unit.character_id);
    const chip = document.createElement("article");
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-grabbed", "false");
    chip.setAttribute("aria-label", t("formation.rosterAria", { name: character?.name || unit.character_id }));
    chip.className = `roster-chip ${editorFocus.sideKey === sideKey && editorFocus.index === index ? "selected" : ""}`;
    chip.dataset.testid = `${sideKey}-roster-${index}`;
    chip.innerHTML = `${emblemMarkup(character)}<b>${escapeHtml(character?.name || unit.character_id)}</b><button type="button" class="roster-advanced" aria-label="${escapeHtml(t("formation.detailsAria", { name: character?.name || unit.character_id }))}">⚙</button><button type="button" class="remove-unit" aria-label="${escapeHtml(t("formation.removeAria", { name: character?.name || unit.character_id }))}">×</button>`;
    wireEditorDrag(chip, sideKey, index);
    chip.addEventListener("click", () => { editorFocus = { sideKey, index }; renderFormation(); });
    chip.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editorFocus = { sideKey, index };
        renderFormation();
      }
    });
    chip.querySelector(".roster-advanced").addEventListener("click", event => {
      event.stopPropagation();
      openAdvancedEditor(sideKey, index);
    });
    chip.querySelector(".remove-unit").addEventListener("click", event => {
      event.stopPropagation();
      draft[sideKey].splice(index, 1);
      editorFocus = { sideKey, index: Math.max(0, index - 1) };
      renderFormation();
    });
    root.append(chip);
  });
};

const renderFormation = () => {
  const monster = draft.mode === "MONSTER_CHASER";
  $("#enemy-editor").classList.toggle("hidden", monster);
  $("#monster-info").classList.toggle("hidden", !monster);
  $("#party-switch").classList.toggle("hidden", !monster);
  $$(".mcts-option").forEach(node => node.classList.toggle("hidden", monster));
  $$(".monster-option").forEach(node => node.classList.toggle("hidden", !monster));
  $("#mode-help").textContent = monster ? t("modeHelp.monster") : t("modeHelp.standard");
  renderFormationBoard("#player-formation", "player_units");
  renderFormationRoster("#player-roster", "player_units");
  if (!monster) {
    renderFormationBoard("#enemy-formation", "enemy_units");
    renderFormationRoster("#enemy-roster", "enemy_units");
  }
};

const addCharacterToParty = (side, partyNo, characterId) => {
  const sideKey = side === "PLAYER" ? "player_units" : "enemy_units";
  const inParty = draft[sideKey].filter(unit => Number(unit.party_no || 1) === partyNo);
  if (inParty.length >= 5) throw new Error(t("party.limit", { number: partyNo }));
  const occupied = new Set(inParty.map(unit => cellKey(unit.row, unit.depth)));
  const cells = Array.from({ length: 12 }, (_, index) => ({ row: Math.floor(index / 4), depth: index % 4 }));
  const cell = cells.find(value => !occupied.has(cellKey(value.row, value.depth)));
  const used = new Set(inParty.map(unit => unit.character_id));
  const character = characterById(characterId);
  if (!cell) throw new Error(t("error.noFormationCell"));
  if (!character) throw new Error(t("error.unknownCharacter"));
  if (used.has(character.id)) throw new Error(t("error.duplicateCharacter"));
  draft[sideKey].push({
    character_id: character.id,
    row: cell.row,
    depth: cell.depth,
    party_no: partyNo,
    costumes: defaultCostumes(character),
    costume_link_target: null,
    equipment: {},
    build_settings: defaultBuildSettings(),
  });
  editorFocus = { sideKey, index: draft[sideKey].length - 1 };
  renderFormation();
};

const renderCharacterPicker = () => {
  const root = $("#character-options");
  const query = $("#character-search").value.trim().toLocaleLowerCase("ja-JP");
  const target = characterPickerTarget;
  root.innerHTML = "";
  if (!target) return;
  const sideKey = target.side === "PLAYER" ? "player_units" : "enemy_units";
  const used = new Set(
    draft[sideKey]
      .filter(unit => Number(unit.party_no || 1) === Number(target.partyNo))
      .map(unit => unit.character_id),
  );
  catalog.characters
    .filter(character => `${character.name} ${character.id}`.toLocaleLowerCase("ja-JP").includes(query))
    .forEach(character => {
      const button = document.createElement("button");
      const disabled = used.has(character.id);
      button.type = "button";
      button.className = "character-option";
      button.disabled = disabled;
      button.dataset.characterId = character.id;
      button.dataset.testid = `character-option-${character.id}`;
      button.innerHTML = `${emblemMarkup(character)}<span><b>${escapeHtml(character.name)}</b><small>${escapeHtml(t(`element.${character.element}`))} · ${escapeHtml(t(`attack.${character.attack_type}`))} · ${t("unit.levelRarity")}</small></span><em>${disabled ? t("party.alreadyAdded") : t("party.add")}</em>`;
      button.addEventListener("click", () => {
        try {
          addCharacterToParty(target.side, target.partyNo, character.id);
          closeDialog("character-picker");
          characterPickerTarget = null;
        } catch (error) {
          showError(error);
        }
      });
      root.append(button);
    });
};

const openCharacterPicker = (side, partyNo) => {
  const sideKey = side === "PLAYER" ? "player_units" : "enemy_units";
  const inParty = draft[sideKey].filter(unit => Number(unit.party_no || 1) === Number(partyNo));
  if (inParty.length >= 5) {
    showError(t("party.limit", { number: partyNo }));
    return;
  }
  characterPickerTarget = { side, partyNo: Number(partyNo) };
  $("#character-search").value = "";
  $("#character-picker-side").textContent = `${side === "PLAYER" ? t("party.ally") : t("party.enemy")} · ${t("party.team", { number: partyNo })}`;
  renderCharacterPicker();
  openDialog("character-picker");
  $("#character-search").focus();
};

const renderCostumeEditor = (root, unit) => {
  const character = characterById(unit.character_id);
  if (unit.costume_link_target && unit.costumes.find(item => item.costume_id === unit.costume_link_target)?.enabled === false) {
    unit.costume_link_target = null;
  }
  const link = document.createElement("select");
  link.append(option("", t("loadout.linkNone"), !unit.costume_link_target));
  const heading = document.createElement("div");
  heading.className = "costume-line costume-line-heading";
  for (const label of [t("loadout.equipped"), t("loadout.costume"), t("loadout.enhancement"), t("loadout.burst"), t("loadout.potential"), t("loadout.permanentPotential")]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    cell.title = label;
    heading.append(cell);
  }
  root.append(heading);
  unit.costumes.forEach(loadout => {
    const definition = character.costumes.find(item => item.id === loadout.costume_id);
    if (!definition) return;
    const line = document.createElement("div");
    line.className = "costume-line";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = loadout.enabled !== false;
    enabled.disabled = enabled.checked && unit.costumes.filter(item => item.enabled !== false).length <= 1;
    enabled.title = t("loadout.equipped");
    const linkOption = option(loadout.costume_id, definition.name, unit.costume_link_target === loadout.costume_id);
    linkOption.disabled = !enabled.checked;
    enabled.onchange = () => {
      if (!enabled.checked && unit.costumes.filter(item => item.enabled !== false).length <= 1) {
        enabled.checked = true;
        showError(t("error.atLeastOneCostume"));
        return;
      }
      loadout.enabled = enabled.checked;
      linkOption.disabled = !enabled.checked;
      if (!enabled.checked && unit.costume_link_target === loadout.costume_id) {
        unit.costume_link_target = null;
        link.value = "";
      }
    };
    const name = document.createElement("span");
    name.textContent = definition.name;
    const enhancement = numberSelect(0, definition.max_enhancement, loadout.enhancement);
    enhancement.title = t("loadout.enhancement");
    enhancement.onchange = () => { loadout.enhancement = Number(enhancement.value); };
    const burst = numberSelect(0, definition.max_burst_level, loadout.burst_level);
    burst.title = t("loadout.burst");
    burst.onchange = () => { loadout.burst_level = Number(burst.value); };
    const potential = numberSelect(0, 7, loadout.potential_mask);
    potential.title = t("loadout.potential");
    potential.onchange = () => { loadout.potential_mask = Number(potential.value); };
    const permanent = document.createElement("input");
    permanent.type = "checkbox";
    permanent.checked = loadout.permanent_potential_enabled;
    permanent.title = t("loadout.permanentPotential");
    permanent.onchange = () => { loadout.permanent_potential_enabled = permanent.checked; };
    line.append(enabled, name, enhancement, burst, potential, permanent);
    root.append(line);
    link.append(linkOption);
  });
  link.onchange = () => { unit.costume_link_target = link.value || null; };
  const label = document.createElement("label");
  label.className = "inline-setting";
  label.append(t("loadout.costumeLink"), link);
  root.append(label);
};

const equipmentModifierLabels = {
  max_hp_flat: "equipment.modifier.maxHp",
  max_hp_bp: "equipment.modifier.maxHp",
  attack_flat: "equipment.modifier.attack",
  attack_bp: "equipment.modifier.attack",
  magic_flat: "equipment.modifier.magic",
  magic_bp: "equipment.modifier.magic",
  defense_bp: "equipment.modifier.defense",
  magic_resist_bp: "equipment.modifier.magicResist",
  crit_rate_bp: "equipment.modifier.critRate",
  crit_damage_bp: "equipment.modifier.critDamage",
};

const addEquipmentModifiers = (target, modifiers) => {
  for (const [field, amount] of Object.entries(modifiers || {})) {
    target[field] = Number(target[field] || 0) + Number(amount);
  }
};

const equipmentBonus = loadout => {
  if (!loadout) return {};
  const definition = equipmentById(loadout.equipment_id);
  if (!definition) return {};
  const total = { ...(definition.modifiers_by_refinement_score[String(loadout.refinement_score)] || {}) };
  const score = String(loadout.refinement_score);
  if (loadout.primary_stat) {
    addEquipmentModifiers(total, definition.primary_modifiers_by_refinement_score?.[score]?.[loadout.primary_stat]);
  }
  if (loadout.secondary_stat) {
    addEquipmentModifiers(total, definition.secondary_modifiers_by_refinement_score?.[score]?.[loadout.secondary_stat]);
  }
  for (const key of loadout.substats || []) {
    const modifier = definition.allowed_substats.find(item => item.key === key)?.modifiers || {};
    addEquipmentModifiers(total, modifier);
  }
  return total;
};

const formatEquipmentBonus = modifiers => Object.entries(modifiers)
  .filter(([, value]) => Number(value) !== 0)
  .map(([key, value]) => {
    const percentage = key.endsWith("_bp");
    const label = equipmentModifierLabels[key] ? t(equipmentModifierLabels[key]) : key;
    return `${label} +${percentage ? Number(value) / 100 : value}${percentage ? "%" : ""}`;
  })
  .join(" · ") || t("equipment.noBonus");

const renderEquipmentEditor = (root, unit, reopen) => {
  const section = document.createElement("section");
  section.className = "equipment-editor";
  const heading = document.createElement("header");
  heading.innerHTML = `<b>${escapeHtml(t("equipment.title"))}</b><small>${escapeHtml(t("equipment.scope"))}</small>`;
  section.append(heading);
  const columns = document.createElement("div");
  columns.className = "equipment-column-headings";
  for (const key of ["equipment.slotHeading", "equipment.itemHeading", "equipment.refinementScore", "equipment.mainAbilities", "equipment.subAbilities"]) {
    const label = document.createElement("span");
    label.textContent = t(key);
    columns.append(label);
  }
  section.append(columns);
  for (const slot of equipmentSlots) {
    const loadout = unit.equipment?.[slot];
    const definition = equipmentById(loadout?.equipment_id);
    const row = document.createElement("div");
    row.className = "equipment-slot-row";
    row.dataset.slot = slot;
    row.dataset.testid = `equipment-slot-${slot}`;
    const slotLabel = document.createElement("b");
    slotLabel.textContent = t(`equipment.slot.${slot}`);
    const item = document.createElement("select");
    item.dataset.testid = `equipment-item-${slot}`;
    item.append(option("", t("equipment.unequipped"), !definition));
    for (const candidate of (catalog.equipment || []).filter(value => (
      value.slot === slot
      && (value.kind !== "EXCLUSIVE" || value.owner_character_id === unit.character_id)
    ))) {
      const kind = candidate.kind === "EXCLUSIVE" ? t("equipment.exclusive") : t("equipment.craftedLegendary");
      item.append(option(candidate.id, `${candidate.name} · ${kind}`, candidate.id === definition?.id));
    }
    item.onchange = () => {
      unit.equipment ||= {};
      if (!item.value) delete unit.equipment[slot];
      else {
        const selected = equipmentById(item.value);
        const primary = selected.primary_stat_options?.[0]?.key || null;
        const secondary = selected.secondary_stat_options?.[0]?.key || null;
        unit.equipment[slot] = {
          equipment_id: selected.id,
          refinement_score: 18,
          primary_stat: primary,
          secondary_stat: secondary,
          substats: Array(3).fill(selected.allowed_substats[0].key),
        };
      }
      reopen();
    };
    const score = numberSelect(18, 24, loadout?.refinement_score ?? 18);
    score.dataset.testid = `equipment-score-${slot}`;
    score.disabled = !definition;
    score.setAttribute("aria-label", `${t(`equipment.slot.${slot}`)} ${t("equipment.refinementScore")}`);
    score.onchange = () => {
      unit.equipment[slot].refinement_score = Number(score.value);
      reopen();
    };
    const abilities = document.createElement("div");
    abilities.className = "equipment-main-abilities";
    for (const [field, choices, testId, labelKey] of [
      ["primary_stat", definition?.primary_stat_options || [], `equipment-primary-${slot}`, "equipment.primaryAbility"],
      ["secondary_stat", definition?.secondary_stat_options || [], `equipment-secondary-${slot}`, "equipment.secondaryAbility"],
    ]) {
      if (!choices.length) continue;
      const ability = document.createElement("label");
      ability.append(document.createTextNode(t(labelKey)));
      const select = document.createElement("select");
      select.dataset.testid = testId;
      for (const choice of choices) select.append(option(choice.key, choice.label, choice.key === loadout?.[field]));
      select.onchange = () => {
        unit.equipment[slot][field] = select.value;
        reopen();
      };
      ability.append(select);
      abilities.append(ability);
    }
    const substats = document.createElement("div");
    substats.className = "equipment-substats";
    for (let index = 0; index < 3; index += 1) {
      const substat = document.createElement("select");
      substat.dataset.testid = `equipment-substat-${slot}-${index}`;
      substat.disabled = !definition;
      substat.setAttribute("aria-label", `${t(`equipment.slot.${slot}`)} ${t("equipment.substat", { number: index + 1 })}`);
      for (const candidate of definition?.allowed_substats || []) {
        substat.append(option(candidate.key, candidate.label, candidate.key === loadout.substats[index]));
      }
      substat.onchange = () => {
        unit.equipment[slot].substats[index] = substat.value;
        reopen();
      };
      substats.append(substat);
    }
    const bonus = document.createElement("small");
    bonus.className = "equipment-bonus";
    bonus.textContent = definition ? formatEquipmentBonus(equipmentBonus(loadout)) : t("equipment.emptySlot");
    row.append(slotLabel, item, score, abilities, substats, bonus);
    section.append(row);
  }
  const total = {};
  for (const loadout of Object.values(unit.equipment || {})) {
    for (const [key, value] of Object.entries(equipmentBonus(loadout))) total[key] = Number(total[key] || 0) + Number(value);
  }
  const summary = document.createElement("p");
  summary.className = "equipment-total";
  summary.innerHTML = `<b>${escapeHtml(t("equipment.total"))}</b><span>${escapeHtml(formatEquipmentBonus(total))}</span>`;
  section.append(summary);
  root.append(section);
};

const buildNumberInput = (value, minimum, maximum, testId, onChange) => {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.min = String(minimum);
  if (maximum !== null) input.max = String(maximum);
  input.value = String(value);
  input.dataset.testid = testId;
  input.onchange = () => {
    const number = Number(input.value);
    if (!Number.isInteger(number) || number < minimum || (maximum !== null && number > maximum)) {
      input.value = String(value);
      showError(t("error.invalidSetupNumber"));
      return;
    }
    onChange(number);
  };
  return input;
};

const buildCheckbox = (checked, testId, onChange) => {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.dataset.testid = testId;
  input.onchange = () => onChange(input.checked);
  return input;
};

const buildSettingRow = (labelKey, control, suffix = "") => {
  const label = document.createElement("label");
  label.className = "build-setting-row";
  const caption = document.createElement("span");
  caption.textContent = t(labelKey);
  label.append(caption, control);
  if (suffix) {
    const unit = document.createElement("small");
    unit.textContent = suffix;
    label.append(unit);
  }
  return label;
};

const renderBuildSettingsEditor = (root, unit) => {
  unit.build_settings ||= defaultBuildSettings();
  const settings = unit.build_settings;
  const details = document.createElement("details");
  details.className = "build-settings-editor";
  const summary = document.createElement("summary");
  summary.innerHTML = `<b>${escapeHtml(t("build.title"))}</b><small>${escapeHtml(t("build.defaultHint"))}</small>`;
  details.append(summary);

  const group = (titleKey, body) => {
    const section = document.createElement("section");
    section.className = "build-settings-group";
    const heading = document.createElement("h4");
    heading.textContent = t(titleKey);
    section.append(heading, body);
    details.append(section);
  };
  const grid = () => {
    const node = document.createElement("div");
    node.className = "build-settings-grid";
    return node;
  };

  const progression = grid();
  progression.append(
    buildSettingRow("build.engraving", buildCheckbox(settings.engraving_enabled, "build-engraving", value => { settings.engraving_enabled = value; })),
    buildSettingRow("build.awakening", buildCheckbox(settings.awakening_enabled, "build-awakening", value => { settings.awakening_enabled = value; })),
  );
  group("build.progression", progression);

  const collection = grid();
  for (const [key, maximum, label] of [
    ["max_hp_bp", 8000, "build.collectionHp"],
    ["attack_bp", 8000, "build.collectionAttack"],
    ["magic_bp", 8000, "build.collectionMagic"],
    ["crit_rate_bp", 5000, "build.collectionCrit"],
  ]) {
    collection.append(buildSettingRow(label, buildNumberInput(settings.collection[key], 0, maximum, `build-collection-${key}`, value => { settings.collection[key] = value; }), t("build.basisPointUnit")));
  }
  group("build.collection", collection);

  const buffs = grid();
  for (const [key, minimum, label, suffix] of [
    ["attack_bonus_bp", -999999, "build.externalAttack", "build.basisPointUnit"],
    ["crit_rate_bp", -999999, "build.externalCrit", "build.basisPointUnit"],
    ["crit_damage_bp", -999999, "build.externalCritDamage", "build.basisPointUnit"],
    ["property_damage_bp", -999999, "build.externalProperty", "build.basisPointUnit"],
    ["shield_percent_bp", 0, "build.externalShieldPercent", "build.basisPointUnit"],
    ["shield_flat", 0, "build.externalShieldFlat", ""],
  ]) {
    buffs.append(buildSettingRow(label, buildNumberInput(settings.external_buffs[key], minimum, null, `build-external-${key}`, value => { settings.external_buffs[key] = value; }), suffix ? t(suffix) : ""));
  }
  group("build.external", buffs);

  const calculator = grid();
  const damageType = document.createElement("select");
  for (const key of ["NORMAL", "FIXED", "HP_SHIELD", "HP"]) damageType.append(option(key, t(`build.damageType.${key}`), settings.calculator.damage_type === key));
  damageType.dataset.testid = "build-damage-type";
  damageType.onchange = () => { settings.calculator.damage_type = damageType.value; };
  const defenseType = document.createElement("select");
  for (const key of ["NONE", "DEFENSE", "MAGIC_RESIST"]) defenseType.append(option(key, t(`build.defenseType.${key}`), settings.calculator.defense_type === key));
  defenseType.dataset.testid = "build-defense-type";
  defenseType.onchange = () => { settings.calculator.defense_type = defenseType.value; };
  calculator.append(
    buildSettingRow("build.damageType", damageType),
    buildSettingRow("build.elementalAdvantage", buildCheckbox(settings.calculator.elemental_advantage, "build-elemental-advantage", value => { settings.calculator.elemental_advantage = value; })),
    buildSettingRow("build.defenseType", defenseType),
    buildSettingRow("build.targetHp", buildNumberInput(settings.calculator.target_condition.min_hp, 0, null, "build-target-hp", value => { settings.calculator.target_condition.min_hp = value; })),
    buildSettingRow("build.targetDefense", buildNumberInput(settings.calculator.target_condition.min_defense_bp, 0, 9000, "build-target-defense", value => { settings.calculator.target_condition.min_defense_bp = value; }), t("build.basisPointUnit")),
    buildSettingRow("build.targetMagicResist", buildNumberInput(settings.calculator.target_condition.min_magic_resist_bp, 0, 9000, "build-target-magic-resist", value => { settings.calculator.target_condition.min_magic_resist_bp = value; }), t("build.basisPointUnit")),
    buildSettingRow("build.optionCount", buildNumberInput(settings.calculator.option_count, 1, 15, "build-option-count", value => { settings.calculator.option_count = value; })),
    buildSettingRow("build.worldBuff", buildCheckbox(settings.calculator.world_buff_enabled, "build-world-buff", value => { settings.calculator.world_buff_enabled = value; })),
  );
  for (const [key, label] of [
    ["exclusive", "build.filterExclusive"],
    ["ur4", "build.filterUr4"],
    ["ur3", "build.filterUr3"],
    ["monster", "build.filterMonster"],
  ]) {
    calculator.append(buildSettingRow(label, buildCheckbox(settings.calculator.gear_filters[key], `build-filter-${key}`, value => { settings.calculator.gear_filters[key] = value; })));
  }
  group("build.calculator", calculator);
  root.append(details);
};

const openAdvancedEditor = (sideKey, index) => {
  document.querySelector(".advanced-popover")?.remove();
  const unit = draft[sideKey][index];
  const popover = document.createElement("section");
  popover.className = "advanced-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", t("loadout.title"));
  const top = document.createElement("div");
  top.className = "advanced-top";
  const select = document.createElement("select");
  const partyNo = Number(unit.party_no || 1);
  const duplicateIds = new Set(
    draft[sideKey]
      .filter((candidate, candidateIndex) => candidateIndex !== index && Number(candidate.party_no || 1) === partyNo)
      .map(candidate => candidate.character_id),
  );
  catalog.characters.forEach(item => {
    const characterOption = option(
      item.id,
      `${item.name} · ${t(`element.${item.element}`)} / ${t(`attack.${item.attack_type}`)}`,
      item.id === unit.character_id,
    );
    characterOption.disabled = duplicateIds.has(item.id);
    select.append(characterOption);
  });
  const close = document.createElement("button");
  close.className = "secondary-button";
  close.textContent = t("loadout.done");
  close.onclick = () => popover.remove();
  top.append(select, close);
  popover.append(top);
  const costumes = document.createElement("div");
  costumes.className = "advanced-costumes";
  renderCostumeEditor(costumes, unit);
  popover.append(costumes);
  renderBuildSettingsEditor(popover, unit);
  renderEquipmentEditor(popover, unit, () => {
    popover.remove();
    openAdvancedEditor(sideKey, index);
  });
  select.onchange = () => {
    unit.character_id = select.value;
    unit.costumes = defaultCostumes(characterById(select.value));
    unit.costume_link_target = null;
    for (const [slot, loadout] of Object.entries(unit.equipment || {})) {
      const equipment = equipmentById(loadout.equipment_id);
      if (equipment?.kind === "EXCLUSIVE" && equipment.owner_character_id !== unit.character_id) {
        delete unit.equipment[slot];
      }
    }
    popover.remove();
    renderFormation();
    openAdvancedEditor(sideKey, index);
  };
  // Keep the editor in the native modal's top layer so it is never hidden by
  // the formation dialog backdrop.
  $("#formation-dialog").append(popover);
  select.focus();
};

const cleanUnit = unit => {
  return {
    character_id: unit.character_id,
    row: Number(unit.row),
    depth: Number(unit.depth),
    party_no: Number(unit.party_no || 1),
    costumes: unit.costumes.filter(item => item.enabled !== false).map(item => ({
      costume_id: item.costume_id,
      enhancement: Number(item.enhancement),
      burst_level: Number(item.burst_level),
      potential_mask: Number(item.potential_mask),
      permanent_potential_enabled: Boolean(item.permanent_potential_enabled),
    })),
    costume_link_target: unit.costume_link_target || null,
    equipment: clone(unit.equipment || {}),
    build_settings: clone(unit.build_settings || defaultBuildSettings()),
  };
};

const startRequest = () => ({
  mode: draft.mode,
  player_units: draft.player_units.map(cleanUnit),
  enemy_units: draft.enemy_units.map(cleanUnit),
  monster_level: Number($("#monster-level").value),
  seed: Number($("#setup-seed").value),
  mcts_simulations: Number($("#mcts-simulations").value),
});

const validateSetupControls = () => {
  const controls = [$("#setup-seed"), $("#monster-level"), $("#mcts-simulations")];
  const invalid = controls.find(control => !control.checkValidity());
  if (!invalid) return;
  invalid.focus();
  throw new Error(t("error.invalidSetupNumber"));
};

const currentPlayerTeam = () => snapshot.state.teams.find(team => team.side === "PLAYER");
const activeParty = () => snapshot.state.monster_chaser?.current_party || 1;
const visiblePlayerUnits = () => Object.values(snapshot.state.units).filter(unit => unit.side === "PLAYER" && Number(unit.party_no || 1) === Number(activeParty()));
const enemyUnits = () => Object.values(snapshot.state.units).filter(unit => unit.side === "ENEMY");
const legalFor = unitId => snapshot.legal.find(entry => Number(entry.unit_id) === Number(unitId));
const selectedCommandIndex = unitId => plannedCommands.get(Number(unitId)) ?? 0;
const selectedCommand = unitId => legalFor(unitId)?.commands[selectedCommandIndex(unitId)];
const capabilities = () => modeCapabilities(snapshot.state.rules.mode, snapshot.state.rules.allow_formation_change);
const effectivePosition = unit => plannedFormation[String(unit.id)] || unit.position;

const commandMeta = (unit, command) => {
  if (!command) return { name: t("action.wait"), sp_cost: 0, cooldown: 0, range: [], operation_summary: t("action.noAction"), glyph: "…" };
  if (command.type === "USE_COSTUME") return { ...costumeById(command.costume_id), ...(command.ui || {}), glyph: "✦" };
  if (command.type === "NORMAL_ATTACK") return { name: t("action.normal"), sp_cost: 0, cooldown: 0, range: [{ row: 0, depth: 0 }], operation_summary: t("action.normalSummary"), glyph: "⚔" };
  if (command.type === "KNOCKBACK") return { name: t("action.knockback"), sp_cost: 0, cooldown: 0, range: [{ row: 0, depth: 0 }], operation_summary: t("action.knockbackSummary"), glyph: "➤" };
  return { name: t("action.wait"), sp_cost: 0, cooldown: 0, range: [], operation_summary: t("action.waitSummary"), glyph: "…" };
};

const plannedCost = () => plannedSpCost(plannedOrder, plannedCommands, legalFor, costumeById);

const moveOrderRelative = (movingId, targetId, after = false) => {
  const moving = Number(movingId);
  const target = Number(targetId);
  if (moving === target || !plannedOrder.includes(moving) || !plannedOrder.includes(target)) return;
  const next = plannedOrder.filter(id => id !== moving);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex + (after ? 1 : 0), 0, moving);
  plannedOrder = next;
  announce(t("order.moved", { name: displayCharacter(snapshot.state.units[String(moving)].character_id), order: plannedOrder.indexOf(moving) + 1 }));
  renderBattleSurface();
};

const renderOrder = () => {
  const root = $("#ally-rail");
  root.innerHTML = "";
  root.ondragover = event => {
    if (orderDragId === null || event.target !== root) return;
    event.preventDefault();
    root.classList.add("drop-at-end");
  };
  root.ondragleave = event => {
    if (!root.contains(event.relatedTarget)) root.classList.remove("drop-at-end");
  };
  root.ondrop = event => {
    if (event.target !== root || orderDragId === null) return;
    event.preventDefault();
    const moving = orderDragId;
    orderDragId = null;
    root.classList.remove("drop-at-end");
    const finalTarget = plannedOrder.findLast(id => id !== moving);
    if (finalTarget !== undefined) moveOrderRelative(moving, finalTarget, true);
  };
  plannedOrder.forEach((unitId, index) => {
    const unit = snapshot.state.units[String(unitId)];
    if (!unit) return;
    const character = entityById(unit.character_id);
    const meta = commandMeta(unit, selectedCommand(unit.id));
    const card = document.createElement("button");
    card.type = "button";
    card.draggable = true;
    card.className = `order-card ${selectedUnitId === unit.id ? "selected" : ""}`;
    card.dataset.unitId = String(unit.id);
    card.dataset.testid = `order-unit-${unit.id}`;
    card.setAttribute("aria-label", t("order.cardAria", { order: index + 1, name: character?.name || unit.character_id, action: meta.name }));
    card.innerHTML = `<span class="order-number">${index + 1}</span>${emblemMarkup(character, "small-emblem")}<span class="order-copy"><b>${escapeHtml(character?.name || unit.character_id)}</b><small>${escapeHtml(meta.name)} · HP ${formatNumber(unit.hp)}</small></span><span class="reserved-mark">${selectedCommandIndex(unit.id) > 0 ? "◆" : ""}</span>`;
    card.addEventListener("click", event => {
      if (suppressOrderClick) {
        event.preventDefault();
        return;
      }
      selectUnit(unit.id);
    });
    card.addEventListener("dragstart", event => {
      orderDragId = unit.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(unit.id));
      card.classList.add("dragging");
    });
    card.addEventListener("dragover", event => {
      if (orderDragId === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const after = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
      card.classList.toggle("drop-before", !after);
      card.classList.toggle("drop-after", after);
      card.dataset.dropAfter = String(after);
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
    card.addEventListener("drop", event => {
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove("drop-before", "drop-after");
      const moving = orderDragId;
      orderDragId = null;
      if (moving !== null) moveOrderRelative(moving, unit.id, card.dataset.dropAfter === "true");
    });
    card.addEventListener("dragend", () => {
      orderDragId = null;
      root.classList.remove("drop-at-end");
      $$(".order-card").forEach(item => item.classList.remove("dragging", "drop-before", "drop-after"));
    });
    card.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" || event.button !== 0) return;
      orderPointerDrag = {
        unitId: unit.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
      card.setPointerCapture?.(event.pointerId);
    });
    card.addEventListener("pointermove", event => {
      if (!orderPointerDrag || orderPointerDrag.pointerId !== event.pointerId) return;
      if (!orderPointerDrag.active && Math.hypot(event.clientX - orderPointerDrag.startX, event.clientY - orderPointerDrag.startY) > 7) {
        orderPointerDrag.active = true;
        card.classList.add("dragging");
      }
      if (!orderPointerDrag.active) return;
      $$(".order-card").forEach(item => item.classList.remove("drop-before", "drop-after"));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".order-card");
      if (!target || target === card) return;
      const after = event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
      target.classList.add(after ? "drop-after" : "drop-before");
      target.dataset.dropAfter = String(after);
    });
    card.addEventListener("pointerup", event => {
      if (!orderPointerDrag || orderPointerDrag.pointerId !== event.pointerId) return;
      const drag = orderPointerDrag;
      const target = drag.active ? document.elementFromPoint(event.clientX, event.clientY)?.closest(".order-card") : null;
      orderPointerDrag = null;
      card.classList.remove("dragging");
      if (drag.active) {
        suppressOrderClick = true;
        window.setTimeout(() => { suppressOrderClick = false; }, 0);
      }
      if (target && target !== card) {
        moveOrderRelative(drag.unitId, Number(target.dataset.unitId), target.dataset.dropAfter === "true");
      }
      $$(".order-card").forEach(item => item.classList.remove("drop-before", "drop-after"));
    });
    card.addEventListener("pointercancel", () => {
      orderPointerDrag = null;
      card.classList.remove("dragging");
      $$(".order-card").forEach(item => item.classList.remove("drop-before", "drop-after"));
    });
    card.addEventListener("keydown", event => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const next = reorder(plannedOrder, unit.id, event.key === "ArrowUp" ? -1 : 1);
      if (next.some((value, slot) => value !== plannedOrder[slot])) {
        plannedOrder = next;
        renderBattleSurface();
        $(`[data-testid="order-unit-${unit.id}"]`)?.focus();
      }
    });
    root.append(card);
  });
};

const renderEnemyList = () => {
  const root = $("#enemy-rail");
  root.innerHTML = "";
  enemyUnits().filter(unit => !snapshot.state.monster_chaser || unit.can_act).forEach(unit => {
    const character = entityById(unit.character_id);
    const hp = Math.max(0, 100 * Number(unit.hp) / Math.max(1, Number(unit.base_stats.max_hp)));
    const card = document.createElement("button");
    card.type = "button";
    card.className = "enemy-card";
    card.dataset.unitId = String(unit.id);
    card.dataset.testid = `enemy-unit-${unit.id}`;
    card.innerHTML = `${emblemMarkup(character)}<span><b>${escapeHtml(character?.name || unit.character_id)}</b><small>HP ${formatNumber(unit.hp)} · ${unit.position.row + 1}-${unit.position.depth + 1}</small><span class="hp-track"><i style="width:${hp}%"></i></span></span>`;
    card.addEventListener("click", () => inspectUnit(unit));
    root.append(card);
  });
};

const renderFiendHp = (monster, remaining = monster?.battle_hp_remaining) => {
  if (!monster) return;
  const totalHp = monster.level_hp_segments.reduce((sum, value) => sum + Number(value), 0);
  const remainingHp = Math.max(0, Number(remaining));
  const percent = Math.max(0, 100 * remainingHp / Math.max(1, totalHp));
  $("#fiend-percent").textContent = `${percent.toFixed(1)}%`;
  $("#fiend-hp-bar").style.width = `${percent}%`;
  $("#fiend-hp-text").textContent = `${formatNumber(remainingHp)} / ${formatNumber(totalHp)}`;
};

const renderFiendHud = () => {
  const monster = snapshot.state.monster_chaser;
  $("#fiend-zone").classList.toggle("hidden", !monster);
  $("#enemy-rail").classList.toggle("hidden", Boolean(monster));
  if (!monster) return;
  $("#fiend-level").textContent = t("fiend.level", { current: monster.current_level, selected: monster.selected_level });
  renderFiendHp(monster);
  const root = $("#forecast-list");
  root.innerHTML = "";
  catalog.monster_skills.forEach((skill, index) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${index + 1}</span><div><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.condition || t("fiend.sequence"))} · ${escapeHtml(skill.operation_summary)}</small></div>`;
    root.append(item);
  });
};

const clearBattleDrop = () => $$("#player-field .field-cell").forEach(cell => cell.classList.remove("drop-valid", "drop-swap"));

const markBattleDrop = (cell, unitId) => {
  clearBattleDrop();
  const occupied = occupantAt(plannedFormation, cell.dataset.row, cell.dataset.depth, unitId);
  cell.classList.add(occupied ? "drop-swap" : "drop-valid");
};

const performBattleMove = (unitId, row, depth) => {
  if (animationRunning) return false;
  if (!capabilities().formation || snapshot.state.active_side !== "PLAYER" || snapshot.state.terminal) {
    showError(t("error.formationLocked"));
    return false;
  }
  const unit = snapshot.state.units[String(unitId)];
  if (!unit?.alive || Number(unit.party_no || 1) !== Number(activeParty())) {
    showError(t("error.unitNotMovable"));
    return false;
  }
  try {
    const result = moveFormation(plannedFormation, unitId, Number(row), Number(depth));
    plannedFormation = result.formation;
    selectedUnitId = Number(unitId);
    keyboardDrag = null;
    const name = displayCharacter(unit.character_id);
    if (result.swappedUnitId) {
      const other = snapshot.state.units[String(result.swappedUnitId)];
      setTip(t("formation.swapPending", { name, other: displayCharacter(other.character_id) }));
      announce(t("formation.swap", { name, other: displayCharacter(other.character_id) }));
    } else if (result.moved) {
      setTip(t("formation.movePending", { name, row: Number(row) + 1, depth: Number(depth) + 1 }));
      announce(t("formation.move", { name, row: Number(row) + 1, depth: Number(depth) + 1 }));
    }
    renderBattleSurface({ preserveTip: true });
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
};

const refreshKeyboardTarget = () => {
  $$("#player-field .field-cell").forEach(cell => cell.classList.remove("keyboard-target"));
  if (!keyboardDrag) return;
  const cell = $(`#player-field .field-cell[data-row="${keyboardDrag.row}"][data-depth="${keyboardDrag.depth}"]`);
  if (cell) {
    cell.classList.add("keyboard-target");
    cell.focus();
  }
};

const beginKeyboardMove = unitId => {
  if (!capabilities().formation) {
    showError(t("error.runtimeFormationLocked"));
    return;
  }
  const unit = snapshot.state.units[String(unitId)];
  const position = effectivePosition(unit);
  keyboardDrag = { unitId: Number(unitId), row: Number(position.row), depth: Number(position.depth) };
  announce(t("formation.pickup", { name: displayCharacter(unit.character_id) }));
  refreshKeyboardTarget();
};

const handleCellKeyboard = event => {
  if (!keyboardDrag) return;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    const target = keyboardTarget(keyboardDrag, event.key);
    keyboardDrag.row = target.row;
    keyboardDrag.depth = target.depth;
    refreshKeyboardTarget();
    announce(t("formation.keyboardTarget", { row: target.row + 1, depth: target.depth + 1 }));
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const target = { ...keyboardDrag };
    performBattleMove(target.unitId, target.row, target.depth);
  } else if (event.key === "Escape") {
    event.preventDefault();
    keyboardDrag = null;
    refreshKeyboardTarget();
    announce(t("formation.cancelled"));
  }
};

const wireBattleTokenDrag = (token, unit) => {
  const enabled = capabilities().formation && snapshot.state.active_side === "PLAYER" && unit.alive;
  token.draggable = enabled;
  token.setAttribute("aria-grabbed", "false");
  token.addEventListener("dragstart", event => {
    if (!enabled) {
      event.preventDefault();
      showError(t("error.formationLocked"));
      return;
    }
    battleDragId = unit.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(unit.id));
    token.setAttribute("aria-grabbed", "true");
  });
  token.addEventListener("dragend", () => {
    battleDragId = null;
    token.setAttribute("aria-grabbed", "false");
    clearBattleDrop();
  });
  token.addEventListener("keydown", event => {
    if (event.key === " ") {
      event.preventDefault();
      beginKeyboardMove(unit.id);
    }
  });
  token.addEventListener("pointerdown", event => {
    if (!enabled || event.button !== 0) return;
    pointerDrag = { unitId: unit.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, token };
    token.setPointerCapture?.(event.pointerId);
  });
  token.addEventListener("pointermove", event => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
    if (!pointerDrag.active && distance > 7) {
      pointerDrag.active = true;
      token.classList.add("pointer-dragging");
      token.setAttribute("aria-grabbed", "true");
    }
    if (!pointerDrag.active) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest("#player-field .field-cell");
    if (cell) markBattleDrop(cell, unit.id);
  });
  token.addEventListener("pointerup", event => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    const active = pointerDrag.active;
    const cell = active ? document.elementFromPoint(event.clientX, event.clientY)?.closest("#player-field .field-cell") : null;
    token.classList.remove("pointer-dragging");
    token.setAttribute("aria-grabbed", "false");
    pointerDrag = null;
    clearBattleDrop();
    if (cell) {
      event.preventDefault();
      performBattleMove(unit.id, cell.dataset.row, cell.dataset.depth);
    }
  });
  token.addEventListener("pointercancel", () => {
    token.classList.remove("pointer-dragging");
    token.setAttribute("aria-grabbed", "false");
    pointerDrag = null;
    clearBattleDrop();
  });
};

const renderField = (selector, side) => {
  const root = $(selector);
  root.innerHTML = "";
  const units = (side === "PLAYER" ? visiblePlayerUnits() : enemyUnits()).filter(unit => unit.alive);
  const depths = side === "PLAYER" ? [3, 2, 1, 0] : [0, 1, 2, 3];
  for (let row = 0; row < 3; row += 1) {
    for (const depth of depths) {
      const cell = document.createElement("div");
      cell.tabIndex = 0;
      cell.className = `field-cell ${side === "PLAYER" && !capabilities().formation ? "locked" : ""}`;
      cell.dataset.row = String(row);
      cell.dataset.depth = String(depth);
      cell.dataset.coordinate = `${row + 1}-${depth + 1}`;
      cell.dataset.testid = `${side.toLowerCase()}-cell-${row}-${depth}`;
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", t("formation.cellAria", { side: t(`battle.side.${side}`), row: row + 1, depth: depth + 1 }));
      if (side === "PLAYER") {
        cell.addEventListener("dragover", event => {
          if (battleDragId === null || !capabilities().formation) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          markBattleDrop(cell, battleDragId);
        });
        cell.addEventListener("dragleave", event => { if (!cell.contains(event.relatedTarget)) clearBattleDrop(); });
        cell.addEventListener("drop", event => {
          event.preventDefault();
          const moving = battleDragId ?? Number(event.dataTransfer.getData("text/plain"));
          battleDragId = null;
          clearBattleDrop();
          if (Number.isFinite(Number(moving))) performBattleMove(Number(moving), row, depth);
        });
      }
      const unit = units.find(candidate => {
        const position = side === "PLAYER" ? effectivePosition(candidate) : candidate.position;
        return Number(position.row) === row && Number(position.depth) === depth;
      });
      if (unit) {
        const character = entityById(unit.character_id);
        const hp = Math.max(0, 100 * Number(unit.hp) / Math.max(1, Number(unit.base_stats.max_hp)));
        const token = document.createElement("button");
        token.type = "button";
        token.className = `battle-token ${side === "ENEMY" ? "enemy-token" : ""} ${selectedUnitId === unit.id ? "selected" : ""} ${unit.alive ? "" : "dead"}`;
        token.dataset.unitId = String(unit.id);
        token.dataset.testid = `${side.toLowerCase()}-token-${unit.id}`;
        token.setAttribute("aria-label", t(side === "PLAYER" ? "formation.playerTokenAria" : "formation.enemyTokenAria", { name: character?.name || unit.character_id, hp: unit.hp }));
        token.innerHTML = `${emblemMarkup(character)}<span class="token-copy"><b>${escapeHtml(character?.name || unit.character_id)}</b><small>HP ${formatNumber(unit.hp)}</small></span><span class="mini-hp"><i style="width:${hp}%"></i></span>`;
        token.addEventListener("click", event => {
          event.stopPropagation();
          if (pointerDrag?.active) return;
          if (side === "PLAYER") selectUnit(unit.id);
          else inspectUnit(unit);
        });
        if (side === "PLAYER") wireBattleTokenDrag(token, unit);
        cell.append(token);
      }
      root.append(cell);
    }
  }
};

const selectUnit = unitId => {
  if (animationRunning) return;
  if (!legalFor(unitId)) return;
  selectedUnitId = Number(unitId);
  renderBattleSurface();
};

const selectCommandForUnit = (unitId, index) => {
  if (animationRunning) return;
  const result = selectCommand({
    order: plannedOrder,
    selections: plannedCommands,
    legalById: legalFor,
    costumeLookup: costumeById,
    sp: currentPlayerTeam().sp,
  }, unitId, Number(index));
  if (!result.accepted) {
    showError(result.reason === "INSUFFICIENT_SP" ? t("error.insufficientSp") : t("error.maskedAction"));
    return;
  }
  plannedCommands = result.selections;
  renderBattleSurface();
};

const renderActionDock = () => {
  const root = $("#costume-strip");
  const entry = legalFor(selectedUnitId);
  root.innerHTML = "";
  if (!entry) {
    $("#reservation-unit-name").textContent = t("selection.none");
    $("#reservation-sp").textContent = "—";
    $("#selected-name").textContent = t("selection.none");
    $("#selected-skill-name").textContent = t("selection.hint");
    $("#selected-skill-summary").textContent = "";
    renderRange([]);
    return;
  }
  const unit = snapshot.state.units[String(selectedUnitId)];
  const character = entityById(unit.character_id);
  $("#reservation-unit-name").textContent = character?.name || unit.character_id;
  $("#reservation-sp").textContent = String(Number(currentPlayerTeam().sp) - plannedCost());
  const options = [
    ...entry.commands.map((command, index) => ({ command, index, available: true })),
    ...(entry.unavailable_commands || []).map(command => ({ command, index: null, available: false })),
  ];
  options.forEach(({ command, index, available }) => {
    const meta = commandMeta(unit, command);
    const costume = command.type === "USE_COSTUME" ? costumeById(command.costume_id) : null;
    const cooldown = costume ? Number(command.cooldown_remaining ?? unit.cooldowns?.[costume.id] ?? 0) : 0;
    const card = document.createElement("button");
    card.type = "button";
    const isSelected = available && selectedCommandIndex(unit.id) === index;
    const currentCommand = selectedCommand(unit.id);
    const prospectiveCost = available ? plannedCost()
      - commandCost(currentCommand, costumeById)
      + commandCost(command, costumeById) : Number.POSITIVE_INFINITY;
    const isUnaffordable = command.unavailable_reason === "INSUFFICIENT_SP"
      || (available && !isSelected && prospectiveCost > Number(currentPlayerTeam().sp));
    const isOnCooldown = command.unavailable_reason === "COOLDOWN";
    const miniCells = rangePreviewCells(meta.range || []);
    const miniMarkup = Array.from({ length: 12 }, (_, cellIndex) => {
      const row = Math.floor(cellIndex / 4);
      const depth = cellIndex % 4;
      return `<i class="${miniCells.has(cellKey(row, depth)) ? "hit" : ""}"></i>`;
    }).join("");
    card.className = `command-card ${index === 0 ? "default-command" : ""} ${isSelected ? "selected" : ""} ${isUnaffordable ? "unaffordable" : ""} ${!available ? "unavailable" : ""}`;
    if (available) card.dataset.commandIndex = String(index);
    card.dataset.commandType = command.type;
    if (command.costume_id) card.dataset.costumeId = command.costume_id;
    card.dataset.testid = available ? `command-${unit.id}-${index}` : `command-${unit.id}-unavailable-${command.costume_id}`;
    card.disabled = !available;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(isSelected));
    card.setAttribute("aria-label", t("action.cardAria", {
      name: meta.name,
      sp: meta.sp_cost || 0,
      cooldown: cooldown ? t("action.cooldownSuffix", { cooldown }) : "",
      state: isSelected
        ? t("action.reservedSuffix")
        : isOnCooldown
        ? t("action.cooldownUnavailableSuffix")
        : isUnaffordable
        ? t("action.unaffordableSuffix")
        : !available
        ? t("action.unavailableSuffix")
        : "",
    }));
    const selector = meta.selector ? t(`selector.${meta.selector}`) : t("action.primaryTarget");
    const stateLabel = isSelected
      ? t("action.reserved")
      : isOnCooldown
      ? t("action.cooldownState", { cooldown })
      : isUnaffordable
      ? t("action.unaffordable")
      : !available
      ? t("action.unavailable")
      : "";
    card.innerHTML = `<span class="command-glyph">${meta.glyph}</span><span class="command-name"><b>${escapeHtml(meta.name)}</b><small>${escapeHtml(selector)} · ${escapeHtml(meta.operation_summary || "")}</small></span><span class="command-cost"><b>SP ${meta.sp_cost || 0}</b>${cooldown ? `<small>CT ${cooldown}</small>` : ""}</span><span class="command-range" aria-hidden="true">${miniMarkup}</span><span class="command-state">${escapeHtml(stateLabel)}</span>`;
    if (available) card.addEventListener("click", () => selectCommandForUnit(unit.id, index));
    root.append(card);
  });
  renderSelectedSkill(unit, selectedCommand(unit.id));
};

const renderSelectedSkill = (unit, command) => {
  const character = entityById(unit.character_id);
  const meta = commandMeta(unit, command);
  const costume = command?.type === "USE_COSTUME" ? costumeById(command.costume_id) : null;
  const loadout = command?.type === "USE_COSTUME" ? unit.costume_loadout.find(item => item.costume_id === command.costume_id) : null;
  $("#selected-emblem").textContent = initials(character);
  $("#selected-emblem").className = `unit-emblem ${elementClass(character?.element)}`;
  $("#selected-name").textContent = character?.name || unit.character_id;
  $("#selected-skill-name").textContent = meta.name;
  $("#selected-upgrade").textContent = loadout ? `+${loadout.enhancement}${loadout.burst_level ? ` · B${loadout.burst_level}` : ""}` : "";
  $("#selected-sp").textContent = meta.sp_cost || 0;
  $("#selected-cooldown").textContent = costume ? unit.cooldowns?.[costume.id] || 0 : 0;
  $("#selected-skill-summary").textContent = `${meta.selector ? `${t(`selector.${meta.selector}`)} · ` : ""}${meta.operation_summary}`;
  $("#reserved-badge").textContent = t("order.badge", { order: plannedOrder.indexOf(unit.id) + 1 });
  $("#selected-element").textContent = t(`element.${String(character?.element || "NONE")}`);
  requestRangePreview(unit, command, meta);
};

const renderRange = (range, preview = null, meta = {}) => {
  const root = $("#range-preview");
  root.innerHTML = "";
  const hits = rangePreviewCells(range);
  for (let row = 0; row < 3; row += 1) {
    for (let depth = 0; depth < 4; depth += 1) {
      const cell = document.createElement("i");
      if (hits.has(cellKey(row, depth))) cell.classList.add("hit");
      root.append(cell);
    }
  }
  $$(".battle-grid .field-cell").forEach(cell => cell.classList.remove("target-preview", "target-anchor", "target-occupied"));
  if (!preview?.anchor) return;
  const projected = Array.isArray(preview.affected_cells)
    ? new Set(preview.affected_cells.map(cell => cellKey(cell.row, cell.depth)))
    : projectRangeCells(range, preview.anchor, { targetAll: Boolean(meta.target_all) });
  const boardSelector = preview.target_side === "PLAYER" ? "#player-field" : "#enemy-field";
  $$(`${boardSelector} .field-cell`).forEach(cell => {
    const key = cellKey(cell.dataset.row, cell.dataset.depth);
    cell.classList.toggle("target-preview", projected.has(key));
    cell.classList.toggle("target-anchor", key === cellKey(preview.anchor.row, preview.anchor.depth));
    const occupant = cell.querySelector(".battle-token")?.dataset.unitId;
    cell.classList.toggle("target-occupied", preview.affected_unit_ids?.includes(Number(occupant)) || false);
  });
};

const cancelRangePreview = () => {
  previewGeneration += 1;
  window.clearTimeout(previewTimer);
  previewTimer = null;
  previewController?.abort();
  previewController = null;
};

const requestRangePreview = (unit, command, meta) => {
  const generation = ++previewGeneration;
  window.clearTimeout(previewTimer);
  previewController?.abort();
  previewController = null;
  renderRange(meta.range || []);
  if (!command || command.type === "WAIT" || animationRunning) return;
  previewTimer = window.setTimeout(async () => {
    if (generation !== previewGeneration || selectedUnitId !== unit.id) return;
    const controller = new AbortController();
    previewController = controller;
    try {
      const formation = capabilities().formation
        ? serializeFormation(plannedFormation, visiblePlayerUnits().map(item => item.id))
        : {};
      const preview = await silentApi("/api/preview", {
        unit_id: unit.id,
        action_index: selectedCommandIndex(unit.id),
        order: plannedOrder,
        formation,
        actions: actionIndices(plannedOrder, plannedCommands),
      }, controller.signal);
      if (generation !== previewGeneration || selectedUnitId !== unit.id) return;
      renderRange(meta.range || [], preview, meta);
    } catch (error) {
      if (error?.name !== "AbortError" && generation === previewGeneration) renderRange(meta.range || []);
    } finally {
      if (previewController === controller) previewController = null;
    }
  }, 120);
};

const renderSp = () => {
  const current = Number(currentPlayerTeam().sp);
  const remaining = current - plannedCost();
  renderSpGauge(remaining, current);
  $("#execute").disabled = Boolean(snapshot.state.terminal) || snapshot.state.active_side !== "PLAYER" || remaining < 0 || plannedOrder.length === 0 || requestInFlight || animationRunning;
};

const renderSpGauge = (displayed, current = displayed) => {
  const cap = Number(snapshot.state.rules.sp_cap ?? Math.max(20, current));
  $("#sp-text").textContent = `${displayed} / ${cap}`;
  $("#reservation-sp").textContent = String(displayed);
  const root = $("#sp-pips");
  root.innerHTML = "";
  for (let index = 0; index < cap; index += 1) {
    const pip = document.createElement("i");
    if (index < displayed) pip.classList.add("filled");
    else if (index < current) pip.classList.add("spent");
    root.append(pip);
  }
};

const modifierLabels = {
  max_hp_flat: ["effect.maxHp", "flat"], max_hp_bp: ["effect.maxHp", "percent"],
  attack_flat: ["effect.attack", "flat"], attack_bp: ["effect.attack", "percent"],
  magic_flat: ["effect.magic", "flat"], magic_bp: ["effect.magic", "percent"],
  defense_bp: ["effect.defense", "percent"], magic_resist_bp: ["effect.magicResist", "percent"],
  crit_rate_bp: ["effect.critRate", "percent"], crit_damage_bp: ["effect.critDamage", "percent"],
  property_damage_bp: ["effect.propertyDamage", "percent"], outgoing_damage_bp: ["effect.outgoingDamage", "percent"],
  incoming_damage_bp: ["effect.incomingDamage", "percent"], amplification_bp: ["effect.amplification", "percent"],
  damage_reduction_bp: ["effect.damageReduction", "percent"], physical_damage_reduction_bp: ["effect.physicalReduction", "percent"],
  magical_damage_reduction_bp: ["effect.magicalReduction", "percent"], evasion_bp: ["effect.evasion", "percent"],
  sp_cost_delta: ["effect.spCost", "flat"], cooldown_delta: ["effect.cooldown", "flat"],
  chain_received_delta: ["effect.chainReceived", "flat"], chain_dealt_delta: ["effect.chainDealt", "flat"],
};

const signedValue = (value, kind) => {
  const numeric = Number(value);
  const rendered = kind === "percent"
    ? `${(Math.abs(numeric) / 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`
    : formatNumber(Math.abs(numeric));
  return `${numeric > 0 ? "+" : "−"}${rendered}`;
};

const effectLabel = effect => {
  const spec = effect?.spec || {};
  const details = [];
  Object.entries(spec.modifiers || {}).forEach(([key, value]) => {
    if (!Number(value) || !modifierLabels[key]) return;
    const [label, kind] = modifierLabels[key];
    details.push(`${t(label)} ${signedValue(value, kind)}`);
  });
  if (spec.barrier) details.push(t("effect.barrier"));
  if (spec.periodic) details.push(t("effect.periodic"));
  if (spec.counter) details.push(t("effect.counter"));
  if (spec.revive_hp_bp != null) details.push(t("effect.revive"));
  const polarity = t(`effect.polarity.${spec.polarity || "NEUTRAL"}`);
  const summary = details.length ? details.join(" / ") : t("effect.state");
  return t("effect.active", { polarity, summary, remaining: Number(effect?.remaining ?? 0) });
};

const humanEvent = event => {
  const kind = event.kind || {};
  const sequence = String(event.sequence).padStart(4, "0");
  const unit = id => unitName(id);
  const cell = value => t("event.cell", { row: Number(value?.row) + 1, depth: Number(value?.depth) + 1 });
  let detail;
  switch (kind.type) {
    case "BATTLE_STARTED": detail = t("event.battleStarted", { side: t(`battle.side.${kind.first_side}`) }); break;
    case "TURN_STARTED": detail = t("event.turnStarted", { turn: kind.turn, side: t(`battle.side.${kind.side}`), sp: kind.sp }); break;
    case "FORMATION_CHANGED": detail = t("event.formationChanged", { unit: unit(kind.unit_id), from: cell(kind.from), to: cell(kind.to) }); break;
    case "ACTION_STARTED": detail = t("event.actionStarted", { unit: unit(kind.actor_id), action: commandName(kind.command) }); break;
    case "TARGET_LOCKED": detail = t("event.targetLocked", { actor: unit(kind.actor_id), target: unit(kind.target_id) }); break;
    case "TARGET_CELL_LOCKED": detail = t("event.targetCellLocked", { actor: unit(kind.actor_id), cell: cell(kind.cell) }); break;
    case "RNG_ROLLED": detail = t("event.rng", { result: t(kind.success ? "event.success" : "event.failure") }); break;
    case "DAMAGE_APPLIED": detail = t("event.damage", { actor: unit(kind.actor_id), target: unit(kind.target_id), amount: formatNumber(kind.amount), critical: kind.critical ? t("event.criticalSuffix") : "" }); break;
    case "DAMAGE_EVADED": detail = t("event.damageEvaded", { target: unit(kind.target_id) }); break;
    case "BARRIER_ABSORBED": detail = t("event.barrier", { target: unit(kind.target_id), amount: formatNumber(kind.amount) }); break;
    case "HEAL_APPLIED": detail = t("event.heal", { actor: unit(kind.actor_id), target: unit(kind.target_id), amount: formatNumber(kind.amount) }); break;
    case "EFFECT_APPLIED": detail = t("event.effectApplied", { target: unit(kind.target_id) }); break;
    case "EFFECT_EXPIRED": detail = t("event.effectExpired", { target: unit(kind.target_id) }); break;
    case "SP_CHANGED": detail = t("event.spChanged", { side: t(`battle.side.${kind.side}`), before: kind.before, after: kind.after }); break;
    case "COOLDOWN_CHANGED": detail = t("event.cooldownChanged", { unit: unit(kind.unit_id), costume: costumeById(kind.costume_id)?.name || t("action.costume"), before: kind.before, after: kind.after }); break;
    case "CHAIN_CHANGED": detail = t("event.chainChanged", { target: unit(kind.target_id), before: kind.before, after: kind.after }); break;
    case "UNIT_MOVED": detail = t("event.unitMoved", { unit: unit(kind.unit_id), from: cell(kind.from), to: cell(kind.to) }); break;
    case "COLLISION_DAMAGE": detail = t("event.collision", { moving: unit(kind.moving_id), occupant: unit(kind.occupant_id), amount: formatNumber(kind.amount) }); break;
    case "ACTION_SKIPPED": detail = t("event.actionSkipped", { unit: unit(kind.actor_id) }); break;
    case "UNIT_DIED": detail = t("event.unitDied", { unit: unit(kind.unit_id) }); break;
    case "UNIT_REVIVED": detail = t("event.unitRevived", { unit: unit(kind.unit_id), hp: formatNumber(kind.hp) }); break;
    case "UNIT_SUMMONED": detail = t("event.unitSummoned", { unit: unit(kind.unit_id), cell: cell(kind.position) }); break;
    case "MONSTER_PARTY_ACTIVATED": detail = t("event.partyActivated", { party: kind.party_no }); break;
    case "MONSTER_LEVEL_ADVANCED": detail = t("event.levelAdvanced", { level: kind.to_level, amount: formatNumber(kind.carry_damage) }); break;
    case "TURN_ENDED": detail = t("event.turnEnded", { turn: kind.turn, side: t(`battle.side.${kind.side}`) }); break;
    case "BATTLE_ENDED": detail = t("event.battleEnded", { outcome: t(`battle.outcome.${kind.result?.outcome}`) }); break;
    default: detail = t("event.unknown");
  }
  return `${sequence}  ${detail}`;
};

const tokenFor = unitId => $(`.battle-token[data-unit-id="${Number(unitId)}"]`);

const unitName = (unitId, data = snapshot) => {
  const unit = data?.state?.units?.[String(unitId)] || snapshot?.state?.units?.[String(unitId)];
  return unit ? displayCharacter(unit.character_id) : `#${unitId}`;
};

const commandName = command => {
  if (!command) return t("action.wait");
  if (command.type === "USE_COSTUME") return costumeById(command.costume_id)?.name || command.costume_id;
  return ({ NORMAL_ATTACK: t("action.normal"), KNOCKBACK: t("action.knockback"), WAIT: t("action.wait") })[command.type] || command.type;
};

const setBattleCue = (title = "", detail = "", turn = "") => {
  const cue = $("#battle-cue");
  cue.classList.toggle("hidden", !title);
  $("#cue-title").textContent = title;
  $("#cue-detail").textContent = detail;
  $("#cue-turn").textContent = turn;
};

const clearPlaybackFocus = () => {
  $$(".battle-token").forEach(token => token.classList.remove("acting", "targeted", "hit-flash", "heal-flash"));
  $$(".battle-grid .field-cell").forEach(cell => cell.classList.remove("target-preview", "target-anchor", "target-occupied"));
  $("#target-line").classList.add("hidden");
};

const drawTargetLineTo = (actorId, target) => {
  const stage = $(".topdown-stage");
  const actor = tokenFor(actorId);
  const svg = $("#target-line");
  if (!stage || !actor || !target) {
    svg.classList.add("hidden");
    return;
  }
  const stageRect = stage.getBoundingClientRect();
  const actorRect = actor.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const line = svg.querySelector("line");
  line.setAttribute("x1", actorRect.left + actorRect.width / 2 - stageRect.left);
  line.setAttribute("y1", actorRect.top + actorRect.height / 2 - stageRect.top);
  line.setAttribute("x2", targetRect.left + targetRect.width / 2 - stageRect.left);
  line.setAttribute("y2", targetRect.top + targetRect.height / 2 - stageRect.top);
  svg.classList.remove("hidden");
};

const drawTargetLine = (actorId, targetId) => drawTargetLineTo(actorId, tokenFor(targetId));

const floatingText = (unitId, text, className = "") => {
  const token = tokenFor(unitId);
  const stage = $(".topdown-stage");
  if (!token || !stage) return;
  const stageRect = stage.getBoundingClientRect();
  const tokenRect = token.getBoundingClientRect();
  const node = document.createElement("span");
  node.className = `floating-number ${className}`;
  node.textContent = text;
  node.style.left = `${tokenRect.left + tokenRect.width / 2 - stageRect.left}px`;
  node.style.top = `${tokenRect.top + tokenRect.height / 2 - stageRect.top}px`;
  $("#floating-layer").append(node);
  window.setTimeout(() => node.remove(), playbackDelay(850, speedValue));
};

const updateTokenHp = (unitId, hp, data = snapshot) => {
  const token = tokenFor(unitId);
  const unit = data?.state?.units?.[String(unitId)] || snapshot?.state?.units?.[String(unitId)];
  if (!token || !unit) return;
  const maximum = Math.max(1, Number(unit.base_stats.max_hp));
  const normalizedHp = Math.max(0, Number(hp));
  const percent = Math.max(0, Math.min(100, 100 * normalizedHp / maximum));
  token.querySelector(".token-copy small").textContent = `HP ${formatNumber(normalizedHp)}`;
  token.querySelector(".mini-hp i").style.width = `${percent}%`;
  const order = $(`.order-card[data-unit-id="${unitId}"] .order-copy small`);
  if (order) order.textContent = `${order.textContent.split(" · HP ")[0]} · HP ${formatNumber(normalizedHp)}`;
  const enemy = $(`.enemy-card[data-unit-id="${unitId}"]`);
  if (enemy) {
    const position = token.parentElement;
    enemy.querySelector("small").textContent = `HP ${formatNumber(normalizedHp)} · ${Number(position?.dataset.row ?? unit.position.row) + 1}-${Number(position?.dataset.depth ?? unit.position.depth) + 1}`;
    enemy.querySelector(".hp-track i").style.width = `${percent}%`;
  }
};

const insertPlaybackToken = (unitId, data, { fullHp = true, position = null } = {}) => {
  const unit = data?.state?.units?.[String(unitId)];
  if (!unit) return null;
  const board = unit.side === "ENEMY" ? "#enemy-field" : "#player-field";
  const initialPosition = position || snapshot?.state?.units?.[String(unitId)]?.position || unit.position;
  const destination = $(`${board} .field-cell[data-row="${initialPosition.row}"][data-depth="${initialPosition.depth}"]`);
  if (!destination) return null;
  const existing = tokenFor(unitId);
  if (existing) {
    destination.append(existing);
    return existing;
  }
  const character = entityById(unit.character_id);
  const hp = fullHp ? Number(unit.base_stats.max_hp) : Number(unit.hp);
  const token = document.createElement("button");
  token.type = "button";
  token.disabled = true;
  token.className = `battle-token playback-created ${unit.side === "ENEMY" ? "enemy-token" : ""}`;
  token.dataset.unitId = String(unit.id);
  token.dataset.testid = `${unit.side.toLowerCase()}-token-${unit.id}`;
  token.innerHTML = `${emblemMarkup(character)}<span class="token-copy"><b>${escapeHtml(character?.name || unit.character_id)}</b><small>HP ${formatNumber(hp)}</small></span><span class="mini-hp"><i style="width:100%"></i></span>`;
  destination.append(token);
  return token;
};

const movePlaybackToken = (unitId, cell) => {
  const token = tokenFor(unitId);
  if (!token || !cell) return;
  const board = token.classList.contains("enemy-token") ? "#enemy-field" : "#player-field";
  const destination = $(`${board} .field-cell[data-row="${cell.row}"][data-depth="${cell.depth}"]`);
  if (destination) {
    destination.append(token);
    const enemyLabel = $(`.enemy-card[data-unit-id="${unitId}"] small`);
    if (enemyLabel) enemyLabel.textContent = `${enemyLabel.textContent.split(" · ")[0]} · ${Number(cell.row) + 1}-${Number(cell.depth) + 1}`;
  }
};

const animationSleep = async (baseMilliseconds, generation) => {
  let remaining = Number(baseMilliseconds);
  let previous = performance.now();
  while (remaining > 0) {
    if (generation !== playbackGeneration) return false;
    await new Promise(resolve => window.setTimeout(resolve, 16));
    const now = performance.now();
    if (!animationPaused) remaining -= (now - previous) * speedValue;
    previous = now;
  }
  return generation === playbackGeneration;
};

const playBattleEvent = async (event, result, generation) => {
  const kind = event.kind || {};
  const turnText = playbackTurnText || t("battle.turn", { turn: result.state.game_turn });
  if (kind.type === "TURN_STARTED") {
    clearPlaybackFocus();
    playbackTurnText = t("battle.turn", { turn: kind.turn });
    setBattleCue(kind.side === "PLAYER" ? t("battle.playerTurn") : t("battle.enemyTurn"), "", playbackTurnText);
    return animationSleep(520, generation);
  }
  if (kind.type === "ACTION_STARTED") {
    clearPlaybackFocus();
    tokenFor(kind.actor_id)?.classList.add("acting");
    setBattleCue(unitName(kind.actor_id, result), commandName(kind.command), turnText);
    return animationSleep(kind.command?.type === "WAIT" ? 280 : 680, generation);
  }
  if (kind.type === "TARGET_LOCKED") {
    tokenFor(kind.actor_id)?.classList.add("acting");
    tokenFor(kind.target_id)?.classList.add("targeted");
    drawTargetLine(kind.actor_id, kind.target_id);
    $("#cue-detail").textContent = t("battle.target", { name: unitName(kind.target_id, result) });
    return animationSleep(360, generation);
  }
  if (kind.type === "TARGET_CELL_LOCKED") {
    const actor = result.state.units[String(kind.actor_id)];
    const board = actor?.side === "PLAYER" ? "#enemy-field" : "#player-field";
    const cell = $(`${board} .field-cell[data-row="${kind.cell.row}"][data-depth="${kind.cell.depth}"]`);
    tokenFor(kind.actor_id)?.classList.add("acting");
    cell?.classList.add("target-preview", "target-anchor");
    if (cell) drawTargetLineTo(kind.actor_id, cell);
    $("#cue-detail").textContent = t("battle.targetCell", { row: Number(kind.cell.row) + 1, depth: Number(kind.cell.depth) + 1 });
    return animationSleep(360, generation);
  }
  if (kind.type === "DAMAGE_APPLIED") {
    const target = tokenFor(kind.target_id);
    target?.classList.remove("hit-flash");
    void target?.offsetWidth;
    target?.classList.add("hit-flash", "targeted");
    updateTokenHp(kind.target_id, kind.hp_after, result);
    const targetUnit = result.state.units[String(kind.target_id)];
    if (result.state.monster_chaser && targetUnit?.side === "ENEMY") {
      renderFiendHp(result.state.monster_chaser, kind.hp_after);
    }
    floatingText(kind.target_id, `−${formatNumber(kind.amount)}`, kind.critical ? "critical" : "");
    $("#cue-detail").textContent = t(kind.critical ? "battle.critical" : "battle.damage", { amount: formatNumber(kind.amount) });
    return animationSleep(420, generation);
  }
  if (kind.type === "HEAL_APPLIED") {
    const target = tokenFor(kind.target_id);
    target?.classList.add("heal-flash", "targeted");
    updateTokenHp(kind.target_id, kind.hp_after, result);
    const targetUnit = result.state.units[String(kind.target_id)];
    if (result.state.monster_chaser && targetUnit?.side === "ENEMY") {
      renderFiendHp(result.state.monster_chaser, kind.hp_after);
    }
    floatingText(kind.target_id, `+${formatNumber(kind.amount)}`, "heal");
    $("#cue-detail").textContent = t("battle.heal", { amount: formatNumber(kind.amount) });
    return animationSleep(480, generation);
  }
  if (kind.type === "DAMAGE_EVADED") {
    floatingText(kind.target_id, t("battle.evaded"));
    return animationSleep(380, generation);
  }
  if (kind.type === "EFFECT_APPLIED") {
    floatingText(kind.target_id, t("battle.effectApplied"), "heal");
    return animationSleep(300, generation);
  }
  if (kind.type === "BARRIER_ABSORBED") {
    floatingText(kind.target_id, t("battle.absorbed", { amount: formatNumber(kind.amount) }), "shield");
    $("#cue-detail").textContent = t("battle.absorbedDetail", { amount: formatNumber(kind.amount) });
    return animationSleep(360, generation);
  }
  if (kind.type === "SP_CHANGED") {
    if (kind.side === "PLAYER") renderSpGauge(Number(kind.after));
    return animationSleep(180, generation);
  }
  if (kind.type === "UNIT_MOVED") {
    movePlaybackToken(kind.unit_id, kind.to);
    floatingText(kind.unit_id, t("battle.moved"));
    return animationSleep(420, generation);
  }
  if (kind.type === "COLLISION_DAMAGE") {
    $("#cue-detail").textContent = t("battle.collision", { amount: formatNumber(kind.amount) });
    return animationSleep(380, generation);
  }
  if (kind.type === "CHAIN_CHANGED") {
    if (Number(kind.after) > 0) {
      floatingText(kind.target_id, t("battle.chain", { chain: kind.after }), "chain");
      $("#cue-detail").textContent = t("battle.chainDetail", { chain: kind.after });
    }
    return animationSleep(180, generation);
  }
  if (kind.type === "UNIT_DIED") {
    tokenFor(kind.unit_id)?.classList.add("dead");
    floatingText(kind.unit_id, t("battle.defeated"));
    return animationSleep(520, generation);
  }
  if (kind.type === "UNIT_REVIVED") {
    tokenFor(kind.unit_id)?.classList.remove("dead");
    updateTokenHp(kind.unit_id, kind.hp, result);
    floatingText(kind.unit_id, t("battle.revived"), "heal");
    return animationSleep(520, generation);
  }
  if (kind.type === "UNIT_SUMMONED") {
    const token = insertPlaybackToken(kind.unit_id, result, { position: kind.position });
    token?.classList.add("heal-flash", "targeted");
    floatingText(kind.unit_id, t("battle.summoned"), "heal");
    $("#cue-detail").textContent = t("battle.summonedDetail", { name: unitName(kind.unit_id, result) });
    return animationSleep(560, generation);
  }
  if (kind.type === "MONSTER_PARTY_ACTIVATED") {
    $$("#player-field .battle-token").forEach(token => token.remove());
    kind.unit_ids.forEach(unitId => insertPlaybackToken(unitId, result));
    setBattleCue(t("battle.partyActivated", { party: kind.party_no }), t("battle.partyActivatedDetail"), turnText);
    return animationSleep(700, generation);
  }
  if (kind.type === "MONSTER_LEVEL_ADVANCED") {
    const selected = result.state.monster_chaser?.selected_level || kind.to_level;
    $("#fiend-level").textContent = t("fiend.level", { current: kind.to_level, selected });
    setBattleCue(t("battle.levelAdvanced", { level: kind.to_level }), t("battle.carryDamage", { amount: formatNumber(kind.carry_damage) }), turnText);
    return animationSleep(700, generation);
  }
  if (kind.type === "ACTION_SKIPPED") {
    setBattleCue(unitName(kind.actor_id, result), t("battle.skipped"), turnText);
    return animationSleep(420, generation);
  }
  if (kind.type === "BATTLE_ENDED") {
    clearPlaybackFocus();
    setBattleCue(t("battle.ended"), t(`battle.outcome.${kind.result?.outcome}`), turnText);
    return animationSleep(900, generation);
  }
  if (["TURN_ENDED", "BATTLE_STARTED", "FORMATION_CHANGED", "RNG_ROLLED", "COOLDOWN_CHANGED", "EFFECT_EXPIRED"].includes(kind.type)) {
    return true;
  }
  return animationSleep(180, generation);
};

const playBattleEvents = async (before, result) => {
  const generation = ++playbackGeneration;
  animationRunning = true;
  animationPaused = false;
  playbackTurnText = "";
  cancelRangePreview();
  $$(".battle-grid .field-cell").forEach(cell => cell.classList.remove("target-preview", "target-anchor", "target-occupied"));
  $("#game-shell").classList.add("executing");
  $("#rollback").disabled = !result.can_rollback;
  document.documentElement.style.setProperty("--playback-speed", String(speedValue));
  renderSp();
  const lastSequence = Math.max(-1, ...(before?.state?.event_log || []).map(event => Number(event.sequence)));
  const events = result.state.event_log.filter(event => Number(event.sequence) > lastSequence);
  for (const event of events) {
    if (!await playBattleEvent(event, result, generation)) return false;
  }
  if (generation !== playbackGeneration) return false;
  clearPlaybackFocus();
  setBattleCue();
  $("#floating-layer").innerHTML = "";
  $("#game-shell").classList.remove("executing");
  animationRunning = false;
  animationPaused = false;
  playbackTurnText = "";
  return true;
};

const cancelPlayback = () => {
  playbackGeneration += 1;
  animationRunning = false;
  animationPaused = false;
  playbackTurnText = "";
  clearPlaybackFocus();
  setBattleCue();
  $("#floating-layer").innerHTML = "";
  $("#game-shell").classList.remove("executing");
};

const renderLog = () => {
  const root = $("#events");
  root.innerHTML = "";
  snapshot.state.event_log.slice().reverse().forEach(event => {
    const line = document.createElement("li");
    line.textContent = humanEvent(event);
    root.append(line);
  });
  $("#event-count").textContent = snapshot.state.event_log.length;
};

const inspectUnit = unit => {
  const character = entityById(unit.character_id);
  const stats = unit.base_stats;
  const effectSummary = unit.effects.length ? unit.effects.map(effect => escapeHtml(effectLabel(effect))).join(" / ") : t("inspect.noEffects");
  $("#inspect-content").innerHTML = `<div class="inspect-head">${emblemMarkup(character, `unit-emblem ${elementClass(character?.element)}`)}<div><small>${escapeHtml(t(`battle.side.${unit.side}`))} · #${unit.id}</small><h2>${escapeHtml(character?.name || unit.character_id)}</h2><span>${escapeHtml(t("inspect.position", { row: unit.position.row + 1, depth: unit.position.depth + 1 }))}</span></div></div><div class="inspect-stats"><span>HP <b>${formatNumber(unit.hp)} / ${formatNumber(stats.max_hp)}</b></span><span>${escapeHtml(stats.attack ? t("inspect.attack") : t("inspect.magic"))} <b>${formatNumber(stats.attack || stats.magic)}</b></span><span>${escapeHtml(t("inspect.defense"))} <b>${stats.defense_bp / 100}%</b></span><span>${escapeHtml(t("inspect.magicResist"))} <b>${stats.magic_resist_bp / 100}%</b></span></div><div class="inspect-effects">${t("inspect.effects", { effects: effectSummary })}</div>`;
  openDialog("inspect-dialog");
};

const modeName = mode => t(`mode.${mode}`);

const renderBattleSurface = ({ preserveTip = false } = {}) => {
  const mode = snapshot.state.rules.mode;
  $("#game-shell").classList.remove("normal", "mirror", "monster");
  $("#game-shell").classList.add(mode === "MIRROR_WAR" ? "mirror" : mode === "MONSTER_CHASER" ? "monster" : "normal");
  $("#mode-label").textContent = modeName(mode);
  $("#turn-label").textContent = t("battle.turn", { turn: snapshot.state.game_turn });
  $("#battle-turn").textContent = t("battle.turn", { turn: snapshot.state.game_turn });
  $("#team-label").textContent = t("party.team", { number: activeParty() });
  $("#controller-label").textContent = snapshot.enemy_controller === "RULE_BASED" ? t("controller.rule") : t("controller.mcts");
  $("#formation-state").textContent = capabilities().formation ? t("board.formationEditable") : t("board.formationLocked");
  renderOrder();
  renderEnemyList();
  renderField("#player-field", "PLAYER");
  renderField("#enemy-field", "ENEMY");
  renderActionDock();
  renderSp();
  renderLog();
  renderFiendHud();
  const terminal = $("#terminal");
  terminal.classList.toggle("hidden", !snapshot.state.terminal);
  if (snapshot.state.terminal) {
    $("#terminal-outcome").textContent = t(`battle.outcome.${snapshot.state.terminal.outcome}`);
    $("#terminal-reason").textContent = t(`battle.reason.${snapshot.state.terminal.reason}`);
  }
  $("#rollback").disabled = !snapshot.can_rollback;
  $("#terminal-rollback").disabled = !snapshot.can_rollback;
  if (!preserveTip) {
    if (mode === "MONSTER_CHASER") setTip(t("tip.monster", {
      party: activeParty(),
      current: snapshot.state.monster_chaser.current_level,
      selected: snapshot.state.monster_chaser.selected_level,
    }));
    else if (capabilities().formation) setTip(t("tip.editable"));
    else setTip(t("tip.locked"));
  }
  refreshKeyboardTarget();
};

const scheduleAutoTurn = () => {
  window.clearTimeout(autoTurnTimer);
  if (!autoTurnEnabled || requestInFlight || animationRunning || snapshot?.state.terminal || snapshot?.state.active_side !== "PLAYER" || document.querySelector("dialog[open]")) return;
  autoTurnTimer = window.setTimeout(() => executePlan(), Math.max(180, 850 / speedValue));
};

const renderBattle = data => {
  snapshot = data;
  if (data.state.terminal) {
    autoTurnEnabled = false;
    window.clearTimeout(autoTurnTimer);
    $("#auto-turn").setAttribute("aria-pressed", "false");
  }
  const validOrder = new Set((data.legal || []).map(entry => Number(entry.unit_id)));
  plannedOrder = (data.state.teams.find(team => team.side === "PLAYER")?.action_order || []).map(Number).filter(id => validOrder.has(id));
  plannedCommands = new Map(plannedOrder.map(id => [id, 0]));
  plannedFormation = normalizeFormation(Object.values(data.state.units).filter(unit => unit.alive && unit.side === "PLAYER" && Number(unit.party_no || 1) === Number(data.state.monster_chaser?.current_party || 1)));
  selectedUnitId = plannedOrder[0] ?? null;
  keyboardDrag = null;
  if (autoReserveEnabled) plannedCommands = chooseAutoReserve({ order: plannedOrder, selections: plannedCommands, legalById: legalFor, costumeLookup: costumeById, sp: currentPlayerTeam().sp });
  let report = t("ai.idle");
  if (data.last_ai?.controller === "MCTS") report = t("ai.mctsReport", {
    simulations: data.last_ai.simulations,
    candidates: data.last_ai.candidates,
    value: Number(data.last_ai.root_value).toFixed(3),
  });
  else if (data.last_ai) report = t("ai.ruleReport");
  $("#ai-report").textContent = report;
  $("#pause-ai-report").textContent = report;
  $("#ai-step").classList.toggle("hidden", data.state.rules.mode === "MONSTER_CHASER");
  renderBattleSurface();
  scheduleAutoTurn();
};

const executePlan = async () => {
  if (requestInFlight || animationRunning || $("#execute").disabled) return;
  window.clearTimeout(autoTurnTimer);
  const before = snapshot;
  try {
    const mode = snapshot.state.rules.mode;
    const formation = capabilities().formation
      ? serializeFormation(plannedFormation, visiblePlayerUnits().filter(unit => unit.alive).map(unit => unit.id))
      : {};
    const result = await api("/api/step", {
      actions: actionIndices(plannedOrder, plannedCommands),
      order: plannedOrder,
      formation,
    }, mode === "MONSTER_CHASER" ? t("status.monsterActing") : t("status.enemyThinking"));
    if (await playBattleEvents(before, result)) renderBattle(result);
  } catch (error) {
    cancelPlayback();
    showError(error);
    scheduleAutoTurn();
  }
};

const resetBattle = async () => {
  window.clearTimeout(autoTurnTimer);
  cancelPlayback();
  try {
    renderBattle(await api("/api/reset", { seed: Number($("#setup-seed").value) }, t("status.resetting")));
    closeDialog("pause-dialog");
  } catch (error) {
    showError(error);
  }
};

const rollbackBattle = async () => {
  cancelPlayback();
  try {
    renderBattle(await api("/api/rollback", {}, t("status.rollingBack")));
    closeDialog("pause-dialog");
  } catch (error) {
    showError(error);
  }
};

$$('[data-close]').forEach(button => button.addEventListener("click", () => {
  closeDialog(button.dataset.close);
}));

$$("dialog").forEach(dialog => dialog.addEventListener("close", () => {
  if (dialog.id === "formation-dialog") document.querySelector(".advanced-popover")?.remove();
  if (dialog.id === "character-picker") characterPickerTarget = null;
  if (dialog.id === "pause-dialog") animationPaused = false;
  scheduleAutoTurn();
}));

$$("#content-tabs button").forEach(button => button.addEventListener("click", () => loadPreset(button.dataset.mode)));
$$("#party-switch button").forEach(button => button.addEventListener("click", () => {
  editorParty = Number(button.dataset.party);
  $$("#party-switch button").forEach(item => item.classList.toggle("active", Number(item.dataset.party) === editorParty));
  editorFocus = { sideKey: "player_units", index: partyUnits("player_units")[0]?.index ?? 0 };
  renderFormation();
}));
$$('[data-add-side]').forEach(button => button.addEventListener("click", () => {
  openCharacterPicker(
    button.dataset.addSide,
    draft.mode === "MONSTER_CHASER" && button.dataset.addSide === "PLAYER" ? editorParty : 1,
  );
}));
$("#character-search").addEventListener("input", renderCharacterPicker);

$("#restore-preset").addEventListener("click", () => loadPreset(draft.mode));
$("#start-battle").addEventListener("click", async () => {
  try {
    validateSetupControls();
    document.querySelector(".advanced-popover")?.remove();
    const started = await api("/api/start", startRequest(), t("status.preparingBattle"));
    loadDraft(started.setup);
    $("#setup-seed").value = String(started.seed);
    $("#mcts-simulations").value = String(started.mcts.simulations);
    renderBattle(started);
    closeDialog("formation-dialog");
  } catch (error) {
    showError(error);
  }
});
$("#execute").addEventListener("click", executePlan);
$("#ai-step").addEventListener("click", async () => {
  const before = snapshot;
  try {
    const result = await api("/api/ai-step", {}, t("status.playerThinking"));
    closeDialog("pause-dialog");
    if (await playBattleEvents(before, result)) renderBattle(result);
  } catch (error) {
    cancelPlayback();
    showError(error);
  }
});
$("#rollback").addEventListener("click", rollbackBattle);
$("#terminal-rollback").addEventListener("click", rollbackBattle);
$("#terminal-log").addEventListener("click", () => openDialog("log-dialog"));
$("#reset").addEventListener("click", resetBattle);
$("#terminal-reset").addEventListener("click", resetBattle);
$("#open-formation").addEventListener("click", () => openDialog("formation-dialog"));
$("#pause-formation").addEventListener("click", () => { cancelPlayback(); closeDialog("pause-dialog"); openDialog("formation-dialog"); });
$("#open-pause").addEventListener("click", () => {
  window.clearTimeout(autoTurnTimer);
  animationPaused = animationRunning;
  openDialog("pause-dialog");
});
$("#resume").addEventListener("click", () => {
  closeDialog("pause-dialog");
  animationPaused = false;
  scheduleAutoTurn();
});
$("#open-log").addEventListener("click", () => openDialog("log-dialog"));
$("#open-help").addEventListener("click", () => openDialog("help-dialog"));
$("#screen-toggle").addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) {
    showError(error);
  }
});
$("#auto-reserve").addEventListener("click", () => {
  autoReserveEnabled = !autoReserveEnabled;
  $("#auto-reserve").setAttribute("aria-pressed", String(autoReserveEnabled));
  if (autoReserveEnabled) plannedCommands = chooseAutoReserve({ order: plannedOrder, selections: plannedCommands, legalById: legalFor, costumeLookup: costumeById, sp: currentPlayerTeam().sp });
  renderBattleSurface();
});
$("#auto-turn").addEventListener("click", () => {
  autoTurnEnabled = !autoTurnEnabled;
  $("#auto-turn").setAttribute("aria-pressed", String(autoTurnEnabled));
  if (autoTurnEnabled) scheduleAutoTurn();
  else window.clearTimeout(autoTurnTimer);
});
$("#speed").addEventListener("click", () => {
  speedValue = nextSpeed(speedValue);
  $("#speed").textContent = `×${speedValue}`;
  $("#speed").setAttribute("aria-label", t("controls.speedAria", { speed: speedValue }));
  document.documentElement.style.setProperty("--speed-duration", `${Math.round(180 / speedValue)}ms`);
  document.documentElement.style.setProperty("--playback-speed", String(speedValue));
  scheduleAutoTurn();
});

document.addEventListener("keydown", event => {
  if (!keyboardDrag) return;
  if (event.key === " " && event.target.closest?.(".battle-token")) return;
  handleCellKeyboard(event);
});

try {
  catalog = await api("/api/catalog", undefined, t("status.loadingData"));
  $("#ruleset").textContent = catalog.ruleset_id;
  const initialState = await api("/api/state", undefined, t("status.preparingField"));
  loadDraft(initialState.setup || catalog.presets[initialState.state.rules.mode]);
  $("#setup-seed").value = String(initialState.seed);
  $("#mcts-simulations").value = String(initialState.mcts.simulations);
  renderBattle(initialState);
} catch (error) {
  showError(error);
}
