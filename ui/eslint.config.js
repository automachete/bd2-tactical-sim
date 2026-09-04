import eslint from "@eslint/js";
import globals from "globals";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.ts", "**/*.svelte"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        extraFileExtensions: [".svelte"],
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-explicit-any": "error",
      "svelte/no-at-html-tags": "error"
    }
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".svelte"],
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
