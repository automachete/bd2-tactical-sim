import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(uiRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".svelte"].includes(extname(path)) ? [path] : [];
  });
}

describe("Svelte UI architecture", () => {
  test("has one production implementation and no legacy fallback", () => {
    expect(existsSync(resolve(uiRoot, "app.js"))).toBe(false);
    expect(existsSync(resolve(uiRoot, "battle-ui-model.mjs"))).toBe(false);
    expect(existsSync(resolve(uiRoot, "i18n.mjs"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "lib/battle-controller.ts"))).toBe(false);
  });

  test("keeps imperative DOM rendering and unsafe type escapes out of production", () => {
    const forbidden = [
      /document\s*\.\s*querySelector(?:All)?\s*\(/,
      /\.\s*innerHTML\s*=/,
      /insertAdjacentHTML\s*\(/,
      /\{@html\b/,
      /\bas\s+any\b/,
      /:\s*any\b/,
      /@ts-ignore/,
      /eslint-disable/,
    ];
    for (const path of sourceFiles(sourceRoot)) {
      const source = readFileSync(path, "utf8");
      for (const pattern of forbidden) expect(source, `${path} contains ${pattern}`).not.toMatch(pattern);
    }
  });

  test("uses a composition root instead of a monolithic copied page", () => {
    const app = readFileSync(resolve(sourceRoot, "App.svelte"), "utf8");
    expect(app.split(/\r?\n/u).length).toBeLessThan(100);
    expect(app).toContain("<BattleBoard {model} />");
    expect(app).toContain("<ActionOrder {model} />");
    expect(app).toContain("<CommandSelection {model} />");
    expect(app).toContain("<PreparationDialog {model} />");
    expect(app).not.toMatch(/import\s*\(/);
  });

  test("enforces strict TypeScript without skipped library checks", () => {
    const config = JSON.parse(readFileSync(resolve(uiRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(config.compilerOptions?.strict).toBe(true);
    expect(config.compilerOptions?.skipLibCheck).not.toBe(true);
  });
});
