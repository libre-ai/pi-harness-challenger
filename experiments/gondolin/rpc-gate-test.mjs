import assert from "node:assert/strict";

import {
  MAX_PROMPT_CHARS,
  MAX_RPC_LINE_BYTES,
  MAX_SESSION_DURATION_MS,
  MIN_SESSION_DURATION_MS,
  boundedSessionDuration,
  inspectRpcMessage,
  parseAndInspectRpcLine,
  refusalResponse,
} from "./rpc-gate.mjs";

assert.equal(MAX_PROMPT_CHARS, 100_000);
assert.equal(MAX_SESSION_DURATION_MS, 600_000);
assert.equal(boundedSessionDuration(undefined), MAX_SESSION_DURATION_MS);
assert.equal(boundedSessionDuration(MIN_SESSION_DURATION_MS), MIN_SESSION_DURATION_MS);
assert.equal(boundedSessionDuration(MAX_SESSION_DURATION_MS + 1), MAX_SESSION_DURATION_MS);
assert.equal(boundedSessionDuration("invalid"), MAX_SESSION_DURATION_MS);

for (const message of [
  { type: "prompt", id: "p-1", message: "Inspect the approved snapshot" },
  { type: "prompt", id: "p-2", message: "/gondolin-lab-import" },
  { type: "prompt", id: "p-3", message: "/gondolin-lab-apply" },
  { type: "prompt", id: "p-3b", message: "/gondolin-lab-project-eval" },
  { type: "prompt", id: "p-4", message: "/policy-gate confirm" },
  { type: "prompt", id: "p-5", message: "/policy-gate enforce" },
  { type: "get_commands", id: "g-1" },
  { type: "extension_ui_response", id: "ui-1", confirmed: true },
  { type: "extension_ui_response", id: "ui-2", value: "reviewed" },
]) {
  assert.equal(inspectRpcMessage(message).allowed, true, JSON.stringify(message));
}

for (const message of [
  { type: "bash", id: "x-1", command: "touch host" },
  { type: "abort_bash", id: "x-2" },
  { type: "export_html", id: "x-3", outputPath: "/tmp/out" },
  { type: "switch_session", id: "x-4", sessionPath: "/tmp/session" },
  { type: "prompt", id: "x-5", message: "!touch host" },
  { type: "prompt", id: "x-6", message: "/export /tmp/out" },
  { type: "prompt", id: "x-7", message: "/policy-gate observe" },
  { type: "prompt", id: "x-8", message: "/policy-gate confirm extra" },
  { type: "prompt", id: "x-9", message: "/gondolin-lab-import extra" },
  { type: "prompt", id: "x-10", message: "x".repeat(MAX_PROMPT_CHARS + 1) },
  { type: "extension_ui_response", id: "ui-3" },
  { type: "unknown", id: "x-11" },
]) {
  assert.equal(inspectRpcMessage(message).allowed, false, JSON.stringify(message).slice(0, 200));
}

const parsed = parseAndInspectRpcLine(Buffer.from(JSON.stringify({
  type: "prompt",
  id: "normalized-1",
  message: "safe",
  outputPath: "/must/not/pass",
})));
assert.deepEqual(parsed.message, { type: "prompt", id: "normalized-1", message: "safe" });
assert.throws(() => parseAndInspectRpcLine(Buffer.from("not-json")), /json-invalid/);
assert.throws(() => parseAndInspectRpcLine(Buffer.alloc(MAX_RPC_LINE_BYTES + 1, 65)), /line-invalid/);
assert.deepEqual(refusalResponse({ id: "blocked-1", command: "secret" }), {
  type: "response",
  id: "blocked-1",
  command: "blocked",
  success: false,
  error: "gondolin-rpc-command-refused",
});
console.log("gondolin RPC gate: ok (allowlist, normalization, slash policy, size and JSON guards)");
