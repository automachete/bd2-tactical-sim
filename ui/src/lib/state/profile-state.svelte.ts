import { SvelteMap } from "svelte/reactivity";

import type { BattleApi } from "../api";
import { t } from "../i18n";
import type { CharacterProfile, CharacterProfileDocument } from "../types";
import type { CatalogReader, FeedbackPort } from "./contracts";
import { snapshotClone } from "./snapshot-clone.svelte";

export class ProfileState {
  profiles = $state<CharacterProfileDocument | null>(null);
  selectedProfileId = $state<string | null>(null);
  profileSearch = $state("");
  profileElementFilter = $state("ALL");
  profileDrafts = $state<Map<string, CharacterProfile>>(new SvelteMap());

  private disposed = false;

  constructor(
    private readonly api: BattleApi,
    private readonly catalog: CatalogReader,
    private readonly feedback: FeedbackPort,
    private readonly onProfilesUpdated: () => void,
  ) {}

  setProfiles(profiles: CharacterProfileDocument): void {
    this.profiles = profiles;
  }

  profileFor(characterId: string): CharacterProfile {
    const profile = this.profiles?.profiles.find((item) => item.character_id === characterId);
    if (!profile) throw new Error(`character profile is missing for ${characterId}`);
    return profile;
  }

  openProfiles(preferred?: string): void {
    this.profileDrafts = new SvelteMap();
    this.selectedProfileId = preferred ?? this.selectedProfileId ?? this.catalog.catalog?.characters[0]?.id ?? null;
    this.profileSearch = "";
    this.profileElementFilter = "ALL";
  }

  discardDrafts(): void {
    this.profileDrafts = new SvelteMap();
  }

  setSearch(search: string): void {
    this.profileSearch = search;
  }

  setElementFilter(element: string): void {
    this.profileElementFilter = element;
  }

  selectProfile(characterId: string): void {
    this.selectedProfileId = characterId;
  }

  editableProfile(characterId: string): CharacterProfile {
    const existing = this.profileDrafts.get(characterId);
    if (existing) return existing;
    const profile = snapshotClone(this.profileFor(characterId));
    const next = new SvelteMap(this.profileDrafts);
    next.set(characterId, profile);
    this.profileDrafts = next;
    return profile;
  }

  profileDirty(characterId: string): boolean {
    const draft = this.profileDrafts.get(characterId);
    return draft !== undefined && JSON.stringify(draft) !== JSON.stringify(this.profileFor(characterId));
  }

  mutateProfile(characterId: string, mutate: (profile: CharacterProfile) => void): void {
    const profile = snapshotClone(this.editableProfile(characterId));
    mutate(profile);
    const next = new SvelteMap(this.profileDrafts);
    next.set(characterId, profile);
    this.profileDrafts = next;
  }

  saveProfile = async (characterId: string): Promise<void> => {
    try {
      const profile = this.editableProfile(characterId);
      const payload: Omit<CharacterProfile, "is_default"> = {
        character_id: profile.character_id,
        awakening_enabled: profile.awakening_enabled,
        costumes: snapshotClone(profile.costumes),
        equipment: snapshotClone(profile.equipment),
      };
      const profiles = await this.feedback.withBusy(t("status.savingProfile"), () => this.api.saveProfile(payload));
      if (this.disposed) return;
      this.profiles = profiles;
      const next = new SvelteMap(this.profileDrafts);
      next.delete(characterId);
      this.profileDrafts = next;
      this.onProfilesUpdated();
      this.feedback.setTip(t("profiles.saved", { name: this.catalog.character(characterId)?.name ?? characterId }));
    } catch { /* surfaced by FeedbackState */ }
  };

  resetProfile = async (characterId: string): Promise<void> => {
    try {
      const profiles = await this.feedback.withBusy(t("status.resettingProfile"), () => this.api.resetProfile(characterId));
      if (this.disposed) return;
      this.profiles = profiles;
      const next = new SvelteMap(this.profileDrafts);
      next.delete(characterId);
      this.profileDrafts = next;
      this.onProfilesUpdated();
      this.feedback.setTip(t("profiles.resetDone", { name: this.catalog.character(characterId)?.name ?? characterId }));
    } catch { /* surfaced by FeedbackState */ }
  };

  dispose(): void {
    this.disposed = true;
  }
}
