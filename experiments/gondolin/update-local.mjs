#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deploymentStatusV3,
  disableAutomaticUpdatesV3,
  enableAutomaticUpdatesV3,
  installV3,
  rollbackV3,
  routePiRequest,
  runtimeRepinV3,
  updateV3,
} from "./deployment-controller.mjs";

const action = process.argv[2] ?? "status";
const actionArgs = process.argv.slice(3);
const home = process.env.HOME ?? homedir();
const deploymentRoot = process.env.PI_GONDOLIN_DEPLOYMENT_ROOT;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const updateTrigger = process.env.PI_GONDOLIN_UPDATE_TRIGGER === "automatic" ? "automatic" : "manual";
const runtimeTrigger = process.env.PI_GONDOLIN_UPDATE_TRIGGER === "recovery" ? "recovery" : "manual";

if (!isAbsolute(home) || home.includes("\0") || home.includes("\n")) {
  process.stderr.write("gondolin-transactional-update-refused:home-invalid\n");
  process.exit(64);
}
if (deploymentRoot && (!isAbsolute(deploymentRoot) || deploymentRoot.includes("\0") || deploymentRoot.includes("\n"))) {
  process.stderr.write("gondolin-transactional-update-refused:deployment-root-invalid\n");
  process.exit(64);
}

async function main() {
  if (action === "install" && actionArgs.length === 0) {
    return installV3({ home, projectRoot, deploymentRoot });
  }
  if (action === "status" && actionArgs.length === 0) {
    return deploymentStatusV3({ home, deploymentRoot });
  }
  if (action === "rollback" && actionArgs.length === 0) {
    return rollbackV3({ home, deploymentRoot });
  }
  if (action === "runtime-repin" && actionArgs.length === 0) {
    const binding = await runtimeRepinV3({ home, deploymentRoot, trigger: runtimeTrigger });
    return {
      repaired: true,
      bindingId: binding.bindingId,
      nodeVersion: binding.nodeVersion,
      qualifiedAt: binding.qualifiedAt,
      operationId: binding.operationId,
      auditComplete: binding.auditComplete,
    };
  }
  if (action === "automation-enable" && actionArgs.length === 0) {
    return enableAutomaticUpdatesV3({ home, deploymentRoot });
  }
  if (action === "automation-disable" && actionArgs.length === 0) {
    return disableAutomaticUpdatesV3({ home, deploymentRoot });
  }
  if (action === "update" && actionArgs.every((argument) => argument === "--force")) {
    return updateV3({ home, deploymentRoot, force: actionArgs.includes("--force"), trigger: updateTrigger });
  }
  if (action === "route" && actionArgs[0] === "update") {
    const routed = await routePiRequest({ home, deploymentRoot, args: actionArgs, trigger: updateTrigger });
    if (routed.exitCode !== 0) process.exitCode = routed.exitCode;
    return routed.result;
  }
  throw new Error("usage-invalid");
}

try {
  const result = await main();
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error && /^[0-9A-Za-z:._-]+$/.test(error.message)
    ? error.message
    : "unknown";
  process.stderr.write(`gondolin-transactional-update-refused:${code}\n`);
  process.exitCode = 1;
}
