import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const experiment = join(root, "experiments", "gondolin");

test("le spike Gondolin reste hors du package Pi principal", () => {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const experimentPackage = JSON.parse(readFileSync(join(experiment, "package.json"), "utf8"));
  const npmIgnore = readFileSync(join(root, ".npmignore"), "utf8");

  assert.deepEqual(rootPackage.pi.extensions, [
    "./extensions/policy-gate/index.mjs",
    "./extensions/handoff/index.mjs",
  ]);
  assert.equal(experimentPackage.dependencies["@earendil-works/gondolin"], "0.12.0");
  assert.equal(experimentPackage.dependencies.typebox, "1.1.38");
  assert.match(npmIgnore, /^experiments\/$/m);
});

test("la politique Gondolin est sans montage, sans egress et sans fallback hôte", () => {
  const source = readFileSync(join(experiment, "sandbox.mjs"), "utf8");
  const boundaryProbe = readFileSync(join(experiment, "spike.mjs"), "utf8");
  const codeProbe = readFileSync(join(experiment, "handoff-code-spike.mjs"), "utf8");
  const extension = readFileSync(join(experiment, "extension.mjs"), "utf8");
  const snapshot = readFileSync(join(experiment, "snapshot.mjs"), "utf8");
  const remainingCases = readFileSync(join(experiment, "remaining-cases-eval.mjs"), "utf8");
  const representative = readFileSync(join(experiment, "representative-project-eval.mjs"), "utf8");
  const representativeHandoff = readFileSync(join(experiment, "representative-handoff-eval.mjs"), "utf8");
  const rpcGuard = readFileSync(join(experiment, "safe-rpc-client.mjs"), "utf8");
  const rpcGate = readFileSync(join(experiment, "rpc-gate.mjs"), "utf8");
  const rpcLauncher = readFileSync(join(experiment, "safe-rpc-launcher.mjs"), "utf8");
  const upstreamPatch = readFileSync(join(experiment, "upstream", "pi-rpc-user-bash.patch"), "utf8");

  assert.match(source, /allowedHosts:\s*\[\]/);
  assert.match(source, /isRequestAllowed:\s*\(\)\s*=>\s*false/);
  assert.match(source, /isIpAllowed:\s*\(\)\s*=>\s*false/);
  assert.match(source, /tcp:\s*\{\s*hosts:\s*\{\}\s*\}/);
  assert.match(source, /allowWebSockets:\s*false/);
  assert.match(source, /vfs:\s*null/);
  assert.doesNotMatch(source, /RealFSProvider|spawnSync|execFile|child_process/);
  assert.match(boundaryProbe, /hostListenerConnections/);
  assert.match(codeProbe, /generatedCodeExecutedOnHost:\s*false/);
  for (const name of ["bash", "read", "write", "edit"]) assert.match(extension, new RegExp(`name:\\s*"${name}"`));
  assert.match(extension, /gondolin-path-outside-workspace/);
  assert.match(extension, /gondolin-edit-old-text-not-unique/);
  assert.match(extension, /gondolin-(?:timeout|abort)-vm-closed/);
  assert.match(extension, /gondolin-lab-import/);
  assert.match(extension, /gondolin-lab-apply/);
  assert.match(extension, /gondolin-lab-fixture/);
  assert.match(extension, /gondolin-lab-project-eval/);
  assert.match(extension, /MAX_MODEL_TOOL_CALLS\s*=\s*64/);
  assert.match(extension, /gondolin-tool-budget-exhausted/);
  assert.match(extension, /hostMounts:\s*0/);
  assert.match(snapshot, /O_NOFOLLOW/);
  assert.match(snapshot, /snapshot-host-changed/);
  assert.match(snapshot, /snapshot-path-sensitive/);
  assert.doesNotMatch(extension, /child_process|spawnSync|execFile|RealFSProvider/);
  assert.doesNotMatch(snapshot, /child_process|spawnSync|execFile|RealFSProvider/);
  assert.doesNotMatch(remainingCases, /type:\s*["']bash["']/);
  assert.doesNotMatch(representative, /type:\s*["']bash["']/);
  assert.match(representative, /sourceProjectWrites:\s*0/);
  assert.doesNotMatch(representativeHandoff, /type:\s*["']bash["']/);
  assert.match(representativeHandoff, /hostCodeExecution:\s*false/);
  assert.match(rpcGuard, /FORBIDDEN_RPC_COMMANDS.*bash.*abort_bash/);
  assert.match(rpcGate, /ALLOWED_COMMANDS/);
  assert.match(rpcGate, /MAX_PROMPT_CHARS\s*=\s*100_000/);
  assert.match(rpcGate, /MAX_SESSION_DURATION_MS\s*=\s*10 \* 60 \* 1000/);
  assert.doesNotMatch(rpcGate, /export_html/);
  assert.match(rpcLauncher, /policyMode:\s*"confirm"/);
  assert.match(rpcLauncher, /delete childEnvironment\.NODE_OPTIONS/);
  assert.match(rpcLauncher, /session-time-budget-exceeded/);
  assert.match(rpcLauncher, /"--no-extensions"/);
  assert.doesNotMatch(rpcLauncher, /child\.stderr\.pipe/);
  assert.match(upstreamPatch, /emitUserBash/);
  assert.match(upstreamPatch, /operations: eventResult\?\.operations/);
  for (const path of ["agent-rpc-e2e.mjs", "extension-rpc-e2e.mjs", "handoff-code-spike.mjs", "remaining-cases-eval.mjs"]) {
    assert.match(readFileSync(join(experiment, path), "utf8"), /GondolinPiRpcClient/);
  }
});
