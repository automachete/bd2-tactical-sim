import type { BattleMode, Cell, Formation, ModeCapabilities } from "./types";

export const GRID_ROWS = 3;
export const GRID_DEPTHS = 4;
export const CURRENT_SP_CAP = 20;

type Numeric = number | string;
type CellInput = { row: Numeric; depth: Numeric };
type FormationInput = Record<string, CellInput>;
type FormationUnit = (CellInput | { position: CellInput }) & {
  id?: Numeric;
  unit_id?: Numeric;
  character_id?: string;
  party_no?: Numeric;
};
type CommandLike = {
  type: string;
  costume_id?: string;
  burst_level?: number;
  unavailable_reason?: string;
  ui?: { sp_cost?: number; burst_sp_cost?: number };
};
type LegalLike = { commands: CommandLike[] };
type LegalLookup = (unitId: Numeric) => LegalLike | undefined;
type CostumeLookup = (costumeId: string) => unknown;

export const cellKey = (row: Numeric, depth: Numeric): string => `${Number(row)},${Number(depth)}`;

export const isValidCell = (
  row: Numeric,
  depth: Numeric,
  rows = GRID_ROWS,
  depths = GRID_DEPTHS,
): boolean => Number.isInteger(Number(row))
  && Number.isInteger(Number(depth))
  && Number(row) >= 0
  && Number(row) < rows
  && Number(depth) >= 0
  && Number(depth) < depths;

export const normalizeFormation = (
  units: readonly FormationUnit[] | null | undefined,
  partyNo: Numeric | null = null,
): Formation => {
  const formation: Formation = {};
  for (const unit of units ?? []) {
    if (partyNo !== null && Number(unit.party_no ?? 1) !== Number(partyNo)) continue;
    const position = "position" in unit ? unit.position : unit;
    const identifier = unit.id ?? unit.unit_id ?? unit.character_id;
    if (identifier === undefined) throw new Error("formation unit is missing an identifier");
    formation[String(identifier)] = { row: Number(position.row), depth: Number(position.depth) };
  }
  return formation;
};

export const occupantAt = (
  formation: FormationInput | null | undefined,
  row: Numeric,
  depth: Numeric,
  exceptUnitId: Numeric | null = null,
): string | null => Object.entries(formation ?? {}).find(
  ([unitId, cell]) => String(unitId) !== String(exceptUnitId)
    && Number(cell.row) === Number(row)
    && Number(cell.depth) === Number(depth),
)?.[0] ?? null;

export const moveFormation = (
  formation: FormationInput,
  unitId: Numeric,
  row: Numeric,
  depth: Numeric,
  options: { swap?: boolean; rows?: number; depths?: number } = {},
): { formation: Formation; moved: boolean; swappedUnitId: string | null; source: Cell; target: Cell } => {
  const { swap = true, rows = GRID_ROWS, depths = GRID_DEPTHS } = options;
  const key = String(unitId);
  const existing = formation[key];
  if (!existing) throw new Error(`unknown formation unit: ${key}`);
  if (!isValidCell(row, depth, rows, depths)) throw new Error(`invalid formation cell: ${row},${depth}`);
  const source = { row: Number(existing.row), depth: Number(existing.depth) };
  const target = { row: Number(row), depth: Number(depth) };
  if (source.row === target.row && source.depth === target.depth) {
    return { formation: serializeFormation(formation), moved: false, swappedUnitId: null, source, target };
  }
  const next = serializeFormation(formation);
  const occupied = occupantAt(next, target.row, target.depth, key);
  if (occupied && !swap) throw new Error(`formation cell is occupied: ${target.row},${target.depth}`);
  next[key] = target;
  if (occupied) next[occupied] = source;
  return { formation: next, moved: true, swappedUnitId: occupied, source, target };
};

export const serializeFormation = (
  formation: FormationInput | null | undefined,
  allowedUnitIds: readonly Numeric[] | null = null,
): Formation => {
  const allowed = allowedUnitIds ? new Set(allowedUnitIds.map(String)) : null;
  return Object.fromEntries(
    Object.entries(formation ?? {})
      .filter(([unitId]) => !allowed || allowed.has(unitId))
      .map(([unitId, cell]) => [unitId, { row: Number(cell.row), depth: Number(cell.depth) }]),
  );
};

export const reorder = (order: readonly Numeric[] | null | undefined, unitId: Numeric, direction: Numeric): number[] => {
  const next = [...(order ?? [])].map(Number);
  const index = next.indexOf(Number(unitId));
  const destination = index + Number(direction);
  if (index < 0 || destination < 0 || destination >= next.length) return next;
  const current = next[index];
  const replacement = next[destination];
  if (current === undefined || replacement === undefined) return next;
  next[index] = replacement;
  next[destination] = current;
  return next;
};

export const commandCost = (command: CommandLike | undefined, costumeLookup: CostumeLookup): number => {
  void costumeLookup;
  if (!command || command.type !== "USE_COSTUME") return 0;
  const cost = Number(command.ui?.sp_cost);
  if (!Number.isInteger(cost) || cost < 0) {
    throw new TypeError(`costume command '${String(command.costume_id)}' is missing a valid resolved SP cost`);
  }
  return cost;
};

export const commandBurstCost = (command: CommandLike | undefined): number => {
  if (!command || command.type !== "USE_COSTUME") return 0;
  const cost = Number(command.ui?.burst_sp_cost);
  if (!Number.isInteger(cost) || cost < 0) {
    throw new TypeError(`costume command '${String(command.costume_id)}' is missing a valid resolved burst SP cost`);
  }
  return cost;
};

export type BurstOption<T extends CommandLike = CommandLike> = { command: T; index: number | null; available: boolean; level: number };
export const burstOptionsForCostume = <T extends CommandLike>(
  commands: readonly T[] | null | undefined,
  unavailableCommands: readonly T[] | null | undefined,
  costumeId: string,
): BurstOption<T>[] => {
  const byLevel = new Map<number, Omit<BurstOption<T>, "level">>();
  for (const command of unavailableCommands ?? []) {
    if (command.type === "USE_COSTUME" && command.costume_id === costumeId) {
      byLevel.set(Number(command.burst_level ?? 0), { command, index: null, available: false });
    }
  }
  for (const [index, command] of (commands ?? []).entries()) {
    if (command.type === "USE_COSTUME" && command.costume_id === costumeId) {
      byLevel.set(Number(command.burst_level ?? 0), { command, index, available: true });
    }
  }
  return [...byLevel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, option]) => ({ ...option, level }));
};

export const plannedSpCost = (
  order: readonly Numeric[] | null | undefined,
  selections: ReadonlyMap<number, number>,
  legalById: LegalLookup,
  costumeLookup: CostumeLookup,
): number => (order ?? []).reduce<number>((total, unitId) => {
  const commands = legalById(unitId)?.commands;
  if (!commands) throw new Error(`missing legal actions for unit ${unitId}`);
  if (!commands.length) return total;
  const index = Number(selections.get(Number(unitId)) ?? 0);
  const command = commands[index];
  if (!command) throw new RangeError(`masked planned action for unit ${unitId}: ${index}`);
  return total + commandCost(command, costumeLookup);
}, 0);

export const plannedBurstSpCost = (
  order: readonly Numeric[] | null | undefined,
  selections: ReadonlyMap<number, number>,
  legalById: LegalLookup,
): number => (order ?? []).reduce<number>((total, unitId) => {
  const commands = legalById(unitId)?.commands;
  if (!commands) throw new Error(`missing legal actions for unit ${unitId}`);
  if (!commands.length) return total;
  const index = Number(selections.get(Number(unitId)) ?? 0);
  const command = commands[index];
  if (!command) throw new RangeError(`masked planned action for unit ${unitId}: ${index}`);
  return total + commandBurstCost(command);
}, 0);

export type SpBreakdown = { cap: number; current: number; remaining: number; consumed: number; regularConsumed: number; burst: number };
export const spBreakdown = (input: { current: Numeric; reserved: Numeric; burst: Numeric; cap: Numeric }): SpBreakdown => {
  const values = { current: Number(input.current), reserved: Number(input.reserved), burst: Number(input.burst), cap: Number(input.cap) };
  if (Object.values(values).some((value) => !Number.isInteger(value))) throw new TypeError("SP values must be integers");
  if (values.cap !== CURRENT_SP_CAP) throw new RangeError(`SP cap must be ${CURRENT_SP_CAP}`);
  if (values.current < 0 || values.current > values.cap) throw new RangeError("current SP is outside the battle cap");
  if (values.reserved < 0 || values.reserved > values.current) throw new RangeError("reserved SP is outside the current balance");
  if (values.burst < 0 || values.burst > values.reserved) throw new RangeError("burst SP exceeds reserved SP");
  return {
    cap: values.cap,
    current: values.current,
    remaining: values.current - values.reserved,
    consumed: values.reserved,
    regularConsumed: values.reserved - values.burst,
    burst: values.burst,
  };
};

type PlanningInput = {
  order: readonly Numeric[];
  selections: ReadonlyMap<number, number>;
  legalById: LegalLookup;
  costumeLookup: CostumeLookup;
  sp: Numeric;
};
export const selectCommand = (input: PlanningInput, unitId: Numeric, index: Numeric): {
  accepted: boolean;
  reason: "MASKED_ACTION" | "INSUFFICIENT_SP" | null;
  selections: Map<number, number>;
} => {
  const commands = input.legalById(unitId)?.commands ?? [];
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= commands.length) {
    return { accepted: false, reason: "MASKED_ACTION", selections: new Map(input.selections) };
  }
  const next = new Map(input.selections);
  next.set(Number(unitId), numericIndex);
  if (plannedSpCost(input.order, next, input.legalById, input.costumeLookup) > Number(input.sp)) {
    return { accepted: false, reason: "INSUFFICIENT_SP", selections: new Map(input.selections) };
  }
  return { accepted: true, reason: null, selections: next };
};

export const autoReserve = (input: PlanningInput): Map<number, number> => {
  const next = new Map(input.selections);
  for (const unitId of input.order) {
    const commands = input.legalById(unitId)?.commands ?? [];
    const currentIndex = Number(next.get(Number(unitId)) ?? -1);
    const candidates = commands
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.type === "USE_COSTUME");
    const preferredIndex = candidates.findIndex(({ index }) => index === currentIndex);
    if (preferredIndex >= 0) {
      const [preferred] = candidates.splice(preferredIndex, 1);
      if (preferred) candidates.unshift(preferred);
    }
    let selected = commands.findIndex((command) => command.type === "NORMAL_ATTACK");
    if (selected < 0) selected = 0;
    next.set(Number(unitId), selected);
    for (const candidate of candidates) {
      const trial = new Map(next);
      trial.set(Number(unitId), candidate.index);
      if (plannedSpCost(input.order, trial, input.legalById, input.costumeLookup) <= Number(input.sp)) {
        next.set(Number(unitId), candidate.index);
        break;
      }
    }
  }
  return next;
};

export const rangePreviewCells = (
  range: readonly CellInput[] | null | undefined,
  rows = GRID_ROWS,
  depths = GRID_DEPTHS,
): Set<string> => {
  if (!Array.isArray(range)) throw new TypeError("skill range must be an array");
  const offsets = range.map((cell: CellInput) => ({ row: Number(cell.row), depth: Number(cell.depth) }));
  if (offsets.some((cell) => !Number.isInteger(cell.row) || !Number.isInteger(cell.depth))) throw new TypeError("skill range offsets must be integer cells");
  if (!offsets.length) return new Set();
  const rowsInRange = offsets.map((cell) => cell.row);
  const depthsInRange = offsets.map((cell) => cell.depth);
  const rowShift = Math.floor((rows - (Math.max(...rowsInRange) - Math.min(...rowsInRange) + 1)) / 2) - Math.min(...rowsInRange);
  const depthShift = Math.floor((depths - (Math.max(...depthsInRange) - Math.min(...depthsInRange) + 1)) / 2) - Math.min(...depthsInRange);
  const cells = new Set<string>();
  for (const cell of offsets) {
    const row = cell.row + rowShift;
    const depth = cell.depth + depthShift;
    if (isValidCell(row, depth, rows, depths)) cells.add(cellKey(row, depth));
  }
  return cells;
};

export const projectRangeCells = (
  range: readonly CellInput[] | null | undefined,
  anchor: CellInput | null | undefined,
  options: { targetAll?: boolean; rows?: number; depths?: number } = {},
): Set<string> => {
  const { targetAll = false, rows = GRID_ROWS, depths = GRID_DEPTHS } = options;
  const cells = new Set<string>();
  if (targetAll) {
    for (let row = 0; row < rows; row += 1) {
      for (let depth = 0; depth < depths; depth += 1) cells.add(cellKey(row, depth));
    }
    return cells;
  }
  if (!anchor || !isValidCell(anchor.row, anchor.depth, rows, depths)) throw new RangeError("range projection anchor is outside the board");
  if (!Array.isArray(range)) throw new TypeError("skill range must be an array");
  const offsets: readonly CellInput[] = range.length ? range : [{ row: 0, depth: 0 }];
  for (const offset of offsets) {
    if (!Number.isInteger(Number(offset.row)) || !Number.isInteger(Number(offset.depth))) throw new TypeError("skill range offsets must be integer cells");
    const row = Number(anchor.row) + Number(offset.row);
    const depth = Number(anchor.depth) + Number(offset.depth);
    if (isValidCell(row, depth, rows, depths)) cells.add(cellKey(row, depth));
  }
  return cells;
};

const KNOCKBACK_PRESENTATIONS = {
  BACK: { arrow: "↑", row: -1, depth: 0 },
  FRONT: { arrow: "↓", row: 1, depth: 0 },
  UP: { arrow: "→", row: 0, depth: 1 },
  DOWN: { arrow: "←", row: 0, depth: -1 },
  UP_BACK: { arrow: "↗", row: -1, depth: 1 },
  DOWN_BACK: { arrow: "↖", row: -1, depth: -1 },
  UP_FRONT: { arrow: "↘", row: 1, depth: 1 },
  DOWN_FRONT: { arrow: "↙", row: 1, depth: -1 },
} as const;
export type KnockbackDirection = keyof typeof KNOCKBACK_PRESENTATIONS;
export const knockbackPresentation = (direction: unknown): {
  direction: KnockbackDirection; arrow: string; row: number; depth: number; distance: 1;
} => {
  const displayDirection = typeof direction === "string" || typeof direction === "number" ? String(direction) : "";
  const normalized = displayDirection.toUpperCase();
  if (!(normalized in KNOCKBACK_PRESENTATIONS)) throw new Error(`Unsupported knockback direction: ${displayDirection}`);
  const key = normalized as KnockbackDirection;
  return { direction: key, ...KNOCKBACK_PRESENTATIONS[key], distance: 1 };
};

export const knockbackPreviewCells = (direction: unknown, rows = GRID_ROWS, depths = GRID_ROWS) => {
  const presentation = knockbackPresentation(direction);
  const origin = { row: Math.floor(rows / 2), depth: Math.floor(depths / 2) };
  const destination = { row: origin.row + presentation.row, depth: origin.depth + presentation.depth };
  return { ...presentation, origin, destination: isValidCell(destination.row, destination.depth, rows, depths) ? destination : origin };
};

export const modeCapabilities = (mode: BattleMode, allowFormationChange = true): ModeCapabilities => {
  const golden = mode === "GOLDEN_COLOSSEUM";
  return {
    formation: allowFormationChange && !golden,
    mctsOpponent: mode !== "MONSTER_CHASER" && !golden,
    ruleBasedOpponent: mode === "MONSTER_CHASER",
    automaticBattle: golden,
    twoPlayerParties: mode === "MONSTER_CHASER",
    manualPlayer: !golden,
  };
};

export const keyboardTarget = (cell: CellInput, key: string, rows = GRID_ROWS, depths = GRID_DEPTHS): Cell => {
  const deltas: Partial<Record<string, readonly [number, number]>> = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };
  const delta = deltas[key];
  if (!delta) return { row: Number(cell.row), depth: Number(cell.depth) };
  return {
    row: Math.min(rows - 1, Math.max(0, Number(cell.row) + delta[0])),
    depth: Math.min(depths - 1, Math.max(0, Number(cell.depth) + delta[1])),
  };
};

export const nextSpeed = (speed: Numeric): number => ({ 1: 2, 2: 3, 3: 1 })[Number(speed) as 1 | 2 | 3] ?? 1;
export const playbackDelay = (milliseconds: Numeric, speed: Numeric): number => Math.max(0, Math.round(Number(milliseconds) / Math.max(1, Number(speed) || 1)));
export const actionIndices = (order: readonly Numeric[] | null | undefined, selections: ReadonlyMap<number, number>): number[] => (
  (order ?? []).map((unitId) => Number(selections.get(Number(unitId)) ?? 0))
);
