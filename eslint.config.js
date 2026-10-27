import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/", "**/public/", ".claude/", ".data/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.js",
            "packages/web/vitest.config.ts",
            "packages/cli/sesh.mjs",
            "packages/web/cli/sesh.mjs",
            "packages/cli/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // An async function with no await is how we satisfy interfaces that return promises.
    rules: { "@typescript-eslint/require-await": "off" },
  },
  { files: ["packages/web/client/**"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.js", "**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },
  // Last, so it turns off any rule that would fight Prettier's formatting.
  prettier,
);
