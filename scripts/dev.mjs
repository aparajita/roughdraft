import { spawn } from "node:child_process";
import {
  ROUGHDRAFT_DEFAULT_API_PORT,
  ROUGHDRAFT_DEFAULT_PORT,
} from "../packages/server/defaults.mjs";
import {
  removeDevFrontendState,
  writeDevFrontendState,
} from "./dev-frontend-state.mjs";
import { findAvailableLoopbackPort } from "./find-available-loopback-port.mjs";

function spawnPnpm(args, extraEnv = {}) {
  return spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

const appPort = await findAvailableLoopbackPort(
  parseInt(process.env.APP_PORT || String(ROUGHDRAFT_DEFAULT_PORT), 10),
);
let apiPort = await findAvailableLoopbackPort(
  parseInt(process.env.API_PORT || String(ROUGHDRAFT_DEFAULT_API_PORT), 10),
);

if (apiPort === appPort) {
  apiPort = await findAvailableLoopbackPort(apiPort + 1);
}

console.log(`Using app port ${appPort}.`);
console.log(`Using API port ${apiPort}.`);
console.log(`Open Roughdraft in dev at http://localhost:${appPort}`);
console.log(
  `Open files directly with http://localhost:${appPort}/?path=/absolute/path/to/file.md`,
);
console.log(
  `API port ${apiPort} is internal; don't use it as the browser URL.`,
);

writeDevFrontendState({ appPort, apiPort, mode: "full-dev" });

const server = spawnPnpm(["--filter", "@roughdraft/server", "dev"], {
  API_PORT: String(apiPort),
});
const app = spawnPnpm(
  [
    "--filter",
    "@roughdraft/app",
    "exec",
    "vite",
    "--host",
    "localhost",
    "--port",
    String(appPort),
    "--strictPort",
  ],
  {
    API_PORT: String(apiPort),
  },
);

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  removeDevFrontendState();

  if (signal) {
    console.log(`\nStopping dev servers (${signal}).`);
  }

  server.kill("SIGTERM");
  app.kill("SIGTERM");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("exit", (code) => {
  removeDevFrontendState();
  if (!shuttingDown) {
    app.kill("SIGTERM");
    process.exit(code ?? 0);
  }
});

app.on("exit", (code) => {
  removeDevFrontendState();
  if (!shuttingDown) {
    server.kill("SIGTERM");
    process.exit(code ?? 0);
  }
});
