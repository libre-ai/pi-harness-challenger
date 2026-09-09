#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_RPC_LINE_BYTES,
  boundedSessionDuration,
  parseAndInspectRpcLine,
  refusalResponse,
} from "./rpc-gate.mjs";
import { validateSnapshotPath } from "./snapshot.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
let runtimeDirectory;
let child;
let piExecutable = "pi";
let inputBuffer = Buffer.alloc(0);
let fatalExitCode;
let killTimer;
let sessionTimer;

function refuseStartup() {
  process.stderr.write("gondolin-rpc-launcher-refused\n");
  process.exitCode = 64;
}

function validateEnvironment() {
  if (process.argv.length !== 2) throw new Error("launcher-arguments-refused");
  const configuredPiExecutable = process.env.PI_GONDOLIN_PI_EXECUTABLE;
  if (configuredPiExecutable !== undefined) {
    if (!isAbsolute(configuredPiExecutable)
      || configuredPiExecutable.includes("\0")
      || configuredPiExecutable.includes("\n")) {
      throw new Error("launcher-pi-executable-invalid");
    }
    piExecutable = configuredPiExecutable;
  }
  const root = process.env.PI_GONDOLIN_SNAPSHOT_ROOT;
  const encodedFiles = process.env.PI_GONDOLIN_SNAPSHOT_FILES;
  if (typeof root !== "string" || !root || root.includes("\0") || root.includes("\n") || typeof encodedFiles !== "string") {
    throw new Error("launcher-snapshot-required");
  }
  let files;
  try {
    files = JSON.parse(encodedFiles);
  } catch {
    throw new Error("launcher-snapshot-files-invalid");
  }
  if (!Array.isArray(files) || files.length === 0) throw new Error("launcher-snapshot-files-invalid");
  files.forEach(validateSnapshotPath);
}

function cleanup() {
  if (killTimer) clearTimeout(killTimer);
  if (sessionTimer) clearTimeout(sessionTimer);
  if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true });
}

function terminate(exitCode = 70) {
  if (fatalExitCode === undefined) fatalExitCode = exitCode;
  process.stdin.pause();
  child?.stdin.end();
  child?.kill("SIGTERM");
  killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 2_000);
}

function fatalProtocolInput() {
  process.stdout.write(`${JSON.stringify({ type: "gondolin_rpc_gate_error", fatal: true, error: "invalid-rpc-input" })}\n`);
  terminate(65);
}

function processInputLine(rawLine) {
  const line = rawLine.length > 0 && rawLine.at(-1) === 13 ? rawLine.subarray(0, -1) : rawLine;
  let inspected;
  try {
    inspected = parseAndInspectRpcLine(line);
  } catch {
    fatalProtocolInput();
    return false;
  }
  if (!inspected.decision.allowed) {
    process.stdout.write(`${JSON.stringify(refusalResponse(inspected.message))}\n`);
    return true;
  }
  const accepted = child.stdin.write(`${JSON.stringify(inspected.message)}\n`);
  if (!accepted) {
    process.stdin.pause();
    child.stdin.once("drain", () => {
      if (fatalExitCode === undefined) process.stdin.resume();
    });
  }
  return true;
}

try {
  validateEnvironment();
} catch {
  refuseStartup();
}

if (process.exitCode === undefined) {
  runtimeDirectory = mkdtempSync(join(tmpdir(), "gondolin-rpc-launcher-"));
  const configPath = join(runtimeDirectory, "policy.json");
  writeFileSync(configPath, `${JSON.stringify({ version: 1, policyMode: "confirm" }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const sessionDurationMs = boundedSessionDuration(process.env.PI_GONDOLIN_SESSION_BUDGET_MS);
  const childEnvironment = {
    ...process.env,
    PI_HARNESS_CHALLENGER_CONFIG: configPath,
    PI_GONDOLIN_RPC_ACTIVE: "1",
  };
  delete childEnvironment.NODE_OPTIONS;
  delete childEnvironment.NODE_PATH;
  delete childEnvironment.PI_GONDOLIN_SESSION_BUDGET_MS;
  delete childEnvironment.PI_GONDOLIN_PI_EXECUTABLE;

  child = spawn(piExecutable, [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "read,edit,write,bash",
    "-e", resolve(directory, "../../extensions/policy-gate/index.mjs"),
    "-e", resolve(directory, "extension.mjs"),
  ], {
    cwd: directory,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.resume();
  sessionTimer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: "gondolin_rpc_gate_error", fatal: true, error: "session-time-budget-exceeded" })}\n`);
    terminate(124);
  }, sessionDurationMs);

  process.stdin.on("data", (chunk) => {
    if (fatalExitCode !== undefined) return;
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    if (inputBuffer.length > MAX_RPC_LINE_BYTES && !inputBuffer.includes(10)) {
      fatalProtocolInput();
      return;
    }
    while (fatalExitCode === undefined) {
      const newline = inputBuffer.indexOf(10);
      if (newline < 0) break;
      const line = inputBuffer.subarray(0, newline);
      inputBuffer = inputBuffer.subarray(newline + 1);
      if (!processInputLine(line)) break;
    }
  });
  process.stdin.on("end", () => {
    if (inputBuffer.length > 0) {
      fatalProtocolInput();
      return;
    }
    child.stdin.end();
  });
  process.stdin.on("error", () => terminate(74));
  child.on("error", () => terminate(69));
  child.on("close", (code, signal) => {
    cleanup();
    process.exitCode = fatalExitCode ?? (signal ? 70 : (code ?? 70));
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => terminate(signal === "SIGINT" ? 130 : 143));
  }
}
