import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PiRpcClient } from "./lib/pi-rpc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-policy-e2e-"));
const configPath = join(temporaryRoot, "config", "config.json");
const notifications = [];
let confirmations = 0;
let agentStarted = false;
const extensionErrors = [];

const client = new PiRpcClient({
  cwd: temporaryRoot,
  environment: {
    PI_OFFLINE: "1",
    PI_HARNESS_CHALLENGER_CONFIG: configPath,
  },
  args: [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e", join(root, "extensions", "policy-gate", "index.mjs"),
  ],
});

client.onEvent((event) => {
  if (event.type === "agent_start") agentStarted = true;
  if (event.type === "extension_error") extensionErrors.push(event);
  if (event.type !== "extension_ui_request") return;
  if (event.method === "notify") notifications.push(event.message);
  if (event.method === "confirm") {
    confirmations += 1;
    client.send({ type: "extension_ui_response", id: event.id, confirmed: false });
  }
});

let stderr;
try {
  await client.request({ type: "prompt", message: "/policy-gate confirm" });
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).policyMode, "confirm");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  await client.request({ type: "new_session" });
  await client.request({ type: "prompt", message: "/policy-gate status" });
  assert.ok(notifications.some((message) => /durable confirm/.test(message)));

  await client.request({ type: "prompt", message: "/policy-gate observe" });
  assert.equal(confirmations, 1, "lowering protection must require confirmation");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).policyMode, "confirm");

  await client.request({ type: "new_session" });
  notifications.length = 0;
  await client.request({ type: "prompt", message: "/policy-gate status" });
  assert.ok(notifications.some((message) => /durable confirm/.test(message)));
  assert.equal(agentStarted, false);
  assert.deepEqual(extensionErrors, []);

  console.log("policy rpc e2e: ok (durable across sessions, downgrade refused, no provider)");
} finally {
  await client.close();
  stderr = client.stderr.trim();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (stderr) throw new Error(`Unexpected Pi RPC stderr: ${stderr}`);
