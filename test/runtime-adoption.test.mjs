import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  inspectRuntimeAdoption,
  recoverRuntimeAdoption,
  removeAbandonedAdoptionPreparations,
} from "../experiments/gondolin/runtime-adoption.mjs";

const TEST_OPERATION_ID = "11111111-1111-4111-8111-111111111111";

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
    const journal = beginRuntimeAdoption({
      deploymentRoot: root,
      artifacts: adoptionArtifacts(),
      operationId: TEST_OPERATION_ID,
    });
    assert.deepEqual(journal, {
      version: 2,
      phase: "prepared",
      artifacts: adoptionArtifacts(),
      operationId: TEST_OPERATION_ID,
    });
    assert.equal(ADOPTION_JOURNAL_VERSION, 2);
    assert.equal(lstatSync(join(root, "adoption")).mode & 0o077, 0);
    assert.equal(lstatSync(join(root, "adoption", "journal.json")).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "adoption", "journal.json"), "utf8")), journal);
    assert.deepEqual(inspectRuntimeAdoption({ deploymentRoot: root }), journal);

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

test("adoption inspection accepts legacy version 1 only as recovery input", () => {
  const { root, cleanup } = fixture();
  try {
    assert.equal(inspectRuntimeAdoption({ deploymentRoot: root }), null);
    mkdirSync(join(root, "adoption"), { mode: 0o700 });
    const legacyJournal = { version: 1, phase: "prepared", artifacts: adoptionArtifacts() };
    writeFileSync(
      join(root, "adoption", "journal.json"),
      `${JSON.stringify(legacyJournal)}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(inspectRuntimeAdoption({ deploymentRoot: root }), legacyJournal);
    assert.throws(
      () => beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts(), operationId: "invalid" }),
      /adoption-journal-operation-id-invalid/,
    );
  } finally {
    cleanup();
  }
});

test("a crash immediately before publication never exposes an empty adoption journal", () => {
  const { root, cleanup } = fixture();
  const moduleUrl = new URL("../experiments/gondolin/runtime-adoption.mjs", import.meta.url).href;
  const childSource = `
    import fs from "node:fs";
    import { basename } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (basename(destination) === "adoption") process.exit(0);
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();
    const { beginRuntimeAdoption } = await import(${JSON.stringify(moduleUrl)});
    beginRuntimeAdoption({
      deploymentRoot: process.argv[1],
      artifacts: ${JSON.stringify(adoptionArtifacts())},
      operationId: ${JSON.stringify(TEST_OPERATION_ID)},
    });
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", childSource, root],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(join(root, "adoption")), false);
    const preparations = readdirSync(root).filter((name) => name.startsWith(".adoption-prepare-"));
    assert.equal(preparations.length, 1);
    const preparationRoot = join(root, preparations[0]);
    assert.equal(lstatSync(preparationRoot).mode & 0o077, 0);
    assert.equal(lstatSync(join(preparationRoot, "journal.json")).mode & 0o077, 0);
    assert.equal(removeAbandonedAdoptionPreparations({ deploymentRoot: root }), 1);
    assert.equal(readdirSync(root).some((name) => name.startsWith(".adoption-prepare-")), false);
  } finally {
    cleanup();
  }
});

test("abandoned adoption cleanup refuses every unverified preparation", async (t) => {
  const cases = [
    ["invalid name", (root) => {
      mkdirSync(join(root, ".adoption-prepare-not-a-uuid"), { mode: 0o700 });
    }, /adoption-preparation-name-invalid/],
    ["symlink", (root) => {
      const target = join(root, "preparation-target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, join(root, ".adoption-prepare-11111111-1111-4111-8111-111111111111"));
    }, /adoption-preparation-directory-unsafe/],
    ["unexpected content", (root) => {
      const preparation = join(root, ".adoption-prepare-11111111-1111-4111-8111-111111111111");
      mkdirSync(preparation, { mode: 0o700 });
      writeFileSync(join(preparation, "unexpected"), "value\n", { mode: 0o600 });
    }, /adoption-preparation-content-invalid/],
  ];

  for (const [name, prepare, expected] of cases) {
    await t.test(name, () => {
      const { root, cleanup } = fixture();
      try {
        prepare(root);
        assert.throws(() => removeAbandonedAdoptionPreparations({ deploymentRoot: root }), expected);
        assert.equal(readdirSync(root).some((entry) => entry.startsWith(".adoption-prepare-")), true);
      } finally {
        cleanup();
      }
    });
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
        beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts(), operationId: TEST_OPERATION_ID });
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
        beginRuntimeAdoption({ deploymentRoot: root, artifacts: adoptionArtifacts(), operationId: TEST_OPERATION_ID });
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
      const journal = { version: 3, phase: "prepared", artifacts: adoptionArtifacts(), operationId: TEST_OPERATION_ID };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["unknown phase", (root) => {
      const journal = { version: 1, phase: "unknown", artifacts: adoptionArtifacts() };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["invalid operation id", (root) => {
      const journal = { version: 2, phase: "prepared", artifacts: adoptionArtifacts(), operationId: "invalid" };
      writeFileSync(join(root, "adoption", "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    }],
    ["invalid JSON", (root) => {
      writeFileSync(join(root, "adoption", "journal.json"), "{\n", { mode: 0o600 });
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
