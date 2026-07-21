import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GondolinPiRpcClient } from "./safe-rpc-client.mjs";
import { INITIAL_SOURCE, TEST_SOURCE } from "./extension.mjs";

const cwd = resolve(new URL(".", import.meta.url).pathname);
const withPolicy = process.argv.includes("--with-policy");
const structured = process.argv.includes("--structured");
const snapshotApply = process.argv.includes("--snapshot-apply");
if (snapshotApply && !structured) throw new Error("snapshot apply e2e requires --structured");
const temporaryRoot = mkdtempSync(join(tmpdir(), "gondolin-agent-policy-"));
const configPath = join(temporaryRoot, "config.json");
const snapshotRoot = join(temporaryRoot, "approved-snapshot");
if (snapshotApply) {
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(snapshotRoot, "normalize.sh"), INITIAL_SOURCE, { mode: 0o700 });
  writeFileSync(join(snapshotRoot, "test.sh"), TEST_SOURCE, { mode: 0o600 });
}
const notifications = [];
const extensionErrors = [];
const toolNames = [];
const toolDetails = [];
let editorPrefill;
let confirmationCount = 0;
let agentStarted = false;
let settledResolve;
let settledReject;
const settled = new Promise((resolvePromise, rejectPromise) => {
  settledResolve = resolvePromise;
  settledReject = rejectPromise;
});
const settleTimer = setTimeout(() => settledReject(new Error("agent-settled-timeout")), 300_000);
const extensionArgs = withPolicy
  ? ["-e", "../../extensions/policy-gate/index.mjs", "-e", "./extension.mjs"]
  : ["-e", "./extension.mjs"];
const client = new GondolinPiRpcClient({
  cwd,
  environment: {
    ...(withPolicy ? { PI_HARNESS_CHALLENGER_CONFIG: configPath } : {}),
    ...(snapshotApply ? {
      PI_GONDOLIN_SNAPSHOT_ROOT: snapshotRoot,
      PI_GONDOLIN_SNAPSHOT_FILES: JSON.stringify(["normalize.sh", "test.sh"]),
    } : {}),
  },
  args: [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", structured ? "read,edit,write,bash" : "bash",
    ...extensionArgs,
  ],
});
client.onEvent((event) => {
  if (event.type === "agent_start") agentStarted = true;
  if (event.type === "agent_settled") settledResolve();
  if (event.type === "extension_error") extensionErrors.push(event);
  if (event.type === "tool_execution_start") toolNames.push(event.toolName);
  if (event.type === "tool_execution_end") toolDetails.push(event.result?.details);
  if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message);
  if (event.type === "extension_ui_request" && event.method === "editor") {
    editorPrefill = event.prefill;
    client.send({ type: "extension_ui_response", id: event.id, value: event.prefill });
  }
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    confirmationCount += 1;
    client.send({ type: "extension_ui_response", id: event.id, confirmed: true });
  }
});

const startedAt = performance.now();
try {
  if (withPolicy) await client.request({ type: "prompt", message: "/policy-gate confirm" }, 30_000);
  if (snapshotApply) {
    await client.request({ type: "prompt", message: "/gondolin-lab-import" }, 60_000);
    const imported = notifications.find((message) => message.startsWith("GONDOLIN_LAB_IMPORT:"));
    assert.deepEqual(JSON.parse(imported.slice("GONDOLIN_LAB_IMPORT:".length)), {
      configured: true,
      approved: true,
      importedFiles: 2,
      importedBytes: Buffer.byteLength(INITIAL_SOURCE) + Buffer.byteLength(TEST_SOURCE),
    });
  }
  await client.request({
    type: "prompt",
    message: structured
      ? "Dans la fixture synthétique /workspace, utilise obligatoirement l’outil read pour lire normalize.sh, puis l’outil edit pour le corriger : retirer les espaces ASCII au début et à la fin, convertir en minuscules, et pour une valeur vide sortir avec le code 2 et stderr exact « empty input ». Utilise ensuite bash uniquement pour exécuter /bin/sh ./test.sh. Ne modifie aucun autre fichier, n’utilise aucune dépendance ni réseau."
      : "Dans la fixture synthétique /workspace, corrige uniquement normalize.sh : retirer les espaces ASCII au début et à la fin, convertir en minuscules, et pour une valeur vide sortir avec le code 2 et stderr exact « empty input ». Lis avant de modifier, n’utilise aucune dépendance ni réseau, puis exécute /bin/sh ./test.sh.",
  }, 300_000);
  await settled;
  clearTimeout(settleTimer);

  await client.request({ type: "prompt", message: "/gondolin-lab-eval" }, 60_000);
  await client.request({ type: "prompt", message: "/gondolin-lab-export" }, 60_000);
  if (snapshotApply) await client.request({ type: "prompt", message: "/gondolin-lab-apply" }, 60_000);
  const evaluation = notifications.find((message) => message.startsWith("GONDOLIN_LAB_EVAL:"));
  const exported = notifications.find((message) => message.startsWith("GONDOLIN_LAB_EXPORT:"));
  assert.ok(evaluation, "missing independent Gondolin evaluation");
  assert.ok(exported, "missing Gondolin export preview result");
  assert.deepEqual(JSON.parse(evaluation.slice("GONDOLIN_LAB_EVAL:".length)), {
    nominal: true,
    empty: true,
  });
  assert.deepEqual(JSON.parse(exported.slice("GONDOLIN_LAB_EXPORT:".length)), {
    reviewed: true,
    changedFiles: 1,
    applyPerformed: false,
  });
  assert.match(editorPrefill, /## normalize\.sh/);
  assert.match(editorPrefill, /Apply performed: false/);
  if (snapshotApply) {
    const applied = notifications.find((message) => message.startsWith("GONDOLIN_LAB_APPLY:"));
    assert.deepEqual(JSON.parse(applied.slice("GONDOLIN_LAB_APPLY:".length)), {
      approved: true,
      appliedFiles: 1,
    });
    assert.notEqual(readFileSync(join(snapshotRoot, "normalize.sh"), "utf8"), INITIAL_SOURCE);
    assert.equal(readFileSync(join(snapshotRoot, "test.sh"), "utf8"), TEST_SOURCE);
    assert.equal(confirmationCount, 2, "snapshot import and host apply must each be confirmed");
  }
  assert.equal(agentStarted, true);
  assert.ok(toolNames.length >= 2, "agent should inspect, modify, and verify through bash");
  if (structured) {
    assert.ok(toolNames.includes("read"), "structured run must use read");
    assert.ok(toolNames.includes("edit"), "structured run must use edit");
    assert.ok(toolNames.includes("bash"), "structured run must verify with bash");
    assert.ok(toolNames.every((name) => ["read", "edit", "write", "bash"].includes(name)));
  } else {
    assert.ok(toolNames.every((name) => name === "bash"));
  }
  assert.equal(toolDetails.filter(Boolean).length, toolNames.length, "every tool result must carry sandbox details");
  assert.ok(toolDetails.filter(Boolean).every((details) => (
    details.sandbox === "gondolin"
      && details.hostMounts === 0
      && details.network === "deny"
  )));
  assert.deepEqual(extensionErrors, []);

  const stats = await client.request({ type: "get_session_stats" });
  process.stdout.write(`${JSON.stringify({
    version: 1,
    backend: "@earendil-works/gondolin@0.12.0",
    modelToolCalls: toolNames.length,
    toolNames: [...new Set(toolNames)],
    sandboxAttestedToolResults: toolDetails.filter(Boolean).length,
    independentEvaluation: { nominal: true, empty: true },
    durationMs: Math.round(performance.now() - startedAt),
    tokens: stats.data?.tokens ?? null,
    modelHostWrites: 0,
    explicitlyApprovedHostWrites: snapshotApply ? 1 : 0,
    hostMounts: 0,
    network: "deny",
    policyMode: withPolicy ? "confirm" : "not-loaded",
    structuredToolsRequired: structured,
    exportPreview: { reviewed: true, changedFiles: 1, applyPerformed: false },
    snapshotWorkflow: snapshotApply ? { importedFiles: 2, confirmations: confirmationCount, appliedFiles: 1 } : null,
    allPass: true,
  }, null, 2)}\n`);
} finally {
  clearTimeout(settleTimer);
  await client.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (client.stderr.trim()) throw new Error(`Unexpected Pi RPC stderr: ${client.stderr.trim()}`);
