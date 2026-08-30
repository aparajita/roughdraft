import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The subpath comes first: an alias key is matched as a prefix, so the
      // bare specifier below would otherwise capture it and resolve to
      // `index.ts/migrate`.
      "@roughdraft/rfm/migrate": path.resolve(dirname, "../rfm/src/migrate.ts"),
      "@roughdraft/rfm": path.resolve(dirname, "../rfm/src/index.ts"),
    },
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
