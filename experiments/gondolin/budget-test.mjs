import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createToolBudget, MAX_MODEL_TOOL_CALLS } from "./extension.mjs";

const budget = createToolBudget();
for (let index = 1; index <= MAX_MODEL_TOOL_CALLS; index += 1) {
  assert.deepEqual(budget.consume(), { used: index, remaining: MAX_MODEL_TOOL_CALLS - index });
}
assert.throws(() => budget.consume(), /gondolin-tool-budget-exhausted/);
assert.deepEqual(budget.status(), { used: MAX_MODEL_TOOL_CALLS, remaining: 0, limit: MAX_MODEL_TOOL_CALLS });
assert.throws(() => createToolBudget(0), /gondolin-tool-budget-invalid/);
assert.throws(() => createToolBudget(MAX_MODEL_TOOL_CALLS + 1), /gondolin-tool-budget-invalid/);

const root = mkdtempSync(join(tmpdir(), "gondolin-session-budget-"));
const snapshotRoot = join(root, "snapshot");
mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
writeFileSync(join(snapshotRoot, "README.md"), "budget fixture\n", { mode: 0o600 });
const launcher = join(homedir(), ".local", "bin", "pi-gondolin-rpc");

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launcher, [], {
      env: {
        ...process.env,
        PI_GONDOLIN_SNAPSHOT_ROOT: snapshotRoot,
        PI_GONDOLIN_SNAPSHOT_FILES: JSON.stringify(["README.md"]),
        PI_GONDOLIN_SESSION_BUDGET_MS: "250",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 124);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.ok(events.some((event) => event.type === "gondolin_rpc_gate_error"
    && event.fatal === true
    && event.error === "session-time-budget-exceeded"));
  console.log(`gondolin budgets: ok (${MAX_MODEL_TOOL_CALLS} tools, 100k prompt, 10m session cap)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
