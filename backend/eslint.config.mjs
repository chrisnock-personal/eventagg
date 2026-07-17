import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // This codebase uses `any` deliberately in many places (route
      // handlers, dynamic query results) — not something this lint step
      // is meant to eliminate.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // False-positives on the `$${i++}` sequential-SQL-placeholder idiom
      // used throughout eventService.ts — the rule flags the last i++/i+=N
      // in a branch since the post-increment value isn't read again within
      // that branch, but the increment's side effect (numbering the next
      // placeholder) is the entire point.
      "no-useless-assignment": "off",
    },
  }
);
