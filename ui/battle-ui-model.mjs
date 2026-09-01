export const GRID_ROWS = 3;
export const GRID_DEPTHS = 4;

export const cellKey = (row, depth) => `${Number(row)},${Number(depth)}`;

export const isValidCell = (row, depth, rows = GRID_ROWS, depths = GRID_DEPTHS) =>
  Number.isInteger(Number(row)) &&
  Number.isInteger(Number(depth)) &&
  Number(row) >= 0 &&
  Number(row) < rows &&
  Number(depth) >= 0 &&
  Number(depth) < depths;

export const normalizeFormation = (units, partyNo = null) => {
  const formation = {};
  for (const unit of units ?? []) {
    if (partyNo !== null && Number(unit.party_no ?? 1) !== Number(partyNo)) continue;
    const position = unit.position ?? unit;
    formation[String(unit.id ?? unit.unit_id ?? unit.character_id)] = {
      row: Number(position.row),
      depth: Number(position.depth),
    };
  }
  return formation;
};

export const occupantAt = (formation, row, depth, exceptUnitId = null) =>
  Object.entries(formation ?? {}).find(
    ([unitId, cell]) =>
      String(unitId) !== String(exceptUnitId) &&
      Number(cell.row) === Number(row) &&
      Number(cell.depth) === Number(depth),
  )?.[0] ?? null;

export const moveFormation = (
  formation,
  unitId,
  row,
  depth,
  { swap = true, rows = GRID_ROWS, depths = GRID_DEPTHS } = {},
) => {
  const key = String(unitId);
  if (!formation?.[key]) throw new Error(`unknown formation unit: ${key}`);
  if (!isValidCell(row, depth, rows, depths)) throw new Error(`invalid formation cell: ${row},${depth}`);
  const source = { ...formation[key] };
  const target = { row: Number(row), depth: Number(depth) };
  if (source.row === target.row && source.depth === target.depth) {
    return { formation: structuredClone(formation), moved: false, swappedUnitId: null, source, target };
  }
  const next = structuredClone(formation);
  const occupied = occupantAt(next, target.row, target.depth, key);
  if (occupied && !swap) throw new Error(`formation cell is occupied: ${target.row},${target.depth}`);
  next[key] = target;
  if (occupied) next[occupied] = source;
  return { formation: next, moved: true, swappedUnitId: occupied, source, target };
};

export const serializeFormation = (formation, allowedUnitIds = null) => {
  const allowed = allowedUnitIds ? new Set(allowedUnitIds.map(String)) : null;
  return Object.fromEntries(
    Object.entries(formation ?? {})
      .filter(([unitId]) => !allowed || allowed.has(String(unitId)))
      .map(([unitId, cell]) => [String(unitId), { row: Number(cell.row), depth: Number(cell.depth) }]),
  );
};

export const reorder = (order, unitId, direction) => {
  const next = [...(order ?? [])].map(Number);
  const index = next.indexOf(Number(unitId));
  const destination = index + Number(direction);
  if (index < 0 || destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
};

export const commandCost = (command, costumeLookup) => {
  if (!command || command.type !== "USE_COSTUME") return 0;
  return Number(command.ui?.sp_cost ?? costumeLookup(command.costume_id)?.sp_cost ?? 0);
};

export const plannedSpCost = (order, selections, legalById, costumeLookup) =>
  (order ?? []).reduce((total, unitId) => {
    const commands = legalById(unitId)?.commands ?? [];
    const index = Number(selections.get(Number(unitId)) ?? 0);
    return total + commandCost(commands[index], costumeLookup);
  }, 0);

export const selectCommand = ({ order, selections, legalById, costumeLookup, sp }, unitId, index) => {
  const commands = legalById(unitId)?.commands ?? [];
  if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= commands.length) {
    return { accepted: false, reason: "MASKED_ACTION", selections: new Map(selections) };
  }
  const next = new Map(selections);
  next.set(Number(unitId), Number(index));
  if (plannedSpCost(order, next, legalById, costumeLookup) > Number(sp)) {
    return { accepted: false, reason: "INSUFFICIENT_SP", selections: new Map(selections) };
  }
  return { accepted: true, reason: null, selections: next };
};

export const autoReserve = ({ order, selections, legalById, costumeLookup, sp }) => {
  const next = new Map(selections);
  for (const unitId of order ?? []) {
    const commands = legalById(unitId)?.commands ?? [];
    const currentIndex = Number(next.get(Number(unitId)) ?? -1);
    const candidates = commands
      .map((command, index) => ({ command, index, cost: commandCost(command, costumeLookup) }))
      .filter(item => item.command.type === "USE_COSTUME");
    const preferred = candidates.find(item => item.index === currentIndex);
    if (preferred) candidates.splice(candidates.indexOf(preferred), 1);
    if (preferred) candidates.unshift(preferred);
    let selected = commands.findIndex(command => command.type === "NORMAL_ATTACK");
    if (selected < 0) selected = commands.findIndex(command => command.type === "WAIT");
    if (selected < 0) selected = 0;
    next.set(Number(unitId), selected);
    for (const candidate of candidates) {
      const trial = new Map(next);
      trial.set(Number(unitId), candidate.index);
      if (plannedSpCost(order, trial, legalById, costumeLookup) <= Number(sp)) {
        next.set(Number(unitId), candidate.index);
        break;
      }
    }
  }
  return next;
};

export const rangePreviewCells = (range, rows = GRID_ROWS, depths = GRID_DEPTHS) => {
  const offsets = (range ?? [])
    .map(cell => ({ row: Number(cell.row), depth: Number(cell.depth) }))
    .filter(cell => Number.isInteger(cell.row) && Number.isInteger(cell.depth));
  if (!offsets.length) return new Set();
  const minimumRow = Math.min(...offsets.map(cell => cell.row));
  const maximumRow = Math.max(...offsets.map(cell => cell.row));
  const minimumDepth = Math.min(...offsets.map(cell => cell.depth));
  const maximumDepth = Math.max(...offsets.map(cell => cell.depth));
  const rowShift = Math.floor((rows - (maximumRow - minimumRow + 1)) / 2) - minimumRow;
  const depthShift = Math.floor((depths - (maximumDepth - minimumDepth + 1)) / 2) - minimumDepth;
  const cells = new Set();
  for (const cell of offsets) {
    const row = cell.row + rowShift;
    const depth = cell.depth + depthShift;
    if (isValidCell(row, depth, rows, depths)) cells.add(cellKey(row, depth));
  }
  return cells;
};

export const projectRangeCells = (
  range,
  anchor,
  { targetAll = false, rows = GRID_ROWS, depths = GRID_DEPTHS } = {},
) => {
  const cells = new Set();
  if (targetAll) {
    for (let row = 0; row < rows; row += 1) {
      for (let depth = 0; depth < depths; depth += 1) cells.add(cellKey(row, depth));
    }
    return cells;
  }
  if (!anchor || !isValidCell(anchor.row, anchor.depth, rows, depths)) return cells;
  const offsets = range?.length ? range : [{ row: 0, depth: 0 }];
  for (const offset of offsets) {
    const row = Number(anchor.row) + Number(offset.row);
    const depth = Number(anchor.depth) + Number(offset.depth);
    if (isValidCell(row, depth, rows, depths)) cells.add(cellKey(row, depth));
  }
  return cells;
};

export const modeCapabilities = (mode, allowFormationChange = true) => ({
  formation: Boolean(allowFormationChange),
  mctsOpponent: mode !== "MONSTER_CHASER",
  ruleBasedOpponent: mode === "MONSTER_CHASER",
  twoPlayerParties: mode === "MONSTER_CHASER",
  manualPlayer: true,
});

export const keyboardTarget = (cell, key, rows = GRID_ROWS, depths = GRID_DEPTHS) => {
  const deltas = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const delta = deltas[key];
  if (!delta) return { ...cell };
  return {
    row: Math.min(rows - 1, Math.max(0, Number(cell.row) + delta[0])),
    depth: Math.min(depths - 1, Math.max(0, Number(cell.depth) + delta[1])),
  };
};

export const nextSpeed = speed => ({ 1: 2, 2: 3, 3: 1 }[Number(speed)] ?? 1);

export const playbackDelay = (milliseconds, speed) =>
  Math.max(0, Math.round(Number(milliseconds) / Math.max(1, Number(speed) || 1)));

export const actionIndices = (order, selections) =>
  (order ?? []).map(unitId => Number(selections.get(Number(unitId)) ?? 0));
