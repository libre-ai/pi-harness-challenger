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

test("l’attestation Gondolin réduit la friction sans modifier le corpus", () => {
  const baseline = run("policy-friction-eval.mjs");
  const sandboxed = run("policy-sandbox-friction-eval.mjs");

  assert.equal(baseline.operationCount, 16);
  assert.equal(sandboxed.operationCount, 16);
  assert.deepEqual(
    baseline.classifications.map((item) => item.id),
    sandboxed.classifications.map((item) => item.id),
  );
  assert.equal(baseline.confirmMode.confirmationRate, 0.6875);
  assert.equal(sandboxed.confirmMode.confirmationRate, 0);
  assert.equal(sandboxed.confirmMode.headlessBlockCount, 0);
  assert.equal(sandboxed.allAttested, true);
});
