import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 80,
  sortImports: true,
  ignorePatterns: [
    "skills/**/scripts/vendor/*.mjs",
    "skills/**/scripts/vendor/*.SOURCE.json",
    "skills/**/scripts/vendor/*.LICENSE",
    "pnpm-lock.yaml",
  ],
});
