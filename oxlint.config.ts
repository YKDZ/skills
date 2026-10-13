import { defineConfig } from "oxlint";

// 可擦除语法由 TypeScript 的 erasableSyntaxOnly 检查。
export default defineConfig({
  options: { typeAware: true },
  categories: { correctness: "error", suspicious: "warn" },
  ignorePatterns: ["skills/**/scripts/vendor/*.mjs"],
});
