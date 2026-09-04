import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(uiRoot, "src");
const stateRoot = resolve(sourceRoot, "lib/state");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".svelte"].includes(extname(path)) ? [path] : [];
  });
}

const read = (path: string): string => readFileSync(path, "utf8");
const lines = (path: string): number => read(path).split(/\r?\n/u).length;
const display = (path: string): string => relative(uiRoot, path).replaceAll("\\", "/");
const stateFiles = sourceFiles(stateRoot).filter((path) => path.endsWith("-state.svelte.ts"));
const componentFiles = sourceFiles(resolve(sourceRoot, "components")).filter((path) => path.endsWith(".svelte"));

function resolveImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.svelte`, `${base}.svelte.ts`, resolve(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function importGraph(paths: string[]): Map<string, string[]> {
  const included = new Set(paths);
  return new Map(paths.map((path) => {
    const dependencies = [...read(path).matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu)]
      .map((match) => resolveImport(path, match[1] ?? ""))
      .filter((dependency): dependency is string => dependency !== null && included.has(dependency));
    return [path, dependencies];
  }));
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (path: string): string[] | null => {
    if (active.has(path)) return [...stack.slice(stack.indexOf(path)), path];
    if (visited.has(path)) return null;
    visited.add(path);
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(path);
    return null;
  };
  for (const path of graph.keys()) {
    const cycle = visit(path);
    if (cycle) return cycle;
  }
  return null;
}

describe("Svelte UI architecture", () => {
  test("has one production implementation and no legacy fallback", () => {
    expect(existsSync(resolve(uiRoot, "app.js"))).toBe(false);
    expect(existsSync(resolve(uiRoot, "battle-ui-model.mjs"))).toBe(false);
    expect(existsSync(resolve(uiRoot, "i18n.mjs"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "lib/battle-controller.ts"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "lib/battle-state.svelte.ts"))).toBe(false);
  });

  test("keeps imperative DOM rendering, dynamic imports, and unsafe escapes out of production", () => {
    const forbidden = [
      /document\s*\.\s*querySelector(?:All)?\s*\(/,
      /\.\s*innerHTML\s*=/,
      /insertAdjacentHTML\s*\(/,
      /\{@html\b/,
      /\bimport\s*\(/,
      /\bas\s+any\b/,
      /:\s*any\b/,
      /@ts-(?:ignore|nocheck|expect-error)/,
      /eslint-disable/,
    ];
    for (const path of sourceFiles(sourceRoot)) {
      const source = read(path);
      for (const pattern of forbidden) expect(source, `${display(path)} contains ${pattern}`).not.toMatch(pattern);
    }
  });

  test("keeps App.svelte as the composition and lifecycle boundary", () => {
    const path = resolve(sourceRoot, "App.svelte");
    const app = read(path);
    expect(lines(path)).toBeLessThan(100);
    expect(app).toContain("const app = new BattleAppState()");
    expect(app).toContain("void app.initialize()");
    expect(app).toContain("return () => app.dispose()");
    for (const component of ["BattleBoard", "ActionOrder", "CommandSelection", "PreparationDialog"]) {
      expect(app).toContain(`<${component} `);
    }
    expect(app).not.toContain("{model}");
  });

  test("keeps the app root small and free of a forwarding facade", () => {
    const path = resolve(stateRoot, "app-state.svelte.ts");
    const source = read(path);
    expect(lines(path)).toBeLessThanOrEqual(250);
    expect(source).toContain("class BattleAppState");
    for (const domain of ["CatalogState", "SessionState", "FeedbackState", "ProfileState", "SetupState", "PlanningState", "PlaybackState", "ExecutionState", "DialogState"]) {
      expect(source).toContain(`new ${domain}`);
    }
    for (const forwarded of ["selectUnit", "moveBattleUnit", "executePlan", "saveProfile", "openPicker"]) {
      expect(source).not.toContain(`${forwarded}(`);
    }
  });

  test("gives each major state surface exactly one domain owner", () => {
    const ownership: Record<string, string[]> = {
      "catalog-state.svelte.ts": ["catalog"],
      "session-state.svelte.ts": ["snapshot"],
      "feedback-state.svelte.ts": ["busy", "busyLabel", "error", "tip", "announcement"],
      "profile-state.svelte.ts": ["profiles", "selectedProfileId", "profileSearch", "profileElementFilter", "profileDrafts"],
      "setup-state.svelte.ts": ["draft", "editorParty", "editorFocus", "advancedEditor", "setupSeed", "monsterLevel", "mctsSimulations", "savedSetupName", "selectedSavedSetup", "savedSetupStatus"],
      "planning-state.svelte.ts": ["selectedUnitId", "plannedOrder", "plannedCommands", "plannedBurstLevels", "plannedFormation", "preview", "previewPending", "autoReserveEnabled"],
      "playback-state.svelte.ts": ["speed", "executing", "paused", "cue", "floating", "playbackUnits", "playbackCreated", "playbackTargetId", "playbackTargetCell", "playbackActorId", "playbackMonster", "playbackParty", "playbackSp", "playbackCanRollback"],
      "execution-state.svelte.ts": ["autoTurnEnabled"],
      "dialog-state.svelte.ts": ["dialog", "returnDialog", "inspectedUnitId", "pickerTarget"],
    };
    const allStateSources = new Map(stateFiles.map((path) => [path, read(path)]));
    for (const [ownerName, fields] of Object.entries(ownership)) {
      const owner = resolve(stateRoot, ownerName);
      for (const field of fields) {
        const declaration = new RegExp(`^  ${field} = \\$state`, "mu");
        expect(allStateSources.get(owner), `${field} is missing from ${ownerName}`).toMatch(declaration);
        for (const [candidate, source] of allStateSources) {
          if (candidate !== owner) expect(source, `${field} is also owned by ${display(candidate)}`).not.toMatch(declaration);
        }
      }
    }
  });

  test("keeps every domain state module reviewable in isolation", () => {
    for (const path of stateFiles.filter((candidate) => !candidate.endsWith("app-state.svelte.ts"))) {
      expect(lines(path), `${display(path)} is too large`).toBeLessThanOrEqual(350);
      expect(read(path).match(/^export class \w+State\b/gmu), `${display(path)} must define one state owner`).toHaveLength(1);
    }
  });

  test("prevents components from depending on the application root", () => {
    for (const path of componentFiles) {
      const source = read(path);
      expect(source, display(path)).not.toMatch(/BattleAppState|battle-state\.svelte|\{\s*model\s*\}|\bmodel\./u);
    }
  });

  test("has no module-level state singleton and no state dependency cycle", () => {
    for (const path of stateFiles.filter((candidate) => !candidate.endsWith("app-state.svelte.ts"))) {
      const source = read(path);
      expect(source, display(path)).not.toMatch(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+\w*State\s*\(/mu);
      expect(source, display(path)).not.toMatch(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*\$state\b/mu);
      expect(source, display(path)).not.toMatch(/from\s+["'][^"']*app-state\.svelte["']/u);
    }
    const cycle = findCycle(importGraph(sourceFiles(stateRoot)));
    expect(cycle?.map(display).join(" -> ") ?? null).toBeNull();
  });

  test("keeps pure models independent from Svelte and browser APIs", () => {
    for (const name of ["battle-ui-model.ts", "playback-model.ts", "setup-model.ts"]) {
      const source = read(resolve(sourceRoot, `lib/${name}`));
      expect(source, name).not.toMatch(/\$state|svelte\/|\bwindow\b|\bdocument\b|AbortController|DOMException/u);
    }
  });

  test("requires explicit cleanup wherever UI timers or abort controllers are owned", () => {
    for (const path of sourceFiles(sourceRoot)) {
      const source = read(path);
      if (!source.includes("setTimeout") && !source.includes("AbortController")) continue;
      if (path.endsWith(".svelte")) {
        expect(source, `${display(path)} has an unowned component timer`).toContain("onDestroy");
      } else {
        expect(source, `${display(path)} has no dispose path`).toMatch(/\bdispose\s*\(/u);
      }
      expect(source, `${display(path)} does not cancel its async resource`).toMatch(/clearTimeout|\.abort\(\)/u);
    }
  });

  test("enforces strict TypeScript without skipped library checks", () => {
    const config = JSON.parse(readFileSync(resolve(uiRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(config.compilerOptions?.strict).toBe(true);
    expect(config.compilerOptions?.skipLibCheck).not.toBe(true);
  });
});
