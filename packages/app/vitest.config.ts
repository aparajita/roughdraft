import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // `@roughdraft/rfm` resolves to its TypeScript source through the package's
    // own "development" export condition, so no alias is needed here.
    conditions: ["development"],
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/app",
      exclude: [
        "dist/**",
        "test/**",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/types.d.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
  },
});
