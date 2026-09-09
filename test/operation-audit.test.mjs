import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditStatus,
  beginAuditOperation,
  completeAuditOperation,
  inspectAuditOperation,
  pruneCompletedAuditOperations,
} from "../experiments/gondolin/operation-audit.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-operation-audit-"));
  chmodSync(root, 0o700);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("audit operation persists exact immutable private records", () => {
  const { root, cleanup } = fixture();
  try {
    const started = beginAuditOperation({
      deploymentRoot: root,
      action: "release-update",
      trigger: "manual",
      targetId: "2.0.0-new",
      startedAt: "2026-09-09T10:00:00.000Z",
    });
    assert.equal(started.auditComplete, false);
    const operationRoot = join(root, "audit", "operations", started.operationId);
    assert.equal(lstatSync(operationRoot).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(operationRoot, "started.json")).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(operationRoot, "started.json"), "utf8")), {
      version: 1,
      operationId: started.operationId,
      action: "release-update",
      trigger: "manual",
      targetId: "2.0.0-new",
      startedAt: "2026-09-09T10:00:00.000Z",
    });
    assert.deepEqual(inspectAuditOperation({ deploymentRoot: root, operationId: started.operationId }), {
      operationId: started.operationId,
      action: "release-update",
      trigger: "manual",
      targetId: "2.0.0-new",
      complete: false,
      outcome: null,
      errorCode: null,
    });
    const completed = completeAuditOperation({
      deploymentRoot: root,
      operationId: started.operationId,
      outcome: "succeeded",
      errorCode: null,
      completedAt: "2026-09-09T10:00:01.000Z",
    });
    assert.deepEqual(completed, { operationId: started.operationId, auditComplete: true });
    assert.equal(lstatSync(join(operationRoot, "result.json")).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(operationRoot, "result.json"), "utf8")), {
      version: 1,
      operationId: started.operationId,
      outcome: "succeeded",
      errorCode: null,
      completedAt: "2026-09-09T10:00:01.000Z",
    });
    assert.deepEqual(
      completeAuditOperation({
        deploymentRoot: root,
        operationId: started.operationId,
        outcome: "succeeded",
        errorCode: null,
      }),
      { operationId: started.operationId, auditComplete: true },
    );
  } finally {
    cleanup();
  }
});

test("audit validation rejects enums, PII-shaped fields, and conflicting completion", async (t) => {
  const cases = [
    ["unknown action", { action: "shell-command", trigger: "manual", targetId: null }],
    ["unknown trigger", { action: "release-update", trigger: "cron", targetId: null }],
    ["path target", { action: "release-update", trigger: "manual", targetId: "/Users/alice/project" }],
    ["extra field", { action: "release-update", trigger: "manual", targetId: null, command: "pi update" }],
  ];
  for (const [name, input] of cases) {
    await t.test(name, () => {
      const { root, cleanup } = fixture();
      try {
        assert.throws(() => beginAuditOperation({ deploymentRoot: root, ...input }), /audit-/);
      } finally {
        cleanup();
      }
    });
  }

  await t.test("conflicting completion", () => {
    const { root, cleanup } = fixture();
    try {
      const started = beginAuditOperation({
        deploymentRoot: root,
        action: "release-rollback",
        trigger: "recovery",
        targetId: "1.0.0-old",
      });
      completeAuditOperation({
        deploymentRoot: root,
        operationId: started.operationId,
        outcome: "recovered",
        errorCode: null,
      });
      assert.throws(() => completeAuditOperation({
        deploymentRoot: root,
        operationId: started.operationId,
        outcome: "refused",
        errorCode: "different-result",
      }), /audit-result-conflict/);
    } finally {
      cleanup();
    }
  });
});

test("audit status exposes incomplete evidence without inventing success", () => {
  const { root, cleanup } = fixture();
  try {
    const incomplete = beginAuditOperation({
      deploymentRoot: root,
      action: "runtime-repin",
      trigger: "automatic",
      targetId: null,
    });
    const complete = beginAuditOperation({
      deploymentRoot: root,
      action: "automation-enable",
      trigger: "manual",
      targetId: null,
    });
    completeAuditOperation({
      deploymentRoot: root,
      operationId: complete.operationId,
      outcome: "succeeded",
      errorCode: null,
    });
    assert.deepEqual(auditStatus({ deploymentRoot: root }), {
      completed: 1,
      incomplete: 1,
      incompleteOperationIds: [incomplete.operationId],
    });
  } finally {
    cleanup();
  }
});

test("audit readers fail closed on unsafe durable evidence", async (t) => {
  const cases = [
    ["public operation directory", (operationRoot) => chmodSync(operationRoot, 0o755), /audit-operation-directory-unsafe/],
    ["public started record", (operationRoot) => chmodSync(join(operationRoot, "started.json"), 0o644), /audit-file-unsafe/],
    ["invalid started JSON", (operationRoot) => writeFileSync(join(operationRoot, "started.json"), "{\n", { mode: 0o600 }), /audit-started-json-invalid/],
    ["unexpected file", (operationRoot) => writeFileSync(join(operationRoot, "extra"), "value\n", { mode: 0o600 }), /audit-operation-content-invalid/],
  ];
  for (const [name, corrupt, expected] of cases) {
    await t.test(name, () => {
      const { root, cleanup } = fixture();
      try {
        const operation = beginAuditOperation({
          deploymentRoot: root,
          action: "runtime-repin",
          trigger: "manual",
          targetId: null,
        });
        corrupt(join(root, "audit", "operations", operation.operationId));
        assert.throws(() => auditStatus({ deploymentRoot: root }), expected);
      } finally {
        cleanup();
      }
    });
  }

  await t.test("no audit directory", () => {
    const { root, cleanup } = fixture();
    try {
      assert.deepEqual(auditStatus({ deploymentRoot: root }), {
        completed: 0,
        incomplete: 0,
        incompleteOperationIds: [],
      });
    } finally {
      cleanup();
    }
  });
});

test("an audit result persistence failure preserves incomplete evidence", () => {
  const { root, cleanup } = fixture();
  const moduleUrl = new URL("../experiments/gondolin/operation-audit.mjs", import.meta.url).href;
  const childSource = `
    import fs from "node:fs";
    import { basename } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const audit = await import(${JSON.stringify(moduleUrl)});
    const started = audit.beginAuditOperation({
      deploymentRoot: process.argv[1],
      action: "release-update",
      trigger: "manual",
      targetId: "2.0.0-new",
    });
    const originalOpen = fs.openSync;
    fs.openSync = (path, ...args) => {
      if (basename(path).startsWith(".result-")) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return originalOpen(path, ...args);
    };
    syncBuiltinESMExports();
    const result = audit.completeAuditOperation({
      deploymentRoot: process.argv[1],
      operationId: started.operationId,
      outcome: "succeeded",
      errorCode: null,
    });
    process.stdout.write(JSON.stringify({ result, status: audit.auditStatus({ deploymentRoot: process.argv[1] }) }));
  `;
  try {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", childSource, root],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const evidence = JSON.parse(child.stdout);
    assert.equal(evidence.result.auditComplete, false);
    assert.equal(evidence.status.completed, 0);
    assert.equal(evidence.status.incomplete, 1);
  } finally {
    cleanup();
  }
});

test("audit retention keeps 256 completed records and every incomplete record", () => {
  const { root, cleanup } = fixture();
  try {
    const incomplete = beginAuditOperation({
      deploymentRoot: root,
      action: "runtime-adoption",
      trigger: "recovery",
      targetId: null,
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    for (let index = 0; index < 257; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 8, 9, 1, 0, index)).toISOString();
      const operation = beginAuditOperation({
        deploymentRoot: root,
        action: "release-update",
        trigger: "automatic",
        targetId: `release-${index}`,
        startedAt: timestamp,
      });
      completeAuditOperation({
        deploymentRoot: root,
        operationId: operation.operationId,
        outcome: "succeeded",
        errorCode: null,
        completedAt: timestamp,
      });
    }
    assert.equal(pruneCompletedAuditOperations({ deploymentRoot: root }), 1);
    assert.deepEqual(auditStatus({ deploymentRoot: root }), {
      completed: 256,
      incomplete: 1,
      incompleteOperationIds: [incomplete.operationId],
    });
    assert.equal(existsSync(join(root, "audit", "operations", incomplete.operationId)), true);
    assert.equal(readdirSync(join(root, "audit", "operations")).length, 257);
  } finally {
    cleanup();
  }
});
