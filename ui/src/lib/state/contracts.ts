import type {
  BattleMode,
  BattleSnapshot,
  BattleTeam,
  BattleUnit,
  Catalog,
  CharacterDefinition,
  CharacterProfile,
  CostumeDefinition,
  EntityDefinition,
  LegalActions,
  ModeCapabilities,
  MonsterChaserState,
} from "../types";

export type CatalogReader = {
  readonly catalog: Catalog | null;
  character: (id: string) => CharacterDefinition | undefined;
  entity: (id: string) => EntityDefinition | undefined;
  costume: (id: string) => CostumeDefinition | undefined;
};

export type SessionReader = {
  readonly snapshot: BattleSnapshot | null;
  readonly mode: BattleMode;
  readonly capabilities: ModeCapabilities;
  readonly currentPlayerTeam: BattleTeam | null;
  legalFor: (unitId: number) => LegalActions | undefined;
};

export type PlaybackReader = {
  readonly executing: boolean;
  readonly units: Record<string, BattleUnit>;
  readonly activeParty: number;
  readonly monsterState: MonsterChaserState | null;
  readonly playbackSp: number | null;
  readonly playerUnits: BattleUnit[];
  readonly enemyUnits: BattleUnit[];
};

export type ProfileReader = {
  profileFor: (characterId: string) => CharacterProfile;
};

export type FeedbackPort = {
  readonly busy: boolean;
  withBusy: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  showError: (error: unknown) => void;
  announce: (message: string) => void;
  setTip: (message: string) => void;
};
