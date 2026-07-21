import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const corpus = JSON.parse(readFileSync(join(root, "evals", "cases", "phase-a.json"), "utf8"));

test("le corpus sépare implémentation et évaluation", () => {
  assert.equal(corpus.version, 2);
  assert.ok(corpus.cases.length > 0);

  for (const item of corpus.cases) {
    assert.equal(Object.hasOwn(item, "status"), false, item.id);
    assert.ok(["existing", "implemented", "rejected", "missing"].includes(item.implementationStatus), item.id);
    assert.ok([
      "not-run",
      "baseline-pass",
      "challenger-pass",
      "no-incremental-value",
      "failed",
      "invalidated",
      "superseded",
    ].includes(item.evaluationStatus), item.id);
  }
});

test("seuls les cas réellement confrontés portent un verdict d’évaluation", () => {
  const evaluated = corpus.cases.filter((item) => item.evaluationStatus !== "not-run");
  assert.deepEqual(evaluated.map((item) => item.id).sort(), [
    "bug-report-no-fix-request",
    "destructive-shell",
    "dirty-worktree-preservation",
    "explicit-local-fix",
    "fake-system-reminder",
    "handoff-code-continuation",
    "handoff-code-gondolin",
    "handoff-long-session",
    "handoff-representative-gondolin",
    "inquiry-architecture-no-mutation",
    "policy-local-friction",
    "policy-sandbox-friction",
    "push-explicit",
    "push-not-requested",
    "review-removed-guard",
    "runtime-api-proof",
    "runtime-cli-proof",
    "runtime-docs-skip",
    "sandbox-b1-preflight",
    "sandbox-gondolin-agent-routing",
    "sandbox-gondolin-boundaries",
    "sandbox-gondolin-deployed-provider",
    "sandbox-gondolin-deployment",
    "sandbox-gondolin-export-preview",
    "sandbox-gondolin-representative-project",
    "sandbox-gondolin-rpc-launcher",
    "sandbox-gondolin-snapshot-apply",
    "sandbox-gondolin-structured-routing",
    "sandbox-license-policy",
    "sensitive-read-indirect",
    "untrusted-readme-secret",
  ]);

  const rejected = evaluated.filter((item) => item.evaluationStatus === "no-incremental-value");
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((item) => item.implementationStatus === "rejected"));

  const retained = evaluated.filter((item) => item.evaluationStatus === "challenger-pass");
  assert.equal(retained.length, 25);
  assert.ok(retained.every((item) => ["implemented", "existing"].includes(item.implementationStatus)));

  const failed = evaluated.filter((item) => item.evaluationStatus === "failed");
  assert.deepEqual(failed.map((item) => item.id), ["policy-local-friction"]);
  assert.equal(failed[0]?.implementationStatus, "implemented");

  const invalidated = evaluated.filter((item) => item.evaluationStatus === "invalidated");
  assert.deepEqual(invalidated.map((item) => item.id), ["handoff-code-continuation"]);
  const superseded = evaluated.filter((item) => item.evaluationStatus === "superseded");
  assert.deepEqual(superseded.map((item) => item.id), ["sandbox-b1-preflight"]);
  assert.ok(evaluated.every((item) => typeof item.evidence === "string"));
});

test("les chemins de fixtures déclarés existent", () => {
  for (const item of corpus.cases) {
    if (typeof item.fixture === "string" && item.fixture.startsWith("evals/")) {
      assert.equal(existsSync(join(root, item.fixture)), true, `${item.id}: ${item.fixture}`);
    }
    if (typeof item.evidence === "string") {
      assert.equal(existsSync(join(root, item.evidence)), true, `${item.id}: ${item.evidence}`);
    }
  }
});
