import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PiRpcClient } from "../../scripts/lib/pi-rpc.mjs";

const cwd = resolve(new URL(".", import.meta.url).pathname);
const launcher = process.env.PI_GONDOLIN_LAUNCHER ?? join(homedir(), ".local", "bin", "pi-gondolin-rpc");
const pi = process.env.PI_GONDOLIN_PI ?? join(homedir(), ".local", "bin", "pi");
const legacyDeploymentRoot = join(homedir(), ".local", "share", "pi-harness-challenger", "gondolin-rpc");
const deploymentRoot = process.env.PI_GONDOLIN_DEPLOYMENT_ROOT ?? join(legacyDeploymentRoot, "v3");
let rpcEntryPath = process.env.PI_GONDOLIN_RPC_ENTRY;
if (!rpcEntryPath && existsSync(join(deploymentRoot, "current"))) {
  const packageRoot = join(realpathSync(join(deploymentRoot, "current")), "node_modules", "@earendil-works", "pi-coding-agent");
  rpcEntryPath = join(packageRoot, "dist", "rpc-entry.js");
}
if (!rpcEntryPath) {
  const legacyState = JSON.parse(readFileSync(join(legacyDeploymentRoot, "deployment.json"), "utf8"));
  rpcEntryPath = legacyState.originalRpcEntry.path;
}
const root = mkdtempSync(join(tmpdir(), "gondolin-deployed-rpc-"));
const snapshotRoot = join(root, "snapshot");
const canary = join(root, "forbidden-host-write");
const source = "deployed RPC snapshot\n";
const notifications = [];
const errors = [];
let confirmations = 0;

const version = spawnSync(pi, ["--version"], { encoding: "utf8", timeout: 10_000 });
assert.equal(version.status, 0);
assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(version.stderr, "");
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
const rpcEntry = spawnSync(process.execPath, [rpcEntryPath], { encoding: "utf8", timeout: 10_000 });
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
