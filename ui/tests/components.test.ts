import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";

import Avatar from "../src/components/Avatar.svelte";
import MiniRange from "../src/components/MiniRange.svelte";
import type { CharacterDefinition } from "../src/lib/types";

afterEach(cleanup);

const character: CharacterDefinition = {
  id: "Lathel",
  name: "ラテル",
  rarity: 5,
  element: "FIRE",
  attack_type: "PHYSICAL",
  knockback_direction: "BACK",
  level_100: {
    max_hp: 1,
    attack: 1,
    magic: 0,
    defense_bp: 0,
    magic_resist_bp: 0,
    crit_rate_bp: 0,
    crit_damage_bp: 0,
    property_damage_bp: 0,
    amplification_bp: 0,
    incoming_damage_bp: 0,
    outgoing_damage_bp: 0,
  },
  costumes: [],
  awakening_modifiers: {},
  engraving_modifiers: {},
};

describe("declarative presentation components", () => {
  test("renders the local portrait and stable character metadata", () => {
    render(Avatar, { character, id: "selected-emblem" });

    const emblem = document.getElementById("selected-emblem");
    expect(emblem).toHaveAttribute("data-character-id", "Lathel");
    expect(emblem?.querySelector("img")).toHaveAttribute(
      "src",
      "/assets/character-icons/64/Lathel.png",
    );
  });

  test("derives a range grid from typed cells", () => {
    const { container } = render(MiniRange, {
      range: [{ row: 0, depth: 0 }, { row: 1, depth: 2 }],
      rows: 3,
      depths: 4,
      knockbackDirection: undefined,
      knockbackOffset: undefined,
    });

    expect(container.querySelectorAll("i")).toHaveLength(12);
    expect(container.querySelectorAll("i.hit")).toHaveLength(2);
  });

  test("renders the simulator-provided knockback vector without reinterpreting it", () => {
    const { container } = render(MiniRange, {
      range: [{ row: 0, depth: 0 }],
      rows: 3,
      depths: 4,
      knockbackDirection: "FRONT",
      knockbackOffset: { row: 0, depth: -1 },
    });

    expect(container.querySelector(".knockback-value b")).toHaveTextContent("←");
    expect(container.querySelector(".knockback-grid")).toHaveAttribute("data-knockback-row", "0");
    expect(container.querySelector(".knockback-grid")).toHaveAttribute("data-knockback-depth", "-1");
    expect(container.querySelector("i.destination")).toHaveAttribute("data-row", "1");
    expect(container.querySelector("i.destination")).toHaveAttribute("data-depth", "0");
  });
});
