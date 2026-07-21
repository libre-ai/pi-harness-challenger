import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

function run(script) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("le preflight sandbox n’autorise aucune activation globale", () => {
  const report = run("sandbox-preflight.mjs");
  assert.equal(report.decision.installPerformed, false);
  assert.equal(report.decision.globalActivationAllowed, false);
  assert.equal(report.candidates.gondolin.license, "Apache-2.0");
  assert.equal(report.candidates.sandboxRuntime.exampleSafeByDefault, false);
});

test("les lockfiles sandbox appliquent seulement l’exception hash-pinnée", () => {
  const report = run("sandbox-license-audit.mjs");
  assert.equal(report.allPass, true);
  assert.deepEqual(report.candidates.gondolin.unresolved, []);
  assert.deepEqual(report.candidates.gondolin.policyExceptionsUsed, ["tweetnacl@0.14.5"]);
  assert.equal(report.candidates.gondolin.passes, true);
  assert.deepEqual(report.candidates.sandboxRuntime.unresolved, []);
  assert.equal(report.candidates.sandboxRuntime.passes, true);
  assert.deepEqual(report.candidates.gondolin.exactTarballOverridesUsed.sort(), [
    "buildcheck@0.0.7",
    "cpu-features@0.0.10",
    "ssh2@1.17.0",
  ]);
});
