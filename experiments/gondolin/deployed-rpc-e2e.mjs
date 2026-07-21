import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PiRpcClient } from "../../scripts/lib/pi-rpc.mjs";

const cwd = resolve(new URL(".", import.meta.url).pathname);
const launcher = join(homedir(), ".local", "bin", "pi-gondolin-rpc");
const pi = join(homedir(), ".local", "bin", "pi");
const deploymentState = JSON.parse(readFileSync(join(homedir(), ".local", "share", "pi-harness-challenger", "gondolin-rpc", "deployment.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "gondolin-deployed-rpc-"));
const snapshotRoot = join(root, "snapshot");
const canary = join(root, "forbidden-host-write");
const source = "deployed RPC snapshot\n";
const notifications = [];
const errors = [];
let confirmations = 0;

const update = spawnSync(pi, ["update", "pi"], { encoding: "utf8", timeout: 10_000 });
assert.equal(update.status, 64);
assert.equal(update.stdout, "");
assert.equal(update.stderr, "pi-update-requires-gondolin-rollback\n");
const direct = spawnSync(pi, ["--mode", "rpc"], { encoding: "utf8", timeout: 10_000 });
assert.equal(direct.status, 64);
assert.equal(direct.stdout, "");
assert.equal(direct.stderr, "pi-rpc-launcher-required\n");
const forged = spawnSync(pi, ["--mode=rpc"], {
  encoding: "utf8",
  timeout: 10_000,
  env: { ...process.env, PI_GONDOLIN_RPC_ACTIVE: "1" },
});
assert.equal(forged.status, 64);
assert.equal(forged.stdout, "");
assert.equal(forged.stderr, "pi-rpc-launcher-required\n");
const rpcEntry = spawnSync(process.execPath, [deploymentState.originalRpcEntry.path], { encoding: "utf8", timeout: 10_000 });
assert.equal(rpcEntry.status, 64);
assert.equal(rpcEntry.stdout, "");
assert.equal(rpcEntry.stderr, "pi-rpc-launcher-required\n");

mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(snapshotRoot, "README.md"), source, { mode: 0o600 });
const client = new PiRpcClient({
  cwd,
  executable: launcher,
  environment: {
    PI_OFFLINE: "1",
    PI_GONDOLIN_SNAPSHOT_ROOT: snapshotRoot,
    PI_GONDOLIN_SNAPSHOT_FILES: JSON.stringify(["README.md"]),
  },
});
client.onEvent((event) => {
  if (event.type === "extension_error") errors.push(event);
  if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message);
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    confirmations += 1;
    client.send({ type: "extension_ui_response", id: event.id, confirmed: true });
  }
});

try {
  await assert.rejects(client.request({ type: "bash", command: `touch ${canary}` }), /gondolin-rpc-command-refused/);
  const commands = (await client.request({ type: "get_commands" }, 180_000)).data?.commands ?? [];
  assert.ok(commands.some((item) => item.name === "gondolin-lab-import"));
  assert.ok(commands.some((item) => item.name === "policy-gate"));
  await client.request({ type: "prompt", message: "/gondolin-lab-import" }, 60_000);
  const imported = notifications.find((message) => message.startsWith("GONDOLIN_LAB_IMPORT:"));
  assert.ok(imported);
  assert.deepEqual(JSON.parse(imported.slice("GONDOLIN_LAB_IMPORT:".length)), {
    configured: true,
    approved: true,
    importedFiles: 1,
    importedBytes: Buffer.byteLength(source),
  });
  assert.equal(confirmations, 1);
  assert.deepEqual(errors, []);
  assert.equal(existsSync(canary), false);
  assert.equal(readFileSync(join(snapshotRoot, "README.md"), "utf8"), source);
  console.log("deployed Gondolin RPC: ok (CLI and rpc-entry refused, installed launcher attested)");
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}

if (client.stderr.trim()) throw new Error("Unexpected deployed launcher stderr");
