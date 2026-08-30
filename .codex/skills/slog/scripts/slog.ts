#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type LatestRun = {
  createdAt: string;
  file: string;
  gitSha: string | null;
  gitState: "clean" | "dirty" | "unknown";
  label: string;
  relativeFile: string;
  runId: string;
};

const PROJECT_ROOT = process.cwd();
const SLOG_DIR = path.join(PROJECT_ROOT, ".context", "slog");
const LATEST_FILE = path.join(SLOG_DIR, "latest.json");
const CURRENT_ENV_FILE = path.join(SLOG_DIR, "current.env");

function usage(): never {
  console.error(`Usage:
  bun .codex/skills/slog/scripts/slog.ts new [label]
  bun .codex/skills/slog/scripts/slog.ts latest [field]
  bun .codex/skills/slog/scripts/slog.ts list

Fields for "latest": runId | label | file | relativeFile | createdAt | gitSha | gitState`);
  process.exit(1);
}

function ensureDir(): void {
  fs.mkdirSync(SLOG_DIR, { recursive: true });
}

function sanitizeLabel(input: string | undefined): string {
  const base = (input ?? "run").trim().toLowerCase();
  const cleaned = base
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return cleaned || "run";
}

function timestampForFilename(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function gitSha(): string | null {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value || null;
}

function gitState(): "clean" | "dirty" | "unknown" {
  const result = spawnSync(
    "git",
    ["status", "--short", "--untracked-files=normal"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  if (result.status === 0) {
    return result.stdout.trim() ? "dirty" : "clean";
  }

  return "unknown";
}

function createRun(labelArg: string | undefined): void {
  ensureDir();

  const label = sanitizeLabel(labelArg);
  const createdAt = new Date().toISOString();
  const sha = gitSha();
  const state = gitState();
  const runIdParts = [
    timestampForFilename(),
    sha,
    state === "dirty" ? "dirty" : null,
    label,
  ].filter(Boolean) as string[];
  const runId = runIdParts.join("-");
  const file = path.join(SLOG_DIR, `${runId}.jsonl`);
  const relativeFile = path.relative(PROJECT_ROOT, file);

  fs.writeFileSync(file, "");

  const latest: LatestRun = {
    createdAt,
    file,
    gitSha: sha,
    gitState: state,
    label,
    relativeFile,
    runId,
  };

  fs.writeFileSync(LATEST_FILE, `${JSON.stringify(latest, null, 2)}\n`);
  fs.writeFileSync(
    CURRENT_ENV_FILE,
    [
      `export THOUGHTFUL_SLOG_FILE="${file}"`,
      `export THOUGHTFUL_SLOG_RUN_ID="${runId}"`,
      `export THOUGHTFUL_SLOG_LABEL="${label}"`,
      "",
    ].join("\n"),
  );

  console.log(`Created slog run
runId=${runId}
label=${label}
file=${relativeFile}
envFile=${path.relative(PROJECT_ROOT, CURRENT_ENV_FILE)}

export THOUGHTFUL_SLOG_FILE="${file}"
export THOUGHTFUL_SLOG_RUN_ID="${runId}"
export THOUGHTFUL_SLOG_LABEL="${label}"`);
}

function readLatest(): LatestRun {
  if (!fs.existsSync(LATEST_FILE)) {
    console.error(
      "No slog run found. Create one first with: bun .codex/skills/slog/scripts/slog.ts new <label>",
    );
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(LATEST_FILE, "utf8")) as LatestRun;
}

function printLatest(field: string | undefined): void {
  const latest = readLatest();

  if (!field) {
    console.log(JSON.stringify(latest, null, 2));
    return;
  }

  const value = latest[field as keyof LatestRun];
  if (value === undefined) {
    usage();
  }

  console.log(String(value));
}

function listRuns(): void {
  ensureDir();

  const latest = fs.existsSync(LATEST_FILE) ? readLatest() : null;
  const files = fs
    .readdirSync(SLOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const fileName of files) {
    const absolutePath = path.join(SLOG_DIR, fileName);
    const marker = latest?.file === absolutePath ? "*" : " ";
    console.log(`${marker} ${path.relative(PROJECT_ROOT, absolutePath)}`);
  }
}

const [, , command, arg] = process.argv;

switch (command) {
  case "new":
    createRun(arg);
    break;
  case "latest":
    printLatest(arg);
    break;
  case "list":
    listRuns();
    break;
  default:
    usage();
}
