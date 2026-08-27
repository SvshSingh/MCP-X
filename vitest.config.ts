import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/kernel/**/*.ts", "src/llm/**/*.ts", "src/mcp/tools.ts"],
      exclude: [
        // Entry points: side-effectful bootstraps with no logic worth asserting.
        // Their behaviour is covered through the modules they wire together.
        "src/mcp/main.ts",
        "src/cli/**",
      ],
      // Phase 0 acceptance: >=85% on the kernel, held as the surface grows.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
