import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PiRpcClient } from "../../scripts/lib/pi-rpc.mjs";

const cwd = resolve(new URL(".", import.meta.url).pathname);
const temporaryRoot = mkdtempSync(join(tmpdir(), "gondolin-rpc-launcher-e2e-"));
const snapshotRoot = join(temporaryRoot, "snapshot");
const canary = join(temporaryRoot, "forbidden-host-write");
const source = "synthetic snapshot\n";
const launcherPath = join(cwd, "safe-rpc-launcher.mjs");
const refusedEnvironment = { ...process.env };
delete refusedEnvironment.PI_GONDOLIN_SNAPSHOT_ROOT;
delete refusedEnvironment.PI_GONDOLIN_SNAPSHOT_FILES;
const refusedStartup = spawnSync(process.execPath, [launcherPath], { cwd, env: refusedEnvironment, encoding: "utf8" });
assert.equal(refusedStartup.status, 64);
assert.equal(refusedStartup.stdout, "");
assert.equal(refusedStartup.stderr, "gondolin-rpc-launcher-refused\n");

const notifications = [];
const extensionErrors = [];
let confirmationCount = 0;

mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(snapshotRoot, "README.md"), source, { mode: 0o600 });

const client = new PiRpcClient({
  cwd,
  executable: process.execPath,
  executableArgs: [launcherPath],
  environment: {
    PI_OFFLINE: "1",
    PI_GONDOLIN_SNAPSHOT_ROOT: snapshotRoot,
    PI_GONDOLIN_SNAPSHOT_FILES: JSON.stringify(["README.md"]),
  },
});
client.onEvent((event) => {
  if (event.type === "extension_error") extensionErrors.push(event);
  if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message);
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    confirmationCount += 1;
    client.send({ type: "extension_ui_response", id: event.id, confirmed: true });
  }
});

try {
  await assert.rejects(
    client.request({ type: "bash", command: `touch ${canary}` }, 30_000),
    /gondolin-rpc-command-refused/,
  );
  await assert.rejects(client.request({ type: "abort_bash" }, 30_000), /gondolin-rpc-command-refused/);
  await assert.rejects(client.request({ type: "export_html", outputPath: canary }, 30_000), /gondolin-rpc-command-refused/);
  await assert.rejects(client.request({ type: "prompt", message: "/export /tmp/forbidden" }, 30_000), /gondolin-rpc-command-refused/);

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
  assert.equal(confirmationCount, 1);
  assert.equal(existsSync(canary), false);
  assert.equal(readFileSync(join(snapshotRoot, "README.md"), "utf8"), source);
  assert.deepEqual(extensionErrors, []);
  console.log("gondolin safe RPC launcher: ok (server-side gate, fixed composition, explicit import)");
} finally {
  await client.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (client.stderr.trim()) throw new Error("Unexpected safe launcher stderr");
