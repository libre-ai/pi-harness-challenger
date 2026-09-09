import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADOPTION_JOURNAL_VERSION,
  advanceRuntimeAdoption,
  beginRuntimeAdoption,
  recoverRuntimeAdoption,
} from "../experiments/gondolin/runtime-adoption.mjs";

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-adoption-"));
  chmodSync(root, 0o700);
  return {
    root,
    cleanup: () => {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function adoptionArtifacts() {
  return {
    controller: { oldSha256: "0".repeat(64), newSha256: "1".repeat(64) },
    pi: { oldSha256: "2".repeat(64), newSha256: "3".repeat(64) },
    "pi-gondolin-rpc": { oldSha256: "4".repeat(64), newSha256: "5".repeat(64) },
    "deployment.json": { oldSha256: "6".repeat(64), newSha256: "7".repeat(64) },
    launchd: { oldSha256: "", newSha256: "8".repeat(64) },
  };
}

test("adoption journal persists an exact private non-PII schema", () => {
  const { root, cleanup } = fixture();
  try {
    const journal = beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts() });
    assert.deepEqual(journal, {
      version: 1,
      phase: "prepared",
      artifacts: adoptionArtifacts(),
    });
    assert.equal(ADOPTION_JOURNAL_VERSION, 1);
    assert.equal(lstatSync(join(root, "adoption")).mode & 0o077, 0);
    assert.equal(lstatSync(join(root, "adoption", "journal.json")).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "adoption", "journal.json"), "utf8")), journal);

    assert.equal(
      advanceRuntimeAdoption({ deploymentRoot: root, expectedPhase: "prepared", nextPhase: "artifacts-installed" }).phase,
      "artifacts-installed",
    );
    assert.throws(
      () => advanceRuntimeAdoption({ deploymentRoot: root, expectedPhase: "prepared", nextPhase: "binding-active" }),
      /adoption-journal-phase-mismatch/,
    );
  } finally {
    cleanup();
  }
});

test("adoption journal recovery deterministically rolls back or completes", async (t) => {
  const cases = [
    ["prepared", "rolled-back", ["restore"]],
    ["artifacts-installed", "completed", ["verify", "finish"]],
    ["binding-active", "completed", ["verify", "finish"]],
    ["launchd-loaded", "completed", ["verify"]],
  ];
  for (const [phase, expected, expectedEvents] of cases) {
    await t.test(phase, async () => {
      const { root, cleanup } = fixture();
      try {
        beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts() });
        const phases = ["artifacts-installed", "binding-active", "launchd-loaded"];
        let current = "prepared";
        for (const next of phases) {
          if (phase === "prepared") break;
          advanceRuntimeAdoption({ deploymentRoot: root, expectedPhase: current, nextPhase: next });
          current = next;
          if (next === phase) break;
        }
        const events = [];
        const result = await recoverRuntimeAdoption({
          deploymentRoot: root,
          verifyInstalled: async () => {
            events.push("verify");
            return true;
          },
          restoreBackups: async () => events.push("restore"),
          finishActivation: async () => events.push("finish"),
        });
        assert.equal(result, expected);
        assert.deepEqual(events, expectedEvents);
        assert.equal(existsSync(join(root, "adoption")), false);
      } finally {
        cleanup();
      }
    });
  }
});

test("adoption journal recovery restores backups when installed artifacts do not verify", async (t) => {
  for (const phase of ["artifacts-installed", "binding-active", "launchd-loaded"]) {
    await t.test(phase, async () => {
      const { root, cleanup } = fixture();
      try {
        beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts() });
        const phases = ["artifacts-installed", "binding-active", "launchd-loaded"];
        let current = "prepared";
        for (const next of phases) {
          advanceRuntimeAdoption({ deploymentRoot: root, expectedPhase: current, nextPhase: next });
          current = next;
          if (next === phase) break;
        }
        const events = [];
        const result = await recoverRuntimeAdoption({
          deploymentRoot: root,
          verifyInstalled: async () => {
            events.push("verify");
            return false;
          },
          restoreBackups: async () => events.push("restore"),
          finishActivation: async () => events.push("finish"),
        });
        assert.equal(result, "rolled-back");
        assert.deepEqual(events, ["verify", "restore"]);
      } finally {
        cleanup();
      }
    });
  }
});

test("adoption journal fails closed before callbacks for unsafe state", async (t) => {
  const cases = [
    ["unknown version", (root) => {
      const journal = { version: 2, phase: "prepared", artifacts: adoptionArtifacts() };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["unknown phase", (root) => {
      const journal = { version: 1, phase: "unknown", artifacts: adoptionArtifacts() };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["invalid digest", (root) => {
      const artifacts = adoptionArtifacts();
      artifacts.pi.newSha256 = "not-a-digest";
      const journal = { version: 1, phase: "prepared", artifacts };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["unexpected artifact", (root) => {
      const artifacts = { ...adoptionArtifacts(), release: { oldSha256: "9".repeat(64), newSha256: "a".repeat(64) } };
      const journal = { version: 1, phase: "prepared", artifacts };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["public journal", (root) => {
      const journal = { version: 1, phase: "prepared", artifacts: adoptionArtifacts() };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o644 });
    }],
    ["symlinked journal", (root) => {
      const target = join(root, "journal-target");
      writeFileSync(target, "{}\n", { mode: 0o600 });
      symlinkSync(target, join(root, "adoption", "journal.json"));
    }],
    ["public adoption directory", (root) => {
      const journal = { version: 1, phase: "prepared", artifacts: adoptionArtifacts() };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      chmodSync(join(root, "adoption"), 0o755);
    }],
    ["symlinked adoption directory", (root) => {
      rmSync(join(root, "adoption"), { recursive: true });
      const target = join(root, "adoption-target");
      mkdirSync(target, { mode: 0o700 });
      const journal = { version: 1, phase: "prepared", artifacts: adoptionArtifacts() };
      writeFileSync(join(target, "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      symlinkSync(target, join(root, "adoption"));
    }],
  ];
  for (const [name, writeJournal] of cases) {
    await t.test(name, async () => {
      const { root, cleanup } = fixture();
      try {
        mkdirSync(join(root, "adoption"), { mode: 0o700 });
        writeJournal(root);
        const events = [];
        await assert.rejects(recoverRuntimeAdoption({
          deploymentRoot: root,
          verifyInstalled: async () => events.push("verify"),
          restoreBackups: async () => events.push("restore"),
          finishActivation: async () => events.push("finish"),
        }), /adoption-journal-/);
        assert.deepEqual(events, []);
      } finally {
        cleanup();
      }
    });
  }
});
