import { costumeById, entityById } from "../presentation";
import type {
  Catalog,
  CharacterDefinition,
  CostumeDefinition,
  EntityDefinition,
} from "../types";

export class CatalogState {
  catalog = $state<Catalog | null>(null);

  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
  }

  character(id: string): CharacterDefinition | undefined {
    return this.catalog?.characters.find((character) => character.id === id);
  }

  entity(id: string): EntityDefinition | undefined {
    return this.catalog ? entityById(this.catalog, id) : undefined;
  }

  costume(id: string): CostumeDefinition | undefined {
    return this.catalog ? costumeById(this.catalog, id) : undefined;
  }
}
