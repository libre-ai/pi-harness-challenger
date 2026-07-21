import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const which = spawnSync("which", ["pi"], { encoding: "utf8" });
assert.equal(which.status, 0, "pi executable not found");
let cliPath = realpathSync(which.stdout.trim());
let packageRoot = dirname(dirname(cliPath));
let rpcEntryDeploymentGuardPresent = false;
if (!existsSync(join(packageRoot, "package.json"))) {
  const deploymentState = JSON.parse(readFileSync(join(homedir(), ".local", "share", "pi-harness-challenger", "gondolin-rpc", "deployment.json"), "utf8"));
  rpcEntryDeploymentGuardPresent = deploymentState.version === 2 && typeof deploymentState.originalRpcEntry?.guardedSha256 === "string";
  cliPath = deploymentState.originalPi.realPath;
  packageRoot = dirname(dirname(cliPath));
}
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(packageJson.name, "@earendil-works/pi-coding-agent");
assert.equal(packageJson.version, "0.80.10");

const rpcDist = readFileSync(join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js"));
assert.equal(sha256(rpcDist), "2001c50c4d924f330279ea4cf64e4571c403c7ea7b15797cc0ae170c5d5bf097");
const sourceMap = JSON.parse(readFileSync(join(packageRoot, "dist", "modes", "rpc", "rpc-mode.js.map"), "utf8"));
const sourceIndex = sourceMap.sources.findIndex((source) => source.endsWith("/src/modes/rpc/rpc-mode.ts"));
assert.ok(sourceIndex >= 0);
const source = sourceMap.sourcesContent[sourceIndex];
const original = `\t\t\tcase "bash": {\n\t\t\t\tconst result = await session.executeBash(command.command, undefined, {\n\t\t\t\t\texcludeFromContext: command.excludeFromContext,\n\t\t\t\t});\n\t\t\t\treturn success(id, "bash", result);\n\t\t\t}`;
assert.equal(source.split(original).length - 1, 1, "RPC source contract changed");
const proposed = `\t\t\tcase "bash": {\n\t\t\t\tconst excludeFromContext = command.excludeFromContext ?? false;\n\t\t\t\tconst eventResult = await session.extensionRunner.emitUserBash({\n\t\t\t\t\ttype: "user_bash",\n\t\t\t\t\tcommand: command.command,\n\t\t\t\t\texcludeFromContext,\n\t\t\t\t\tcwd: session.sessionManager.getCwd(),\n\t\t\t\t});\n\t\t\t\tif (eventResult?.result) {\n\t\t\t\t\tsession.recordBashResult(command.command, eventResult.result, { excludeFromContext });\n\t\t\t\t\treturn success(id, "bash", eventResult.result);\n\t\t\t\t}\n\t\t\t\tconst result = await session.executeBash(command.command, undefined, {\n\t\t\t\t\texcludeFromContext,\n\t\t\t\t\toperations: eventResult?.operations,\n\t\t\t\t});\n\t\t\t\treturn success(id, "bash", result);\n\t\t\t}`;
const patched = source.replace(original, proposed);
assert.notEqual(patched, source);
assert.match(patched, /emitUserBash/);
assert.match(patched, /operations: eventResult\?\.operations/);
assert.match(patched, /recordBashResult/);

const patch = readFileSync(new URL("./upstream/pi-rpc-user-bash.patch", import.meta.url), "utf8");
for (const contract of ["emitUserBash", "recordBashResult", "operations: eventResult?.operations"]) {
  assert.match(patch, new RegExp(contract.replace(/[?.]/g, "\\$&")));
}

process.stdout.write(`${JSON.stringify({
  version: 1,
  piVersion: packageJson.version,
  installedArtifactSha256Matched: true,
  sourceMapContractMatched: true,
  patchContractMatched: true,
  rpcModeInstallationModified: false,
  rpcEntryDeploymentGuardPresent,
  patchApplied: false,
  allPass: true,
}, null, 2)}\n`);
