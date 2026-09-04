import type {
  BattleSetup,
  BattleSnapshot,
  Catalog,
  CharacterProfile,
  CharacterProfileDocument,
  Formation,
  PreviewResult,
} from "./types";

type RequestOptions = { signal?: AbortSignal };
type ApiErrorBody = { error?: string };

export type PreviewRequest = {
  unit_id: number;
  action_index: number;
  order: number[];
  formation: Formation;
  actions: number[];
};

export type BattleApi = {
  catalog: () => Promise<Catalog>;
  state: () => Promise<BattleSnapshot>;
  profiles: () => Promise<CharacterProfileDocument>;
  start: (setup: BattleSetup) => Promise<BattleSnapshot>;
  reset: (seed: number) => Promise<BattleSnapshot>;
  step: (actions: number[], order: number[], formation: Formation) => Promise<BattleSnapshot>;
  aiStep: () => Promise<BattleSnapshot>;
  rollback: () => Promise<BattleSnapshot>;
  preview: (request: PreviewRequest, signal: AbortSignal) => Promise<PreviewResult>;
  saveSetup: (name: string, setup: BattleSetup) => Promise<BattleSnapshot & { saved: { name: string; scenario: string } }>;
  loadSetup: (name: string) => Promise<BattleSnapshot>;
  saveProfile: (profile: Omit<CharacterProfile, "is_default">) => Promise<CharacterProfileDocument>;
  resetProfile: (characterId: string) => Promise<CharacterProfileDocument>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const requestJson = async <T>(
  path: string,
  body?: Readonly<Record<string, unknown>>,
  options: RequestOptions = {},
): Promise<T> => {
  const init: RequestInit = {};
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (options.signal) init.signal = options.signal;
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(payload) ? (payload as ApiErrorBody).error : undefined;
    throw new Error(message ?? response.statusText);
  }
  if (!isRecord(payload)) throw new TypeError(`${path} returned a non-object JSON payload`);
  return payload as T;
};

export const createBattleApi = (): BattleApi => ({
  catalog: (): Promise<Catalog> => requestJson<Catalog>("/api/catalog"),
  state: (): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/state"),
  profiles: (): Promise<CharacterProfileDocument> => requestJson<CharacterProfileDocument>("/api/character-profiles"),
  start: (setup: BattleSetup): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/start", setup),
  reset: (seed: number): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/reset", { seed }),
  step: (actions: number[], order: number[], formation: Formation): Promise<BattleSnapshot> => (
    requestJson<BattleSnapshot>("/api/step", { actions, order, formation })
  ),
  aiStep: (): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/ai-step", {}),
  rollback: (): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/rollback", {}),
  preview: (request, signal): Promise<PreviewResult> => requestJson<PreviewResult>("/api/preview", request, { signal }),
  saveSetup: (name: string, setup: BattleSetup): Promise<BattleSnapshot & { saved: { name: string; scenario: string } }> => (
    requestJson<BattleSnapshot & { saved: { name: string; scenario: string } }>("/api/save-setup", { name, setup })
  ),
  loadSetup: (name: string): Promise<BattleSnapshot> => requestJson<BattleSnapshot>("/api/load-setup", { name }),
  saveProfile: (profile: Omit<CharacterProfile, "is_default">): Promise<CharacterProfileDocument> => (
    requestJson<CharacterProfileDocument>("/api/save-character-profile", { profile })
  ),
  resetProfile: (characterId: string): Promise<CharacterProfileDocument> => (
    requestJson<CharacterProfileDocument>("/api/reset-character-profile", { character_id: characterId })
  ),
});
