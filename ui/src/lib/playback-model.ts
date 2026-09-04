import type { BattleEvent, Cell } from "./types";

export const eventNumber = (event: BattleEvent, key: string, fallback = 0): number => {
  const value = event.kind[key];
  return typeof value === "number" ? value : Number(value ?? fallback);
};

export const eventString = (event: BattleEvent, key: string): string => {
  const value = event.kind[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};

export const eventCell = (event: BattleEvent, key: string): Cell | null => {
  const value = event.kind[key];
  if (typeof value !== "object" || value === null || !("row" in value) || !("depth" in value)) return null;
  return typeof value.row === "number" && typeof value.depth === "number"
    ? { row: value.row, depth: value.depth }
    : null;
};

export const eventUnitIds = (event: BattleEvent, key: string): number[] => {
  const value = event.kind[key];
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
};
