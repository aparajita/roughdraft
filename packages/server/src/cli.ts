import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  parseDocument,
  type RfmDiagnostic,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import { migrateCriticMarkup } from "@roughdraft/rfm/migrate";
import {
  ROUGHDRAFT_BIND_HOST,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
} from "./network.js";
import { findAvailablePort } from "./ports.js";
import { resolveUpdateStatus, type UpdateStatus } from "./update-status.js";

const AGENT_SETUP_URL = "https://roughdraft.md/setup.md";
const ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL =
  "https://roughdraft.md/spec/roughdraft-flavored-markdown.md";
const AGENT_SETUP_PROMPT = `Install Roughdraft for me using \`npm i -g roughdraft\`, then read ${AGENT_SETUP_URL} and set yourself up to use it.`;
const STATUS_PATH = "/api/status";
const STATUS_TIMEOUT_MS = 750;
const SERVER_WAIT_ATTEMPTS = 40;
const SERVER_WAIT_DELAY_MS = 150;
const PROCESS_WAIT_ATTEMPTS = 20;
const PROCESS_WAIT_DELAY_MS = 150;
// Per-poll bound the CLI requests when waiting indefinitely for "Done
// Reviewing". The server clamps each watch to its own maximum, so this is large
// enough that re-issues are rare; node:http imposes no client-side headers
// timeout, so the loop re-polls cleanly until a real event arrives.
export const WATCH_POLL_REISSUE_SECONDS = 1800;
// Client-side safety bound added on top of an explicit --timeout so the command
// cannot hang if the server never responds.
const WATCH_EXPLICIT_TIMEOUT_GRACE_SECONDS = 5;
const USAGE_ERROR = 2;
const KNOWN_COMMANDS = [
  "open",
  "start",
  "status",
  "stop",
  "watch",
  "mcp",
  "doctor",
  "help",
  "agent-setup",
  "format",
  "migrate",
] as const;

export interface RoughdraftServerState {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

interface StatusPayload {
  backend?: string;
  pid?: number;
  projectDir?: string;
  serverRoot?: string;
  port?: number;
}

interface DevFrontendState {
  apiPort: number | null;
  appPort: number;
  mode?: "full-dev" | "preview-web";
  repoRoot: string;
  startedAt: string;
  url: string;
}

interface LiveDevFrontend {
  frontendUrl: string;
  apiUrl: string | null;
}

export interface SpawnedServer {
  pid: number;
}

interface ReviewWatchRequestBody {
  projectPath: string;
  path: string;
  batchWindowSeconds: number;
  fromNow: boolean;
  timeoutSeconds?: number;
}

interface ReviewWatchPayload {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence?: number;
}

interface ReviewWatchResult {
  ok: boolean;
  status: number;
  payload: ReviewWatchPayload;
}

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  pollReviewEvents: (
    url: URL,
    body: ReviewWatchRequestBody,
    options?: { timeoutMs?: number },
  ) => Promise<ReviewWatchResult>;
  findAvailablePortImpl: typeof findAvailablePort;
  sleepImpl: (ms: number) => Promise<void>;
  spawnServerProcess: (options: {
    port: number;
    projectDir: string;
  }) => Promise<SpawnedServer> | SpawnedServer;
  isProcessRunning: (pid: number) => boolean;
  stopProcess: (pid: number) => Promise<void>;
  openUrl: (url: string) => OpenMode;
  resolveUpdateStatus: () => Promise<UpdateStatus>;
  /**
   * Put `text` on standard output exactly as given. This is the sink for output
   * whose bytes are the result — a document a caller pipes into a diff — where
   * the line `log` ends would be a byte the real file does not carry.
   */
  write: (text: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

type OpenMode =
  | "browser"
  | "chrome-app"
  | "disabled"
  | "existing-window"
  | "none";

interface EnsureRunningResult {
  server: {
    port: number;
    url: string;
    tracked: boolean;
    pid: number | null;
    startedAt: string | null;
  };
  reused: boolean;
  portChanged: boolean;
}

interface ResolvedTargetPath {
  projectDir: string;
  openPath: string;
}

interface ReusableServer {
  port: number;
  url: string;
  tracked: boolean;
  pid: number | null;
  startedAt: string | null;
}

type KnownCommand = (typeof KNOWN_COMMANDS)[number];

interface ParsedGlobalFlags {
  help: boolean;
  json: boolean;
  noColor: boolean;
  version: boolean;
}

interface ParsedCli {
  command: string | null;
  global: ParsedGlobalFlags;
  rest: string[];
}

interface ParsedCommandOptions {
  all: boolean;
  batchWindowSeconds: number;
  dryRun: boolean;
  help: boolean;
  json: boolean;
  noOpen: boolean;
  noWatch: boolean;
  printUrl: boolean;
  port?: string;
  replay: boolean;
  stateDir?: string;
  stateFile?: string;
  timeoutSeconds?: number;
  watch: boolean;
  positionals: string[];
}

interface ParsedWatchOptions {
  batchWindowSeconds: number;
  help: boolean;
  json: boolean;
  positionals: string[];
  replay: boolean;
  serverUrl?: string;
  stateDir?: string;
  stateFile?: string;
  timeoutSeconds?: number;
}

const currentServerRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(currentServerRoot, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {}

  return "0.0.0";
}

function emitJson(log: (message: string) => void, value: unknown) {
  log(JSON.stringify(value, null, 2));
}

function parseGlobalArgs(args: string[]): ParsedCli {
  const global: ParsedGlobalFlags = {
    help: false,
    json: false,
    noColor: false,
    version: false,
  };
  const rest = [...args];
  const commandParts: string[] = [];

  while (rest.length > 0) {
    const arg = rest.shift();
    if (!arg) break;

    if (arg === "--") {
      commandParts.push(...rest);
      break;
    }

    if (arg === "-h" || arg === "--help") {
      global.help = true;
      continue;
    }

    if (arg === "--version") {
      global.version = true;
      continue;
    }

    if (arg === "--json") {
      global.json = true;
      continue;
    }

    if (arg === "--no-color") {
      global.noColor = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    commandParts.push(arg, ...rest);
    break;
  }

  const [command, ...commandRest] = commandParts;
  return {
    command: command ?? null,
    global,
    rest: commandRest,
  };
}

function takeFlagValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }

  return { value, nextIndex: index + 1 };
}

function parseCommandOptions(
  args: string[],
  options: {
    allowAll?: boolean;
    allowDryRun?: boolean;
    allowOpen?: boolean;
    allowPort?: boolean;
    allowWatch?: boolean;
  },
): ParsedCommandOptions {
  const parsed: ParsedCommandOptions = {
    all: false,
    batchWindowSeconds: 0.25,
    dryRun: false,
    help: false,
    json: false,
    noOpen: false,
    noWatch: false,
    positionals: [],
    printUrl: false,
    replay: false,
    watch: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--all") {
      if (!options.allowAll) throw new Error(`Unknown flag: ${arg}`);
      parsed.all = true;
      continue;
    }

    if (arg === "--dry-run") {
      if (!options.allowDryRun) throw new Error(`Unknown flag: ${arg}`);
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--no-open") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--print-url") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      parsed.printUrl = true;
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--watch") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.watch = true;
      continue;
    }

    if (arg === "--no-watch") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.noWatch = true;
      continue;
    }

    if (arg === "--replay") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.replay = true;
      continue;
    }

    if (arg === "--timeout") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.timeoutSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      if (!options.allowWatch) throw new Error(`Unknown flag: --timeout`);
      parsed.timeoutSeconds = parsePositiveNumber(
        arg.slice("--timeout=".length),
        "--timeout",
      );
      continue;
    }

    if (arg === "--batch-window") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.batchWindowSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--batch-window=")) {
      if (!options.allowWatch) throw new Error(`Unknown flag: --batch-window`);
      parsed.batchWindowSeconds = parsePositiveNumber(
        arg.slice("--batch-window=".length),
        "--batch-window",
      );
      continue;
    }

    if (arg === "--port") {
      if (!options.allowPort) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.port = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--port=")) {
      if (!options.allowPort) throw new Error(`Unknown flag: --port`);
      parsed.port = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--state-file") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateFile = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      parsed.stateFile = arg.slice("--state-file=".length);
      continue;
    }

    if (arg === "--state-dir") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateDir = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-dir=")) {
      parsed.stateDir = arg.slice("--state-dir=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function applyCliEnvOverrides(
  deps: CliDependencies,
  options: ParsedCommandOptions,
): CliDependencies {
  return {
    ...deps,
    env: {
      ...deps.env,
      ...(options.port ? { ROUGHDRAFT_PORT: options.port } : {}),
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
}

function parseWatchOptions(args: string[]): ParsedWatchOptions {
  const parsed: ParsedWatchOptions = {
    batchWindowSeconds: 0.25,
    help: false,
    json: false,
    positionals: [],
    replay: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--replay") {
      parsed.replay = true;
      continue;
    }

    if (arg === "--timeout") {
      const next = takeFlagValue(args, index, arg);
      parsed.timeoutSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      parsed.timeoutSeconds = parsePositiveNumber(
        arg.slice("--timeout=".length),
        "--timeout",
      );
      continue;
    }

    if (arg === "--batch-window") {
      const next = takeFlagValue(args, index, arg);
      parsed.batchWindowSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--batch-window=")) {
      parsed.batchWindowSeconds = parsePositiveNumber(
        arg.slice("--batch-window=".length),
        "--batch-window",
      );
      continue;
    }

    if (arg === "--state-file") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateFile = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      parsed.stateFile = arg.slice("--state-file=".length);
      continue;
    }

    if (arg === "--state-dir") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateDir = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-dir=")) {
      parsed.stateDir = arg.slice("--state-dir=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function applyWatchEnvOverrides(
  deps: CliDependencies,
  options: ParsedWatchOptions,
): CliDependencies {
  return {
    ...deps,
    env: {
      ...deps.env,
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
}

function isKnownCommand(value: string): value is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

function isPathLikeInput(value: string): boolean {
  return (
    value.toLowerCase().endsWith(".md") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    current[0] = aIndex;
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        previous[bIndex] + 1,
        current[bIndex - 1] + 1,
        previous[bIndex - 1] + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length] ?? 0;
}

function suggestCommand(command: string): string | null {
  const suggestion = KNOWN_COMMANDS.map((candidate) => ({
    candidate,
    distance: levenshteinDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance)[0];

  return suggestion && suggestion.distance <= 3 ? suggestion.candidate : null;
}

type SpawnSyncCommand = typeof spawnSync;
type OpenDetachedCommand = typeof openDetached;

function hasChromeAppMode(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
) {
  if (platform !== "darwin") return false;
  return (
    spawnSyncCommand("open", ["-Ra", "Google Chrome"], {
      stdio: "ignore",
    }).status === 0
  );
}

function openDetached(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function resolveDefaultBrowserBundleId(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
): string | null {
  if (platform !== "darwin") return null;

  const result = spawnSyncCommand(
    "plutil",
    [
      "-extract",
      "LSHandlers",
      "json",
      "-o",
      "-",
      path.join(
        os.homedir(),
        "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0) return null;

  try {
    const handlers = JSON.parse(result.stdout) as Array<{
      LSHandlerRoleAll?: string;
      LSHandlerURLScheme?: string;
    }>;
    return (
      handlers
        .find((handler) => handler.LSHandlerURLScheme === "http")
        ?.LSHandlerRoleAll?.trim()
        .toLowerCase() ?? null
    );
  } catch {
    return null;
  }
}

function isChromeBundleId(bundleId: string | null): boolean {
  return bundleId === "com.google.chrome";
}

export function createDefaultOpenUrl({
  env = process.env,
  platform = process.platform,
  spawnSyncCommand = spawnSync,
  openDetachedCommand = openDetached,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSyncCommand?: SpawnSyncCommand;
  openDetachedCommand?: OpenDetachedCommand;
} = {}): (url: string) => OpenMode {
  return (url: string) => {
    if (env.ROUGHDRAFT_NO_OPEN === "1") {
      return "disabled";
    }

    if (
      isChromeBundleId(
        resolveDefaultBrowserBundleId(platform, spawnSyncCommand),
      )
    ) {
      if (hasChromeAppMode(platform, spawnSyncCommand)) {
        openDetachedCommand("open", [
          "-na",
          "Google Chrome",
          "--args",
          `--app=${url}`,
        ]);
        return "chrome-app";
      }
    }

    if (platform === "darwin") {
      openDetachedCommand("open", [url]);
      return "browser";
    }

    if (platform === "linux") {
      openDetachedCommand("xdg-open", [url]);
      return "browser";
    }

    if (platform === "win32") {
      openDetachedCommand("cmd", ["/c", "start", "", url]);
      return "browser";
    }

    return "none";
  };
}

function defaultOpenUrl(url: string): OpenMode {
  return createDefaultOpenUrl()(url);
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function defaultStopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    if (!defaultIsProcessRunning(pid)) {
      return;
    }
    await sleep(PROCESS_WAIT_DELAY_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function defaultSpawnServerProcess(options: {
  port: number;
  projectDir: string;
}): SpawnedServer {
  const serverEntryPath = fileURLToPath(new URL("./child.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      serverEntryPath,
      "--port",
      String(options.port),
      "--project-dir",
      options.projectDir,
    ],
    {
      cwd: options.projectDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to start Roughdraft in the background.");
  }

  return { pid: child.pid };
}

// Long-poll the review-events watch endpoint over node:http instead of undici's
// global fetch. The server holds the request open until a review.completed event
// arrives or its own bound elapses; undici enforces a ~300s headers timeout that
// fires mid-poll (UND_ERR_HEADERS_TIMEOUT) before the user clicks "Done
// Reviewing", whereas node:http imposes no client-side headers timeout.
function defaultPollReviewEvents(
  url: URL,
  body: ReviewWatchRequestBody,
  options: { timeoutMs?: number } = {},
): Promise<ReviewWatchResult> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          let payload: ReviewWatchPayload;
          try {
            payload = text ? (JSON.parse(text) as ReviewWatchPayload) : {};
          } catch {
            reject(
              new Error(`Unexpected watch response: ${text.slice(0, 200)}`),
            );
            return;
          }
          resolve({ ok: status >= 200 && status < 300, status, payload });
        });
      },
    );
    request.on("error", reject);
    // Only the explicit --timeout path arms a client-side bound; the indefinite
    // poll relies on the server's own bound and re-issues.
    if (options.timeoutMs !== undefined) {
      request.setTimeout(options.timeoutMs, () => {
        request.destroy(new Error("Watch request timed out"));
      });
    }
    request.end(data);
  });
}

export function createCliDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const fetchImpl = overrides.fetchImpl ?? fetch;

  return {
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl,
    pollReviewEvents: overrides.pollReviewEvents ?? defaultPollReviewEvents,
    findAvailablePortImpl: overrides.findAvailablePortImpl ?? findAvailablePort,
    sleepImpl: overrides.sleepImpl ?? ((ms) => sleep(ms)),
    spawnServerProcess:
      overrides.spawnServerProcess ?? defaultSpawnServerProcess,
    isProcessRunning: overrides.isProcessRunning ?? defaultIsProcessRunning,
    stopProcess: overrides.stopProcess ?? defaultStopProcess,
    openUrl: overrides.openUrl ?? defaultOpenUrl,
    resolveUpdateStatus:
      overrides.resolveUpdateStatus ??
      (() => resolveUpdateStatus({ fetchImpl })),
    write:
      overrides.write ??
      ((text) => {
        process.stdout.write(text);
      }),
    log: overrides.log ?? ((message) => console.log(message)),
    error: overrides.error ?? ((message) => console.error(message)),
  };
}

async function printUpdateNoticeIfAvailable(deps: CliDependencies) {
  try {
    const updateStatus = await deps.resolveUpdateStatus();
    if (!updateStatus.updateAvailable) return;

    deps.log(
      `Roughdraft update available: ${updateStatus.currentVersion} -> ${updateStatus.latestVersion}. Run \`${updateStatus.updateCommand}\` to update.`,
    );
  } catch {}
}

function printHelp(log: (message: string) => void) {
  log("Roughdraft is a local Markdown review app for AI-assisted workflows.");
  log("");
  log("Usage:");
  log("  roughdraft [flags] <command> [args]");
  log("  roughdraft <path>");
  log("");
  log("Commands:");
  log("  open <path>        Open a Markdown file and wait for Done Reviewing");
  log("  start              Start or reuse the background server");
  log("  status             Show server status");
  log("  stop               Stop the managed background server");
  log("  watch <path>       Wait for a Done Reviewing event");
  log("  mcp                Start the experimental stdio MCP server");
  log("  doctor [path]      Diagnose setup or validate Markdown");
  log(
    "  migrate <path>     Convert a CriticMarkup document to Roughdraft Flavored Markdown",
  );
  log("  help agent         Print the agent setup prompt");
  log("  help format        Show Roughdraft Flavored Markdown examples");
  log("  agent-setup        Print the agent setup prompt");
  log("  format             Show Roughdraft Flavored Markdown examples");
  log("");
  log("Flags:");
  log("  -h, --help         Show help");
  log("  --version          Print version");
  log("  --json             Print JSON for supported commands");
  log("  --no-color         Disable color");
  log("");
  log("Examples:");
  log("  roughdraft open ./draft.md");
  log("  roughdraft open ./draft.md --print-url");
  log("  roughdraft open ./draft.md --json");
  log("  roughdraft open ./draft.md --no-watch");
  log("  roughdraft watch ./draft.md --json");
  log("  roughdraft status --json");
  log("");
  log(`Agent setup: ${AGENT_SETUP_URL}`);
  log("Use `roughdraft help agent` for a copyable setup prompt.");
}

function printCommandHelp(
  command: KnownCommand,
  log: (message: string) => void,
) {
  if (command === "open") {
    log("Usage:");
    log(
      "  roughdraft open <path> [--no-open] [--no-watch] [--print-url] [--port <port>]",
    );
    log("");
    log(
      "Opens one Markdown file and waits for Done Reviewing. Starts Roughdraft if needed.",
    );
    log("");
    log("Flags:");
    log(
      "  --no-open            Start/reuse the server without opening a browser",
    );
    log(
      "  --print-url          Print only the document URL and do not open it",
    );
    log("  --no-watch           Open the file without waiting");
    log("  --timeout <seconds>  Maximum watch time; omitted means no timeout");
    log("  --replay             Allow watch to return retained older events");
    log("  --json               Print machine-readable output");
    log("  --port <port>        Preferred server port");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    log("");
    log("Environment variables:");
    log(
      "  ROUGHDRAFT_HOST       Route open through a hosted Roughdraft instance",
    );
    log("                        (remote mode). The CLI registers a session,");
    log("                        opens an SSE channel, and writes save events");
    log("                        back to disk.");
    log(
      "  ROUGHDRAFT_TOKEN      Bearer token sent on remote-document requests.",
    );
    log("                        Required when the hosted server binds to a");
    log("                        non-loopback host. Must match the value the");
    log("                        hosted server was started with.");
    log("  ROUGHDRAFT_NO_OPEN    Set to 1 to suppress browser launch.");
    log("  ROUGHDRAFT_BIND_HOST  Comma-separated bind hosts for the hosted");
    log(
      "                        server (default: loopback). Set to 0.0.0.0 or",
    );
    log("                        a Tailscale interface to expose remotely.");
    log("                        Requires ROUGHDRAFT_TOKEN.");
    return;
  }

  if (command === "start") {
    log("Usage:");
    log("  roughdraft start [--port <port>] [--json]");
    log("");
    log("Starts or reuses the background Roughdraft server.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --port <port>        Preferred server port");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "status") {
    log("Usage:");
    log("  roughdraft status [--json]");
    log("");
    log("Shows whether Roughdraft is running.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "stop") {
    log("Usage:");
    log("  roughdraft stop [--all]");
    log("");
    log("Stops the managed background Roughdraft server.");
    log("");
    log("Flags:");
    log(
      "  --all                Also stop a confidently detected unmanaged server",
    );
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "watch") {
    log("Usage:");
    log("  roughdraft watch <path> [--json] [--timeout <seconds>]");
    log("");
    log(
      "Waits until Roughdraft receives Done Reviewing for one Markdown file.",
    );
    log("");
    log("Flags:");
    log("  --json                    Print machine-readable output");
    log(
      "  --timeout <seconds>       Maximum wait time; omitted means no timeout",
    );
    log(
      "  --batch-window <seconds>  Small event batching window, default 0.25",
    );
    log(
      "  --replay                  Return retained older events if available",
    );
    log("  --state-file <path>       Server state file");
    log("  --state-dir <dir>         Directory containing server.json");
    return;
  }

  if (command === "mcp") {
    log("Usage:");
    log("  roughdraft mcp");
    log("");
    log("Starts Roughdraft's experimental stdio MCP server.");
    return;
  }

  if (command === "doctor") {
    log("Usage:");
    log("  roughdraft doctor [path] [--json]");
    log("");
    log(
      "Diagnoses local Roughdraft setup and server state, or validates one Markdown file.",
    );
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "migrate") {
    log("Usage:");
    log("  roughdraft migrate <path> [--dry-run] [--json]");
    log("");
    log(
      "Converts CriticMarkup markers and their metadata into Roughdraft Flavored Markdown anchors and endmatter records, rewriting the file in place.",
    );
    log("");
    log(
      "Refuses a file holding no CriticMarkup comment or suggestion, and one already carrying a `roughdraft` endmatter key, leaving it untouched.",
    );
    log("");
    log("Flags:");
    log("  --dry-run            Print the converted document without writing");
    log("  --json               Print machine-readable output");
    return;
  }

  if (command === "help") {
    printHelp(log);
    return;
  }

  if (command === "agent-setup") {
    printAgentHelp(log);
    return;
  }

  printFormatHelp(log);
}

function printAgentHelp(log: (message: string) => void) {
  log("To set up your coding agent, paste this into it:");
  log("");
  log(AGENT_SETUP_PROMPT);
  log("");
  log(`Live setup instructions: ${AGENT_SETUP_URL}`);
  log("");
  log(
    "This command only prints setup text. It does not edit agent instruction files.",
  );
}

function printFormatHelp(log: (message: string) => void) {
  log("Roughdraft Flavored Markdown reference:");
  log('  <span id="rd-c1">text</span>      Comment anchored to inline text');
  log('  <span id="rd-c2"></span>          Comment anchored to a point');
  log('  <ins id="rd-s1">new text</ins>    Suggested insertion');
  log('  <del id="rd-s2">old text</del>    Suggested deletion');
  log(
    '  <span id="rd-s3"><del>old</del><ins>new</ins></span>   Suggested replacement',
  );
  log("");
  log("Example document:");
  log('  Ship <span id="rd-c1">guest checkout</span> in the beta.');
  log("");
  log('  Add <ins id="rd-s1">one concrete example</ins> before the close.');
  log("");
  log("  ---");
  log('  roughdraft: "1.0"');
  log("  comments:");
  log("    rd-c1:");
  log("      body: Confirm this excludes SSO-only workspaces.");
  log("      by: AI");
  log('      at: "2026-08-28T12:00:00.000Z"');
  log("    rd-c2:");
  log("      body: Confirmed. SSO-only workspaces are out of the beta.");
  log("      by: user");
  log('      at: "2026-08-28T12:05:00.000Z"');
  log("      re: rd-c1");
  log("  suggestions:");
  log("    rd-s1:");
  log("      by: AI");
  log('      at: "2026-08-28T12:07:00.000Z"');
  log("");
  log("Records:");
  log(
    "  Every comment, reply and suggestion lives in the final YAML block whose first key is `roughdraft`.",
  );
  log(
    "  A comment needs `body`, `by` and `at`; a reply adds `re: <parent-id>`.",
  );
  log("  A suggestion needs `by` and `at`.");
  log(
    "  A suggestion record never records the operation — the anchor element does.",
  );
  log("");
  log("Allocating an id:");
  log(
    "  Take the highest number of that kind across both the body anchors and the endmatter keys, and add one.",
  );
  log(
    "  Comments and suggestions are numbered separately: `rd-c1`, `rd-c2`; `rd-s1`, `rd-s2`.",
  );
  log("");
  log("Code:");
  log(
    "  An anchor inside an inline code span or fenced code block is literal text under ordinary CommonMark rules.",
  );
  log("");
  log("Full spec:");
  log(`  ${ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL}`);
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ROUGHDRAFT_DEFAULT_PORT;
}

function getPreferredPort(env: NodeJS.ProcessEnv): number {
  return parsePort(env.ROUGHDRAFT_PORT || env.PORT);
}

function buildPublicBaseUrl(port: number): string {
  return `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
}

function getDevFrontendStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_DEV_FRONTEND_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  return path.join(currentServerRoot, ".context", "dev-frontend.json");
}

function buildLoopbackUrl(host: string, port: number, pathname = "/"): URL {
  const baseHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${baseHost}:${port}${pathname}`);
}

function buildTargetUrl(baseUrl: string, openPath: string): string {
  const url = new URL(baseUrl);

  url.pathname = "/";
  url.searchParams.set("path", openPath);
  return url.toString();
}

interface SseEvent {
  event: string;
  data: string;
}

interface ParsedSseChunk {
  events: SseEvent[];
  remainder: string;
}

function parseSseEvents(buffer: string): ParsedSseChunk {
  // Normalize CRLF to LF up front so the rest of the parser can treat \n
  // as the only line terminator. SSE allows \r\n; some proxies rewrite it.
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: SseEvent[] = [];
  let cursor = 0;
  while (true) {
    const blank = normalized.indexOf("\n\n", cursor);
    if (blank === -1) break;
    const block = normalized.slice(cursor, blank);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
    cursor = blank + 2;
  }
  return { events, remainder: normalized.slice(cursor) };
}

type RemoteSaveResult = { saved: true } | { saved: false; codes: string[] };

/**
 * Replace `targetPath` with Markdown a remote host sent, or refuse it.
 *
 * These bytes are another machine's, so they are read before they are written:
 * Markdown the parser rejects is not what this application serializes, and
 * putting it on the file would destroy the review layer the local file does
 * have. The write itself lands whole through a rename, so a file is never left
 * half replaced.
 *
 * A refusal comes back with the codes of the errors that caused it. Writing
 * remote bytes without this reading is not reachable: this is the only writer
 * of the relayed document.
 */
async function saveRemoteMarkdown(
  targetPath: string,
  markdown: string,
): Promise<RemoteSaveResult> {
  const codes = [
    ...new Set(
      parseDocument(markdown)
        .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.code),
    ),
  ];
  if (codes.length > 0) return { saved: false, codes };

  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, markdown);
  await fs.promises.rename(tmpPath, targetPath);
  return { saved: true };
}

function appendTokenToViewerUrl(viewerUrl: string, token: string): string {
  if (token.length === 0) return viewerUrl;
  try {
    const parsed = new URL(viewerUrl);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    // Fall back to a simple suffix if the URL is malformed; the browser will
    // reject it the same way it would have without the token.
    const separator = viewerUrl.includes("?") ? "&" : "?";
    return `${viewerUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

interface RemoteOpenOptions {
  host: string;
  openPath: string;
  noOpen: boolean;
  printUrl: boolean;
  json: boolean;
}

async function runRemoteOpen(
  deps: CliDependencies,
  options: RemoteOpenOptions,
): Promise<number> {
  const baseUrl = options.host.replace(/\/$/, "");
  const remoteToken =
    typeof deps.env.ROUGHDRAFT_TOKEN === "string"
      ? deps.env.ROUGHDRAFT_TOKEN.trim()
      : "";
  const authHeaders: Record<string, string> =
    remoteToken.length > 0 ? { Authorization: `Bearer ${remoteToken}` } : {};

  let content: string;
  try {
    content = await fs.promises.readFile(options.openPath, "utf-8");
  } catch (error) {
    deps.error(
      error instanceof Error
        ? error.message
        : `Could not read ${options.openPath}`,
    );
    return 1;
  }

  const sessionId = crypto.randomUUID();

  const REGISTER_TIMEOUT_MS = 10_000;
  let registerResponse: Response;
  try {
    registerResponse = await deps.fetchImpl(`${baseUrl}/api/remote-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        sessionId,
        originPath: options.openPath,
        content,
      }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
  } catch (error) {
    deps.error(
      `Could not register remote session at ${baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (!registerResponse.ok) {
    if (registerResponse.status === 401) {
      deps.error(
        `Remote host rejected the session register (HTTP 401). Set ROUGHDRAFT_TOKEN to the token configured on the host before retrying.`,
      );
    } else {
      deps.error(
        `Remote host rejected the session register (HTTP ${registerResponse.status}).`,
      );
    }
    return 1;
  }

  const registerPayload = (await registerResponse.json()) as {
    id?: string;
    version?: string;
    viewerUrl?: string;
  };

  // The browser viewer must include the same token so its fetches and
  // EventSource connection authenticate. The server's viewerUrl response field
  // is unaware of the token (it doesn't see secrets in plaintext over the wire
  // unless we add them); the CLI knows the token and can append it.
  const baseViewer =
    typeof registerPayload.viewerUrl === "string"
      ? registerPayload.viewerUrl
      : `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
  const viewerUrl = appendTokenToViewerUrl(baseViewer, remoteToken);

  if (options.printUrl) {
    deps.log(viewerUrl);
    return 0;
  }

  if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
    deps.openUrl(viewerUrl);
  }

  if (options.json) {
    emitJson(deps.log, {
      opened: true,
      mode: "remote",
      sessionId,
      url: viewerUrl,
      host: baseUrl,
      path: options.openPath,
    });
  } else {
    deps.log(`Opened remote Roughdraft session: ${viewerUrl}`);
    deps.log(`Holding session open for ${options.openPath}. Ctrl-C to exit.`);
  }

  const SSE_CONNECT_TIMEOUT_MS = 10_000;
  const eventsUrl = new URL(
    `/api/remote-document/${encodeURIComponent(sessionId)}/events`,
    baseUrl,
  );
  eventsUrl.searchParams.set("role", "cli");

  let eventsResponse: Response;
  try {
    eventsResponse = await deps.fetchImpl(eventsUrl.toString(), {
      headers: { Accept: "text/event-stream", ...authHeaders },
      signal: AbortSignal.timeout(SSE_CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    deps.error(
      `Lost connection to remote host: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (!eventsResponse.ok || !eventsResponse.body) {
    deps.error(
      `Could not open remote event stream (HTTP ${eventsResponse.status}).`,
    );
    return 1;
  }

  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        if (event.event === "save") {
          let payload: { content?: unknown } = {};
          try {
            payload = JSON.parse(event.data) as { content?: unknown };
          } catch {
            continue;
          }
          if (typeof payload.content === "string") {
            try {
              const result = await saveRemoteMarkdown(
                options.openPath,
                payload.content,
              );
              if (!result.saved) {
                deps.error(
                  `Refused a remote save of ${options.openPath}: the document does not parse (${result.codes.join(", ")}).`,
                );
              } else if (!options.json) {
                deps.log(`Saved ${options.openPath} from remote.`);
              }
            } catch (error) {
              deps.error(
                `Failed to write ${options.openPath}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be in an errored state; ignore.
    }
  }

  if (!options.json) {
    deps.log("Remote session disconnected.");
  }
  return 0;
}

async function sendOpenRequestToExistingWindow(
  deps: CliDependencies,
  baseUrl: string,
  targetUrl: string,
  openPath: string,
): Promise<boolean> {
  try {
    const requestUrl = new URL("/api/open-request", baseUrl);
    const response = await deps.fetchImpl(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: openPath, url: targetUrl }),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { delivered?: unknown };
    return payload.delivered === true;
  } catch {
    return false;
  }
}

function resolveTargetPath(inputPath: string): ResolvedTargetPath {
  const resolvedPath = path.resolve(inputPath);
  const looksLikeMarkdownFile = resolvedPath.toLowerCase().endsWith(".md");

  try {
    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Roughdraft can only open .md files: ${resolvedPath}`);
    }

    if (stat.isFile()) {
      if (!looksLikeMarkdownFile) {
        throw new Error(`Roughdraft can only open .md files: ${resolvedPath}`);
      }

      return {
        projectDir: path.dirname(resolvedPath),
        openPath: resolvedPath,
      };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Roughdraft can only open")
    ) {
      throw error;
    }

    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      throw new Error(`Path not found: ${resolvedPath}`);
    }

    throw new Error(`Failed to read path: ${resolvedPath}`);
  }

  throw new Error(`Unsupported path: ${resolvedPath}`);
}

export function getServerStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const explicitDir = env.ROUGHDRAFT_STATE_DIR?.trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), "server.json");
  }

  return path.join(os.homedir(), ".roughdraft", "server.json");
}

function isValidServerState(value: unknown): value is RoughdraftServerState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<RoughdraftServerState>;
  return (
    typeof candidate.port === "number" &&
    Number.isFinite(candidate.port) &&
    typeof candidate.pid === "number" &&
    Number.isFinite(candidate.pid) &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function isValidDevFrontendState(value: unknown): value is DevFrontendState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<DevFrontendState>;
  return (
    (candidate.apiPort === null ||
      (typeof candidate.apiPort === "number" &&
        Number.isFinite(candidate.apiPort))) &&
    typeof candidate.appPort === "number" &&
    Number.isFinite(candidate.appPort) &&
    (candidate.mode === undefined ||
      candidate.mode === "full-dev" ||
      candidate.mode === "preview-web") &&
    typeof candidate.repoRoot === "string" &&
    candidate.repoRoot.length > 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function readServerStateFromDisk(
  stateFilePath: string,
): RoughdraftServerState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidServerState(parsed)) {
      return parsed;
    }
  } catch {}

  if (fs.existsSync(stateFilePath)) {
    removeServerStateFile(stateFilePath);
  }

  return null;
}

function readDevFrontendStateFromDisk(
  stateFilePath: string,
): DevFrontendState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidDevFrontendState(parsed)) {
      return parsed;
    }
  } catch {}

  return null;
}

function writeServerStateToDisk(
  stateFilePath: string,
  state: RoughdraftServerState,
) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeServerStateFile(stateFilePath: string) {
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {}
}

async function getStatusPayload(
  port: number,
  deps: CliDependencies,
): Promise<StatusPayload | null> {
  for (const host of [ROUGHDRAFT_BIND_HOST, ...ROUGHDRAFT_LOOPBACK_HOSTS]) {
    try {
      const response = await deps.fetchImpl(
        buildLoopbackUrl(host, port, STATUS_PATH),
        {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend === "local-files") {
        return payload;
      }
    } catch {}
  }

  return null;
}

async function waitForServer(port: number, deps: CliDependencies) {
  for (let attempt = 0; attempt < SERVER_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (payload) {
      return payload;
    }
    await deps.sleepImpl(SERVER_WAIT_DELAY_MS);
  }

  throw new Error("Timed out waiting for Roughdraft to start.");
}

async function waitForServerToStop(
  port: number,
  deps: CliDependencies,
): Promise<boolean> {
  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (!payload) {
      return true;
    }

    await deps.sleepImpl(PROCESS_WAIT_DELAY_MS);
  }

  return false;
}

async function resolveLiveDevFrontendBaseUrl(
  deps: CliDependencies,
): Promise<LiveDevFrontend | null> {
  const state = readDevFrontendStateFromDisk(
    getDevFrontendStateFilePath(deps.env),
  );
  if (!state) {
    return null;
  }

  if (path.resolve(state.repoRoot) !== currentServerRoot) {
    return null;
  }

  try {
    const frontendUrl = new URL(state.url);
    const mode =
      state.mode ?? (state.apiPort === null ? "preview-web" : "full-dev");

    if (mode === "preview-web") {
      const response = await deps.fetchImpl(frontendUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }
    } else {
      const statusUrl = new URL("/api/status", frontendUrl);
      const response = await deps.fetchImpl(statusUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend !== "local-files") {
        return null;
      }

      if (
        !payload.serverRoot ||
        path.resolve(payload.serverRoot) !== currentServerRoot
      ) {
        return null;
      }

      if (
        typeof payload.port === "number" &&
        state.apiPort !== null &&
        payload.port !== state.apiPort
      ) {
        return null;
      }
    }

    frontendUrl.pathname = "/";
    frontendUrl.search = "";
    frontendUrl.hash = "";
    return {
      frontendUrl: frontendUrl.toString(),
      apiUrl:
        mode === "full-dev" && state.apiPort !== null
          ? buildPublicBaseUrl(state.apiPort)
          : null,
    };
  } catch {
    return null;
  }
}

async function normalizeTrackedState(
  persistedState: RoughdraftServerState,
  stateFilePath: string,
): Promise<RoughdraftServerState> {
  const normalizedState = {
    ...persistedState,
    url: buildPublicBaseUrl(persistedState.port),
  };

  if (normalizedState.url !== persistedState.url) {
    writeServerStateToDisk(stateFilePath, normalizedState);
  }

  return normalizedState;
}

async function findReusableServer(
  deps: CliDependencies,
  options: { serverRoot?: string } = {},
): Promise<ReusableServer | null> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const expectedServerRoot = path.resolve(
    options.serverRoot ?? currentServerRoot,
  );

  const matchesServerRoot = (payload: StatusPayload | null) =>
    payload?.serverRoot
      ? path.resolve(payload.serverRoot) === expectedServerRoot
      : false;

  if (persistedState) {
    const pidRunning = deps.isProcessRunning(persistedState.pid);
    const statusPayload = await getStatusPayload(persistedState.port, deps);

    if (pidRunning && statusPayload && matchesServerRoot(statusPayload)) {
      const normalizedState = await normalizeTrackedState(
        persistedState,
        stateFilePath,
      );
      return {
        port: normalizedState.port,
        url: normalizedState.url,
        tracked: true,
        pid: normalizedState.pid,
        startedAt: normalizedState.startedAt,
      };
    }

    removeServerStateFile(stateFilePath);

    if (statusPayload && matchesServerRoot(statusPayload)) {
      return {
        port: persistedState.port,
        url: buildPublicBaseUrl(persistedState.port),
        tracked: false,
        pid: null,
        startedAt: null,
      };
    }
  }

  const preferredStatus = await getStatusPayload(preferredPort, deps);
  if (!preferredStatus || !matchesServerRoot(preferredStatus)) {
    return null;
  }

  return {
    port: preferredPort,
    url: buildPublicBaseUrl(preferredPort),
    tracked: false,
    pid: null,
    startedAt: null,
  };
}

export async function readRunningServerState(
  deps: CliDependencies,
): Promise<RoughdraftServerState | null> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (
    !reusableServer?.tracked ||
    reusableServer.pid === null ||
    reusableServer.startedAt === null
  ) {
    return null;
  }

  return {
    port: reusableServer.port,
    pid: reusableServer.pid,
    startedAt: reusableServer.startedAt,
    url: reusableServer.url,
  };
}

export async function ensureServerRunning(
  deps: CliDependencies,
  options: { projectDir?: string } = {},
): Promise<EnsureRunningResult> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (reusableServer) {
    return { server: reusableServer, reused: true, portChanged: false };
  }

  const preferredPort = getPreferredPort(deps.env);
  const port = await deps.findAvailablePortImpl(preferredPort);
  const projectDir = path.resolve(options.projectDir ?? deps.cwd);
  const spawned = await deps.spawnServerProcess({
    port,
    projectDir,
  });

  try {
    await waitForServer(port, deps);
  } catch (error) {
    await deps.stopProcess(spawned.pid);
    throw error;
  }

  const state: RoughdraftServerState = {
    port,
    pid: spawned.pid,
    startedAt: new Date().toISOString(),
    url: buildPublicBaseUrl(port),
  };
  writeServerStateToDisk(getServerStateFilePath(deps.env), state);

  return {
    server: {
      port: state.port,
      url: state.url,
      tracked: true,
      pid: state.pid,
      startedAt: state.startedAt,
    },
    reused: false,
    portChanged: port !== preferredPort,
  };
}

function buildServerStatusJson(
  server: ReusableServer | null,
  stateFilePath: string,
) {
  if (!server) {
    return {
      running: false,
      stateFile: stateFilePath,
    };
  }

  return {
    running: true,
    url: server.url,
    port: server.port,
    pid: server.pid,
    startedAt: server.startedAt,
    stateFile: stateFilePath,
    managed: server.tracked,
  };
}

async function stopTrackedServer(deps: CliDependencies): Promise<{
  persistedState: RoughdraftServerState | null;
  stopped: boolean;
  portIsQuiet: boolean;
  failedPid: number | null;
}> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);

  if (!persistedState) {
    return {
      failedPid: null,
      persistedState: null,
      portIsQuiet: true,
      stopped: false,
    };
  }

  if (deps.isProcessRunning(persistedState.pid)) {
    await deps.stopProcess(persistedState.pid);
  }

  const trackedPidStillRunning = deps.isProcessRunning(persistedState.pid);
  const portIsQuiet = await waitForServerToStop(persistedState.port, deps);

  if (trackedPidStillRunning) {
    writeServerStateToDisk(stateFilePath, {
      ...persistedState,
      url: buildPublicBaseUrl(persistedState.port),
    });
    return {
      failedPid: persistedState.pid,
      persistedState,
      portIsQuiet,
      stopped: false,
    };
  }

  removeServerStateFile(stateFilePath);
  return {
    failedPid: null,
    persistedState,
    portIsQuiet,
    stopped: true,
  };
}

async function runDoctor(
  deps: CliDependencies,
  json: boolean,
): Promise<number> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const preferredStatus = await getStatusPayload(preferredPort, deps);
  const trackedStatus = persistedState
    ? await getStatusPayload(persistedState.port, deps)
    : null;
  const cwdReadable = (() => {
    try {
      fs.accessSync(deps.cwd, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const managedPidRunning = persistedState
    ? deps.isProcessRunning(persistedState.pid)
    : false;
  const serverRootMatches =
    trackedStatus?.serverRoot !== undefined
      ? path.resolve(trackedStatus.serverRoot) === currentServerRoot
      : false;
  const commandPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const devStateDir = deps.env.ROUGHDRAFT_STATE_DIR?.includes(
    `${path.sep}.roughdraft${path.sep}dev${path.sep}`,
  )
    ? path.resolve(deps.env.ROUGHDRAFT_STATE_DIR)
    : null;
  const devWrapperName = deps.env.ROUGHDRAFT_DEV_WRAPPER_NAME?.trim() || null;
  const devWrapperPath = deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH?.trim()
    ? path.resolve(deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH)
    : null;
  const devWrapperRepoRoot =
    deps.env.ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT?.trim() || null;

  const report = {
    packageVersion: readPackageVersion(),
    nodeVersion: process.version,
    commandPath,
    stateFile: stateFilePath,
    stateFileExists: fs.existsSync(stateFilePath),
    managedPid: persistedState?.pid ?? null,
    managedPidRunning,
    recordedPort: persistedState?.port ?? null,
    recordedPortResponds: Boolean(trackedStatus),
    preferredPort,
    preferredPortResponds: Boolean(preferredStatus),
    serverRoot: trackedStatus?.serverRoot ?? null,
    serverRootMatches,
    browserOpeningDisabled: deps.env.ROUGHDRAFT_NO_OPEN === "1",
    cwd: deps.cwd,
    cwdReadable,
    devWrapper:
      devStateDir || devWrapperName || devWrapperPath || devWrapperRepoRoot
        ? {
            commandName: devWrapperName,
            path: devWrapperPath,
            repoRoot: devWrapperRepoRoot,
            repoRootMatches: devWrapperRepoRoot
              ? path.resolve(devWrapperRepoRoot) === currentServerRoot
              : null,
            stateDir: devStateDir,
          }
        : null,
  };

  if (json) {
    emitJson(deps.log, report);
    return 0;
  }

  deps.log(`Package version: ${report.packageVersion}`);
  deps.log(`Node version: ${report.nodeVersion}`);
  deps.log(`Command path: ${report.commandPath ?? "unknown"}`);
  deps.log(`State file: ${report.stateFile}`);
  deps.log(`State file exists: ${report.stateFileExists ? "yes" : "no"}`);
  deps.log(
    `Managed PID: ${
      report.managedPid === null
        ? "none"
        : `${report.managedPid} (${report.managedPidRunning ? "running" : "not running"})`
    }`,
  );
  deps.log(
    `Recorded port: ${
      report.recordedPort === null
        ? "none"
        : `${report.recordedPort} (${report.recordedPortResponds ? "responding" : "not responding"})`
    }`,
  );
  deps.log(
    `Preferred port: ${report.preferredPort} (${report.preferredPortResponds ? "responding" : "not responding"})`,
  );
  deps.log(
    `Server root matches checkout: ${report.serverRootMatches ? "yes" : "no"}`,
  );
  deps.log(
    `Browser opening disabled: ${report.browserOpeningDisabled ? "yes" : "no"}`,
  );
  deps.log(`Current directory readable: ${report.cwdReadable ? "yes" : "no"}`);
  if (report.devWrapper) {
    deps.log(
      `Dev wrapper command: ${report.devWrapper.commandName ?? "unknown"}`,
    );
    deps.log(`Dev wrapper path: ${report.devWrapper.path ?? "unknown"}`);
    deps.log(
      `Dev wrapper repo root: ${report.devWrapper.repoRoot ?? "unknown"}`,
    );
    deps.log(`Dev state dir: ${report.devWrapper.stateDir ?? "unknown"}`);
  }

  return 0;
}

// Reads one Markdown file for a command that works on file contents rather than
// on the running server. Reports the failure itself and yields null so the
// caller returns USAGE_ERROR without restating the message.
function readMarkdownFileForCommand(
  deps: CliDependencies,
  absolutePath: string,
): string | null {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      deps.error(`Path is not a file: ${absolutePath}`);
      return null;
    }
    return fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    deps.error(
      code === "ENOENT"
        ? `Path not found: ${absolutePath}`
        : `Could not read path: ${absolutePath}`,
    );
    return null;
  }
}

// Converts one CriticMarkup document to Roughdraft Flavored Markdown. This is
// the only command that rewrites a user's file, so it refuses anything it is
// not certain about instead of guessing: a non-.md path, an unreadable file, a
// document that already carries a `roughdraft` endmatter key, or a document
// holding no record to convert. A refusal writes nothing and exits
// USAGE_ERROR; a conversion writes the whole file once, or, with --dry-run,
// prints the result and leaves the file untouched.
function runMigrate(
  deps: CliDependencies,
  targetPath: string,
  options: { dryRun: boolean; json: boolean },
): number {
  if (!isMarkdownPath(targetPath)) {
    deps.error(`Roughdraft migrate can only convert .md files: ${targetPath}`);
    return USAGE_ERROR;
  }

  const absolutePath = path.resolve(deps.cwd, targetPath);
  const markdown = readMarkdownFileForCommand(deps, absolutePath);
  if (markdown === null) return USAGE_ERROR;

  // The `roughdraft` endmatter key is the only thing that identifies a document
  // as Roughdraft Flavored Markdown, so the presence test comes from the parser
  // rather than from a heuristic applied here.
  if (parseDocument(markdown).endmatterVersion !== null) {
    deps.error(
      `Already Roughdraft Flavored Markdown, nothing was written: ${absolutePath}`,
    );
    return USAGE_ERROR;
  }

  const migrated = migrateCriticMarkup(markdown);

  // Rewriting a file that holds no record to convert changes no byte of the
  // review layer and still bumps the file's mtime, which wakes every watcher on
  // it. A run with nothing to convert is a refusal, in a dry run too: what the
  // real run would do is refuse, so that is what a preview of it reports. The
  // count is of records, so a stray `{==highlight==}` that no comment follows
  // carries nothing to convert and the document keeps it.
  if (migrated.converted === 0) {
    deps.error(
      `No CriticMarkup comments or suggestions to convert, nothing was written: ${absolutePath}`,
    );
    return USAGE_ERROR;
  }

  if (options.dryRun) {
    if (options.json) {
      emitJson(deps.log, {
        kind: "migrate" as const,
        path: absolutePath,
        dryRun: true,
        converted: migrated.converted,
        diagnostics: migrated.diagnostics,
        markdown: migrated.markdown,
      });
    } else {
      // Standard output carries the converted document and nothing else, so a
      // dry run piped into a diff reports exactly the change the real write
      // makes. Diagnostics go to standard error for the same reason.
      deps.write(migrated.markdown);
      reportMigrateDiagnostics(deps, migrated.diagnostics);
    }
    return 0;
  }

  try {
    fs.writeFileSync(absolutePath, migrated.markdown, "utf8");
  } catch {
    deps.error(`Could not write path: ${absolutePath}`);
    return 1;
  }

  if (options.json) {
    emitJson(deps.log, {
      kind: "migrate" as const,
      path: absolutePath,
      dryRun: false,
      converted: migrated.converted,
      diagnostics: migrated.diagnostics,
    });
  } else {
    deps.log(
      `Converted ${migrated.converted} record(s): ${relativeDisplayPath(deps.cwd, absolutePath)}`,
    );
    reportMigrateDiagnostics(deps, migrated.diagnostics);
  }

  return 0;
}

/**
 * Report what the conversion could not express as written, such as a comment
 * whose highlighted range ran across a block boundary and is now anchored to
 * the part of it within one block. A reviewer who is not told reads a comment
 * that has quietly lost part of what it was attached to.
 */
function reportMigrateDiagnostics(
  deps: CliDependencies,
  diagnostics: readonly RfmDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    deps.error(
      `${diagnostic.severity}: ${formatMarkdownDiagnostic(diagnostic)}`,
    );
  }
}

async function runMarkdownDoctor(
  deps: CliDependencies,
  targetPath: string,
  json: boolean,
): Promise<number> {
  if (!isMarkdownPath(targetPath)) {
    deps.error(`Roughdraft doctor can only validate .md files: ${targetPath}`);
    return USAGE_ERROR;
  }

  const absolutePath = path.resolve(deps.cwd, targetPath);
  const markdown = readMarkdownFileForCommand(deps, absolutePath);
  if (markdown === null) return USAGE_ERROR;

  const validation = validateRoughdraftMarkdown(markdown);
  const payload = {
    kind: "markdown" as const,
    path: absolutePath,
    format: validation.format,
    version: validation.version,
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    summary: validation.summary,
  };

  if (json) {
    emitJson(deps.log, payload);
    return validation.ok ? 0 : 1;
  }

  const displayPath = relativeDisplayPath(deps.cwd, absolutePath);
  deps.log(`Roughdraft Markdown doctor: ${displayPath}`);
  deps.log(`Status: ${validation.ok ? "passed" : "failed"}`);

  if (validation.errors.length > 0) {
    deps.log("");
    deps.log("Errors:");
    for (const diagnostic of validation.errors) {
      deps.log(`  ${formatMarkdownDiagnostic(diagnostic)}`);
    }
  }

  if (validation.warnings.length > 0) {
    deps.log("");
    deps.log("Warnings:");
    for (const diagnostic of validation.warnings) {
      deps.log(`  ${formatMarkdownDiagnostic(diagnostic)}`);
    }
  }

  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    deps.log("");
    deps.log(
      `Found ${validation.summary.comments} comment(s) and ${validation.summary.suggestions} suggestion(s).`,
    );
  }

  return validation.ok ? 0 : 1;
}

async function runWatch(
  deps: CliDependencies,
  targetPath: string,
  options: ParsedWatchOptions,
  json: boolean,
): Promise<number> {
  const target = resolveTargetPath(targetPath);
  let serverUrl = options.serverUrl;
  if (!serverUrl) {
    const result = await ensureServerRunning(deps, {
      projectDir: target.projectDir,
    });
    serverUrl = result.server.url;
  }
  const relativePath = path.relative(target.projectDir, target.openPath);
  const watchUrl = new URL("/api/review-events/watch", serverUrl);
  const baseBody: ReviewWatchRequestBody = {
    projectPath: target.projectDir,
    path: relativePath,
    batchWindowSeconds: options.batchWindowSeconds,
    fromNow: !options.replay,
  };

  // Explicit --timeout: a single bounded poll, surfacing a timeout as a
  // non-zero exit. The client-side bound is a safety net on top of the server's.
  if (options.timeoutSeconds !== undefined) {
    const { ok, status, payload } = await deps.pollReviewEvents(
      watchUrl,
      { ...baseBody, timeoutSeconds: options.timeoutSeconds },
      {
        timeoutMs:
          (options.timeoutSeconds + WATCH_EXPLICIT_TIMEOUT_GRACE_SECONDS) *
          1000,
      },
    );
    if (!ok) {
      throw new Error(`Failed to watch review events: ${status}`);
    }
    return reportWatchPayload(deps, target.openPath, payload, json);
  }

  // No --timeout: wait until "Done Reviewing". Each poll is bounded server-side,
  // so re-issue cleanly whenever the server returns before a real event.
  for (;;) {
    const { ok, status, payload } = await deps.pollReviewEvents(watchUrl, {
      ...baseBody,
      timeoutSeconds: WATCH_POLL_REISSUE_SECONDS,
    });
    if (!ok) {
      throw new Error(`Failed to watch review events: ${status}`);
    }
    if (payload.timedOut) {
      continue;
    }
    return reportWatchPayload(deps, target.openPath, payload, json);
  }
}

function reportWatchPayload(
  deps: CliDependencies,
  openPath: string,
  payload: ReviewWatchPayload,
  json: boolean,
): number {
  if (json) {
    emitJson(deps.log, payload);
    return payload.timedOut ? 1 : 0;
  }

  if (payload.timedOut) {
    deps.log(`No review completed event received for ${openPath}.`);
    return 1;
  }

  deps.log(`Review completed for ${openPath}.`);
  deps.log(`Received ${(payload.events ?? []).length} event(s).`);
  return 0;
}

function isMarkdownPath(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".md";
}

function relativeDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : absolutePath;
}

function formatMarkdownDiagnostic(diagnostic: RfmDiagnostic): string {
  return `${diagnostic.line}:${diagnostic.column}  ${diagnostic.message}`;
}

function getConfidentStopCandidate(
  payload: StatusPayload | null,
): number | null {
  if (
    typeof payload?.pid !== "number" ||
    !Number.isFinite(payload.pid) ||
    payload.pid <= 0 ||
    !payload.serverRoot ||
    path.resolve(payload.serverRoot) !== currentServerRoot
  ) {
    return null;
  }

  return payload.pid;
}

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  let deps = createCliDependencies(overrides);
  let parsed: ParsedCli;
  let shouldPrintUpdateNotice = false;

  try {
    try {
      parsed = parseGlobalArgs(args);
    } catch (error) {
      deps.error(error instanceof Error ? error.message : "Invalid usage.");
      return USAGE_ERROR;
    }

    if (parsed.global.version) {
      deps.log(readPackageVersion());
      return 0;
    }

    if (!parsed.command) {
      printHelp(deps.log);
      return 0;
    }

    if (parsed.command === "help") {
      const [topic, ...extra] = parsed.rest;
      if (extra.length > 0) {
        deps.error("Usage: roughdraft help [agent|format|command]");
        return USAGE_ERROR;
      }

      if (!topic) {
        printHelp(deps.log);
        return 0;
      }

      if (topic === "agent") {
        printAgentHelp(deps.log);
        return 0;
      }

      if (topic === "format") {
        printFormatHelp(deps.log);
        return 0;
      }

      if (isKnownCommand(topic)) {
        printCommandHelp(topic, deps.log);
        return 0;
      }

      deps.error(`Unknown help topic: ${topic}`);
      return USAGE_ERROR;
    }

    let command = parsed.command;
    let rest = parsed.rest;

    if (!isKnownCommand(command)) {
      if (isPathLikeInput(command)) {
        rest = [command, ...rest];
        command = "open";
      } else {
        const suggestion = suggestCommand(command);
        deps.error(
          `Unknown command: ${command}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        );
        return USAGE_ERROR;
      }
    }

    if (parsed.global.help) {
      printCommandHelp(command as KnownCommand, deps.log);
      return 0;
    }

    if (command === "format") {
      shouldPrintUpdateNotice = true;
      printFormatHelp(deps.log);
      return 0;
    }

    if (command === "agent-setup") {
      shouldPrintUpdateNotice = true;
      printAgentHelp(deps.log);
      return 0;
    }

    if (command === "start") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, { allowPort: true });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("start", deps.log);
        return 0;
      }

      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft start [--port <port>] [--json]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const result = await ensureServerRunning(deps);
      if (json) {
        emitJson(deps.log, {
          ...buildServerStatusJson(
            result.server,
            getServerStateFilePath(deps.env),
          ),
          reused: result.reused,
          portChanged: result.portChanged,
        });
        return 0;
      }

      if (result.reused) {
        if (result.server.tracked) {
          deps.log(`Roughdraft is already running at ${result.server.url}`);
        } else {
          deps.log(
            `Roughdraft is already running at ${result.server.url}, but it is not managed by ${getServerStateFilePath(deps.env)}.`,
          );
        }
        return 0;
      }

      if (result.portChanged) {
        deps.log(
          `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`,
        );
      }

      deps.log(`Roughdraft running at ${result.server.url}`);
      return 0;
    }

    if (command === "status") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("status", deps.log);
        return 0;
      }

      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft status [--json]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const server = await findReusableServer(deps);
      if (!server) {
        if (json) {
          emitJson(
            deps.log,
            buildServerStatusJson(null, getServerStateFilePath(deps.env)),
          );
          return 0;
        }

        deps.log(
          "Roughdraft is not running. Start it with `roughdraft start`.",
        );
        return 1;
      }

      if (json) {
        emitJson(
          deps.log,
          buildServerStatusJson(server, getServerStateFilePath(deps.env)),
        );
        return 0;
      }

      deps.log(`Roughdraft is running at ${server.url}`);
      if (server.tracked && server.pid !== null && server.startedAt !== null) {
        deps.log(`PID: ${server.pid}`);
        deps.log(`Started: ${server.startedAt}`);
        deps.log(`State file: ${getServerStateFilePath(deps.env)}`);
      } else {
        deps.log(
          `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
        );
      }
      return 0;
    }

    if (command === "stop") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, { allowAll: true });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("stop", deps.log);
        return 0;
      }

      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft stop [--all]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const stateFilePath = getServerStateFilePath(deps.env);
      const stopResult = await stopTrackedServer(deps);

      if (!stopResult.persistedState) {
        const preferredPort = getPreferredPort(deps.env);
        const unmanagedServer = await getStatusPayload(preferredPort, deps);
        if (unmanagedServer) {
          const candidatePid = options.all
            ? getConfidentStopCandidate(unmanagedServer)
            : null;
          if (candidatePid !== null) {
            await deps.stopProcess(candidatePid);
            const stopped = await waitForServerToStop(preferredPort, deps);
            if (stopped) {
              if (json) {
                emitJson(deps.log, {
                  stopped: true,
                  managed: false,
                  pid: candidatePid,
                  url: buildPublicBaseUrl(preferredPort),
                  stateFile: stateFilePath,
                });
                return 0;
              }

              deps.log(
                `Stopped unmanaged Roughdraft at ${buildPublicBaseUrl(preferredPort)}.`,
              );
              return 0;
            }
          }

          if (json) {
            emitJson(deps.log, {
              stopped: false,
              managed: false,
              url: buildPublicBaseUrl(preferredPort),
              ...(options.all
                ? { reason: "No confident unmanaged process candidate." }
                : {}),
              stateFile: stateFilePath,
            });
            return 1;
          }

          deps.error(
            options.all
              ? `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it could not be matched to a safe process candidate. Stop it manually.`
              : `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it is not managed by ${stateFilePath}. Stop it manually.`,
          );
          return 1;
        }

        if (json) {
          emitJson(deps.log, {
            stopped: false,
            running: false,
            stateFile: stateFilePath,
          });
          return 0;
        }

        deps.log("Roughdraft is not running.");
        return 0;
      }

      if (stopResult.failedPid !== null) {
        if (json) {
          emitJson(deps.log, {
            stopped: false,
            pid: stopResult.failedPid,
            stateFile: stateFilePath,
          });
          return 1;
        }

        deps.error(
          `Failed to stop Roughdraft process ${stopResult.failedPid}.`,
        );
        return 1;
      }

      if (!stopResult.portIsQuiet) {
        if (options.all) {
          const unmanagedServer = await getStatusPayload(
            stopResult.persistedState.port,
            deps,
          );
          const candidatePid = getConfidentStopCandidate(unmanagedServer);
          if (candidatePid !== null) {
            await deps.stopProcess(candidatePid);
            const stopped = await waitForServerToStop(
              stopResult.persistedState.port,
              deps,
            );
            if (stopped) {
              if (json) {
                emitJson(deps.log, {
                  stopped: true,
                  pid: stopResult.persistedState.pid,
                  unmanagedPid: candidatePid,
                  url: buildPublicBaseUrl(stopResult.persistedState.port),
                  stateFile: stateFilePath,
                });
                return 0;
              }

              deps.log(
                `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
              );
              deps.log(`Stopped unmanaged Roughdraft process ${candidatePid}.`);
              return 0;
            }
          }
        }

        if (json) {
          emitJson(deps.log, {
            stopped: true,
            pid: stopResult.persistedState.pid,
            url: buildPublicBaseUrl(stopResult.persistedState.port),
            anotherInstanceRunning: true,
            ...(options.all
              ? { reason: "No confident unmanaged process candidate." }
              : {}),
            stateFile: stateFilePath,
          });
          return 1;
        }

        deps.error(
          `Stopped tracked Roughdraft process ${stopResult.persistedState.pid}, but another Roughdraft instance is still running at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
        );
        return 1;
      }

      if (json) {
        emitJson(deps.log, {
          stopped: true,
          pid: stopResult.persistedState.pid,
          url: buildPublicBaseUrl(stopResult.persistedState.port),
          stateFile: stateFilePath,
        });
        return 0;
      }

      deps.log(
        `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
      );
      return 0;
    }

    if (command === "watch") {
      let options: ParsedWatchOptions;
      try {
        options = parseWatchOptions(rest);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("watch", deps.log);
        return 0;
      }

      if (options.positionals.length !== 1) {
        deps.error("Usage: roughdraft watch <path> [--json]");
        return USAGE_ERROR;
      }

      deps = applyWatchEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      return runWatch(deps, options.positionals[0] ?? "", options, json);
    }

    if (command === "mcp") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }
      if (options.help) {
        printCommandHelp("mcp", deps.log);
        return 0;
      }
      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft mcp");
        return USAGE_ERROR;
      }

      const { startMcpServer } = await import("./mcp.js");
      startMcpServer({ env: deps.env, fetchImpl: deps.fetchImpl });
      return new Promise<number>(() => {});
    }

    if (command === "doctor") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("doctor", deps.log);
        return 0;
      }

      if (options.positionals.length > 1) {
        deps.error("Usage: roughdraft doctor [path] [--json]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      if (options.positionals.length === 1) {
        return runMarkdownDoctor(deps, options.positionals[0] ?? "", json);
      }

      shouldPrintUpdateNotice = !json;
      return runDoctor(deps, json);
    }

    if (command === "migrate") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, { allowDryRun: true });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("migrate", deps.log);
        return 0;
      }

      if (options.positionals.length !== 1) {
        deps.error("Usage: roughdraft migrate <path> [--dry-run] [--json]");
        return USAGE_ERROR;
      }

      const json = parsed.global.json || options.json;
      return runMigrate(deps, options.positionals[0] ?? "", {
        dryRun: options.dryRun,
        json,
      });
    }

    if (command === "open") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {
          allowOpen: true,
          allowPort: true,
          allowWatch: true,
        });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("open", deps.log);
        return 0;
      }

      const target = options.positionals[0];
      if (!target) {
        deps.error("Usage: roughdraft open <path>");
        return USAGE_ERROR;
      }

      if (options.positionals.length > 1) {
        deps.error("Usage: roughdraft open <path>");
        return USAGE_ERROR;
      }

      if (options.watch && options.noWatch) {
        deps.error("Use either --watch or --no-watch, not both.");
        return USAGE_ERROR;
      }

      if (options.watch && options.printUrl) {
        deps.error("Use either --watch or --print-url, not both.");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      let resolvedTarget: ResolvedTargetPath;
      try {
        resolvedTarget = resolveTargetPath(target);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid path.");
        return 1;
      }

      const { projectDir, openPath } = resolvedTarget;

      const remoteHost =
        typeof deps.env.ROUGHDRAFT_HOST === "string"
          ? deps.env.ROUGHDRAFT_HOST.trim()
          : "";
      if (remoteHost.length > 0) {
        return runRemoteOpen(deps, {
          host: remoteHost,
          openPath,
          noOpen: options.noOpen,
          printUrl: options.printUrl,
          json,
        });
      }

      const liveDevFrontend = await resolveLiveDevFrontendBaseUrl(deps);
      let result: EnsureRunningResult | null = null;
      let baseUrl: string;

      if (liveDevFrontend) {
        baseUrl = liveDevFrontend.frontendUrl;
      } else {
        result = await ensureServerRunning(deps, { projectDir });
        baseUrl = buildPublicBaseUrl(result.server.port);
      }

      const targetUrl = buildTargetUrl(baseUrl, openPath);
      let openMode: OpenMode = "disabled";
      if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
        openMode = (await sendOpenRequestToExistingWindow(
          deps,
          baseUrl,
          targetUrl,
          openPath,
        ))
          ? "existing-window"
          : deps.openUrl(targetUrl);
      }

      if (result?.portChanged) {
        const message = `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`;
        if (options.printUrl) {
          deps.error(message);
        } else if (!json) {
          deps.log(message);
        }
      }

      if (options.printUrl) {
        deps.log(targetUrl);
        return 0;
      }

      const shouldWatch = !options.noWatch && !options.printUrl;

      if (shouldWatch) {
        if (!json) {
          if (openMode === "chrome-app") {
            deps.log(`Opened Roughdraft in a Chrome app window: ${targetUrl}`);
          } else if (openMode === "existing-window") {
            deps.log(`Reused an existing Roughdraft window: ${targetUrl}`);
          } else if (openMode === "browser") {
            deps.log(`Opened Roughdraft in the default browser: ${targetUrl}`);
          } else {
            deps.log(`Roughdraft is running at ${targetUrl}`);
          }
          deps.log("Waiting for Done Reviewing...");
        }

        const watchOptions: ParsedWatchOptions = {
          batchWindowSeconds: options.batchWindowSeconds,
          help: false,
          json,
          positionals: [target],
          replay: options.replay,
          serverUrl: liveDevFrontend?.apiUrl ?? undefined,
          stateDir: options.stateDir,
          stateFile: options.stateFile,
          timeoutSeconds: options.timeoutSeconds,
        };
        shouldPrintUpdateNotice = false;
        return runWatch(deps, target, watchOptions, json);
      }

      if (json) {
        emitJson(deps.log, {
          opened: true,
          url: targetUrl,
          serverUrl: baseUrl,
          path: openPath,
          openMode,
        });
        return 0;
      }

      shouldPrintUpdateNotice = true;
      if (openMode === "chrome-app") {
        deps.log(`Opened Roughdraft in a Chrome app window: ${targetUrl}`);
        return 0;
      }

      if (openMode === "existing-window") {
        deps.log(`Reused an existing Roughdraft window: ${targetUrl}`);
        return 0;
      }

      if (openMode === "browser") {
        deps.log(`Opened Roughdraft in the default browser: ${targetUrl}`);
        return 0;
      }

      deps.log(`Roughdraft is running at ${targetUrl}`);
      return 0;
    }

    return USAGE_ERROR;
  } finally {
    if (shouldPrintUpdateNotice) {
      await printUpdateNoticeIfAvailable(deps);
    }
  }
}
