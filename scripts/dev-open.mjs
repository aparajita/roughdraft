#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { sanitizeSuffix } from "./install-dev-cli.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commandName = `roughdraft-dev-${sanitizeSuffix(path.basename(repoRoot))}`;

try {
  execFileSync(commandName, ["open", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (error) {
  if (error.code === "ENOENT") {
    console.error(
      `${commandName} is not installed. Run \`pnpm dev:install-cli\` first.`,
    );
    process.exit(1);
  }

  process.exit(error.status ?? 1);
}
