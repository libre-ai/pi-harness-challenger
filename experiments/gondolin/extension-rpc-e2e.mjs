import assert from "node:assert/strict";
import { resolve } from "node:path";

import { GondolinPiRpcClient } from "./safe-rpc-client.mjs";

const cwd = resolve(new URL(".", import.meta.url).pathname);
const notifications = [];
const extensionErrors = [];
let editorPrefill;
let agentStarted = false;
const client = new GondolinPiRpcClient({
  cwd,
  environment: { PI_OFFLINE: "1" },
  args: [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "bash",
    "-e", "./extension.mjs",
  ],
});
client.onEvent((event) => {
  if (event.type === "agent_start") agentStarted = true;
  if (event.type === "extension_error") extensionErrors.push(event);
  if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message);
  if (event.type === "extension_ui_request" && event.method === "editor") {
    editorPrefill = event.prefill;
    client.send({ type: "extension_ui_response", id: event.id, value: event.prefill });
  }
});

try {
  const commands = (await client.request({ type: "get_commands" }, 180_000)).data?.commands ?? [];
  assert.ok(commands.some((item) => item.name === "gondolin-lab-status"));
  assert.ok(commands.some((item) => item.name === "gondolin-lab-eval"));
  assert.ok(commands.some((item) => item.name === "gondolin-lab-export"));

  await client.request({ type: "prompt", message: "/gondolin-lab-status" }, 30_000);
  await client.request({ type: "prompt", message: "/gondolin-lab-eval" }, 60_000);
  await client.request({ type: "prompt", message: "/gondolin-lab-export" }, 60_000);
  const status = notifications.find((message) => message.startsWith("GONDOLIN_LAB_STATUS:"));
  const evaluation = notifications.find((message) => message.startsWith("GONDOLIN_LAB_EVAL:"));
  const exported = notifications.find((message) => message.startsWith("GONDOLIN_LAB_EXPORT:"));
  assert.deepEqual(JSON.parse(status.slice("GONDOLIN_LAB_STATUS:".length)), {
    ready: true,
    fatal: false,
    hostMounts: 0,
    network: "deny",
  });
  assert.deepEqual(JSON.parse(evaluation.slice("GONDOLIN_LAB_EVAL:".length)), {
    nominal: false,
    empty: false,
  });
  assert.deepEqual(JSON.parse(exported.slice("GONDOLIN_LAB_EXPORT:".length)), {
    reviewed: true,
    changedFiles: 0,
    applyPerformed: false,
  });
  assert.match(editorPrefill, /Review only/);
  assert.match(editorPrefill, /Apply performed: false/);
  assert.equal(agentStarted, false);
  assert.deepEqual(extensionErrors, []);
  console.log("gondolin extension rpc: ok (guest-only bash, fixture initially failing, no provider)");
} finally {
  await client.close();
}

if (client.stderr.trim()) throw new Error(`Unexpected Pi RPC stderr: ${client.stderr.trim()}`);
