import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // client/ and server/ are the pre-orchestrator MCP-X demo, still plain JS.
    // They get ported into src/mcp/ and src/llm/ in Phase 2.
    ignores: [
      "client/**",
      "server/**",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "runs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
