import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("le statut agrégé bloque toute promotion incomplète ou invalide", () => {
  const run = spawnSync(process.execPath, [join(root, "scripts", "eval-status.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);

  assert.equal(report.evidence.complete, true);
  assert.equal(report.evidence.invalidRunsAcknowledged, true);
  assert.equal(report.evidence.supersededRunsLinked, true);
  assert.equal(report.gates.globalPromotionAllowed, false);
  assert.deepEqual(report.gates.blockingComponents, ["policy-gate"]);
  assert.equal(report.profiles.unsandboxedPolicy.ready, false);
  assert.equal(report.profiles.gondolinLab.technicalReady, true);
  assert.equal(report.profiles.gondolinLab.liveDeployment, true);
  assert.equal(report.profiles.gondolinLab.promotionAllowed, true);
  assert.deepEqual(report.profiles.gondolinLab.promotionBlockers, []);
  assert.equal(report.profiles.handoffRepresentative.ready, true);
  assert.equal(report.components.find((item) => item.component === "trust-boundary")?.verdict, "rejected");
  assert.equal(report.components.find((item) => item.component === "review-challenge")?.verdict, "rejected");
  assert.equal(report.components.find((item) => item.component === "verify-runtime")?.verdict, "retained-lab");
  assert.equal(report.components.find((item) => item.component === "handoff")?.verdict, "retained-lab");
});
