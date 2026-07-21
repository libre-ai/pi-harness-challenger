import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PiRpcClient } from "./lib/pi-rpc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-handoff-e2e-"));
const workspace = join(temporaryRoot, "workspace");
const sessionDir = join(temporaryRoot, "sessions");
mkdirSync(workspace);
mkdirSync(sessionDir);
const sourceFixture = join(sessionDir, "source.jsonl");
const timestamp = new Date().toISOString();
writeFileSync(sourceFixture, [
  JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp, cwd: workspace }),
  JSON.stringify({
    type: "message",
    id: "a1b2c3d4",
    parentId: null,
    timestamp,
    message: { role: "user", content: "Contexte fixture local", timestamp: Date.now() },
  }),
].join("\n") + "\n", { mode: 0o600 });

const extensionErrors = [];
let agentStarted = false;
let editorPrefill;
let resolveChildEditor;
let resolveChildHeader;
const childEditorPromise = new Promise((resolveEditor) => { resolveChildEditor = resolveEditor; });
const childHeaderPromise = new Promise((resolveHeader) => { resolveChildHeader = resolveHeader; });

const client = new PiRpcClient({
  cwd: workspace,
  environment: { PI_OFFLINE: "1" },
  args: [
    "--mode", "rpc",
    "--offline",
    "--session-dir", sessionDir,
    "--session", sourceFixture,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e", join(root, "extensions", "handoff", "index.mjs"),
    "-e", join(root, "test", "fixtures", "session-inspector.mjs"),
  ],
});

client.onEvent((event) => {
  if (event.type === "extension_error") extensionErrors.push(event);
  if (event.type === "agent_start") agentStarted = true;
  if (event.type !== "extension_ui_request") return;

  if (event.method === "editor") {
    editorPrefill = event.prefill;
    client.send({
      type: "extension_ui_response",
      id: event.id,
      value: `${event.prefill}\n\nValidation RPC`,
    });
  }
  if (event.method === "set_editor_text") resolveChildEditor(event.text);
  if (event.method === "notify" && event.message?.startsWith("RPC_SESSION_HEADER:")) {
    resolveChildHeader(JSON.parse(event.message.slice("RPC_SESSION_HEADER:".length)));
  }
});

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function withTimeout(promise, label, timeoutMs = 5_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}


let stderr;
try {
  const sourceState = await client.request({ type: "get_state" });
  const sourceSession = sourceState.data?.sessionFile;
  assert.ok(sourceSession, "source session must be persisted");
  assert.equal(sourceSession, sourceFixture);
  const sourceHashBefore = hashFile(sourceSession);

  await client.request({
    type: "prompt",
    message: "/handoff Continuer le scénario RPC",
  });
  const childEditorText = await withTimeout(childEditorPromise, "child editor event");
  const childState = await client.request({ type: "get_state" });
  const childSession = childState.data?.sessionFile;
  assert.ok(childSession, "child session path must be allocated");
  assert.notEqual(childSession, sourceSession);

  await client.request({ type: "prompt", message: "/inspect-session-header" });
  const childHeader = await withTimeout(childHeaderPromise, "child header event");
  const childEntries = await client.request({ type: "get_entries" });

  assert.equal(hashFile(sourceSession), sourceHashBefore, "source session must stay byte-identical");
  assert.match(editorPrefill, /Continuer le scénario RPC/);
  assert.match(childEditorText, /Validation RPC/);
  assert.equal(agentStarted, false, "handoff must not call a provider");
  assert.deepEqual(extensionErrors, []);
  assert.equal(childHeader.type, "session");
  assert.equal(childHeader.parentSession, sourceSession);
  assert.ok(childEntries.data.entries.some((entry) => entry.type === "session_info" && entry.name === "Handoff — Continuer le scénario RPC"));

  console.log("handoff rpc e2e: ok (parent, source immuable, editor, no provider)");
} finally {
  await client.close();
  stderr = client.stderr.trim();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (stderr) throw new Error(`Unexpected Pi RPC stderr: ${stderr}`);
