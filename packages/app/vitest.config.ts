import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The subpath comes first: an alias key is matched as a prefix, so the
      // bare specifier below would otherwise capture it and resolve to
      // `index.ts/migrate`.
      "@roughdraft/rfm/migrate": fileURLToPath(
        new URL("../rfm/src/migrate.ts", import.meta.url),
      ),
      "@roughdraft/rfm": fileURLToPath(
        new URL("../rfm/src/index.ts", import.meta.url),
      ),
    },
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
