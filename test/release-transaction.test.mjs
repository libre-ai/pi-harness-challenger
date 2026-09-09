import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  advanceReleaseTransaction,
  beginReleaseTransaction,
  completeReleaseTransaction,
  inspectReleaseTransaction,
  recoverReleaseTransaction,
} from "../experiments/gondolin/release-transaction.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-transaction-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "releases", "1.0.0-old"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "candidates", "candidate-new"), { recursive: true, mode: 0o700 });
  symlinkSync("releases/1.0.0-old", join(root, "current"));
  const beforeState = { version: 3, currentRelease: "1.0.0-old", previousRelease: null };
  const afterState = { version: 3, currentRelease: "2.0.0-new", previousRelease: "1.0.0-old" };
  writeFileSync(join(root, "deployment.json"), `${JSON.stringify(beforeState, null, 2)}\n`, { mode: 0o600 });
  return {
    root,
    before: { state: beforeState, current: "releases/1.0.0-old", previous: null },
    after: { state: afterState, current: "releases/2.0.0-new", previous: "releases/1.0.0-old" },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function begin(fixtureValue) {
  return beginReleaseTransaction({
    deploymentRoot: fixtureValue.root,
    kind: "promotion",
    releaseId: "2.0.0-new",
    candidateId: "candidate-new",
    before: fixtureValue.before,
    after: fixtureValue.after,
  });
}

function activateLinks(fixtureValue) {
  renameSync(
    join(fixtureValue.root, "candidates", "candidate-new"),
    join(fixtureValue.root, "releases", "2.0.0-new"),
  );
  rmSync(join(fixtureValue.root, "current"));
  symlinkSync("releases/2.0.0-new", join(fixtureValue.root, "current"));
  symlinkSync("releases/1.0.0-old", join(fixtureValue.root, "previous"));
}

function activateState(fixtureValue) {
  writeFileSync(
    join(fixtureValue.root, "deployment.json"),
    `${JSON.stringify(fixtureValue.after.state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test("release transaction persists exact private snapshots", () => {
  const value = fixture();
  try {
    const transaction = begin(value);
    assert.equal(transaction.phase, "prepared");
    assert.deepEqual(Object.keys(transaction), [
      "version",
      "transactionId",
      "kind",
      "phase",
      "releaseId",
      "candidateId",
      "resolution",
      "before",
      "after",
    ]);
    assert.match(transaction.transactionId, /^[0-9a-f-]{36}$/);
    const transactionRoot = join(value.root, "release-transaction");
    assert.equal(lstatSync(transactionRoot).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(transactionRoot).sort(), ["after-state.json", "before-state.json", "journal.json"]);
    for (const file of readdirSync(transactionRoot)) {
      assert.equal(lstatSync(join(transactionRoot, file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(inspectReleaseTransaction({ deploymentRoot: value.root }).journal, transaction);
  } finally {
    value.cleanup();
  }
});

test("release transaction accepts only the ordered phase machine", () => {
  const value = fixture();
  try {
    begin(value);
    assert.throws(() => advanceReleaseTransaction({
      deploymentRoot: value.root,
      expectedPhase: "prepared",
      nextPhase: "qualified",
    }), /release-transaction-transition-invalid/);
    activateLinks(value);
    for (const [expectedPhase, nextPhase] of [
      ["prepared", "links-active"],
      ["links-active", "qualified"],
    ]) {
      assert.equal(advanceReleaseTransaction({
        deploymentRoot: value.root,
        expectedPhase,
        nextPhase,
      }).phase, nextPhase);
    }
    activateState(value);
    for (const [expectedPhase, nextPhase] of [
      ["qualified", "state-active"],
      ["state-active", "complete"],
    ]) {
      assert.equal(advanceReleaseTransaction({
        deploymentRoot: value.root,
        expectedPhase,
        nextPhase,
      }).phase, nextPhase);
    }
    assert.throws(() => advanceReleaseTransaction({
      deploymentRoot: value.root,
      expectedPhase: "state-active",
      nextPhase: "complete",
    }), /release-transaction-phase-mismatch/);
  } finally {
    value.cleanup();
  }
});

test("release recovery rolls back early phases and completes qualified phases", async (t) => {
  for (const phase of ["prepared", "links-active", "qualified", "state-active", "complete"]) {
    await t.test(phase, () => {
      const value = fixture();
      try {
        const transaction = begin(value);
        if (phase !== "prepared") {
          activateLinks(value);
          advanceReleaseTransaction({
            deploymentRoot: value.root,
            expectedPhase: "prepared",
            nextPhase: "links-active",
          });
        }
        if (["qualified", "state-active", "complete"].includes(phase)) {
          advanceReleaseTransaction({
            deploymentRoot: value.root,
            expectedPhase: "links-active",
            nextPhase: "qualified",
          });
        }
        if (["state-active", "complete"].includes(phase)) {
          activateState(value);
          advanceReleaseTransaction({
            deploymentRoot: value.root,
            expectedPhase: "qualified",
            nextPhase: "state-active",
          });
        }
        if (phase === "complete") {
          advanceReleaseTransaction({
            deploymentRoot: value.root,
            expectedPhase: "state-active",
            nextPhase: "complete",
          });
        }

        const result = recoverReleaseTransaction({ deploymentRoot: value.root });
        const completes = ["qualified", "state-active", "complete"].includes(phase);
        assert.equal(result.action, completes ? "complete" : "rollback");
        assert.equal(result.transactionId, transaction.transactionId);
        assert.equal(
          readlinkSync(join(value.root, "current")),
          completes ? value.after.current : value.before.current,
        );
        assert.equal(
          existsSync(join(value.root, "previous")) ? readlinkSync(join(value.root, "previous")) : null,
          completes ? value.after.previous : value.before.previous,
        );
        assert.deepEqual(
          JSON.parse(readFileSync(join(value.root, "deployment.json"), "utf8")),
          completes ? value.after.state : value.before.state,
        );
        assert.equal(existsSync(join(value.root, "releases", "2.0.0-new")), completes);
        assert.equal(existsSync(join(value.root, "candidates", "candidate-new")), !completes);

        completeReleaseTransaction({
          deploymentRoot: value.root,
          transactionId: transaction.transactionId,
        });
        assert.equal(existsSync(join(value.root, "release-transaction")), false);
      } finally {
        value.cleanup();
      }
    });
  }
});

test("release recovery refuses unknown journal fields and unrelated live state", async (t) => {
  await t.test("unknown journal field", () => {
    const value = fixture();
    try {
      begin(value);
      const journalPath = join(value.root, "release-transaction", "journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      writeFileSync(journalPath, `${JSON.stringify({ ...journal, command: "secret" })}\n`, { mode: 0o600 });
      assert.throws(
        () => inspectReleaseTransaction({ deploymentRoot: value.root }),
        /release-transaction-schema-invalid/,
      );
    } finally {
      value.cleanup();
    }
  });

  await t.test("unrelated live state", () => {
    const value = fixture();
    try {
      begin(value);
      rmSync(join(value.root, "current"));
      symlinkSync("releases/unrelated", join(value.root, "current"));
      assert.throws(
        () => recoverReleaseTransaction({ deploymentRoot: value.root }),
        /release-transaction-live-state-unsafe/,
      );
      assert.equal(readlinkSync(join(value.root, "current")), "releases/unrelated");
    } finally {
      value.cleanup();
    }
  });
});
