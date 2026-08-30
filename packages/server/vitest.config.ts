import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `@roughdraft/rfm` resolves to its TypeScript source through the package's
    // own "development" export condition, so no alias is needed here.
    conditions: ["development"],
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/server",
      exclude: ["dist/**", "src/**/*.test.ts", "defaults.d.mts"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
